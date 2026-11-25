// M14 · 工作区外壳：路由 + 主页转盘 + 文献库 + 阅读器 + 全局搜索 + 设置。
//
// 遗留项处理：「事件 + 拉取」双保险——app://ready 只在页面加载瞬间发一次，容易早于订阅，
// 因此这里先拉 ping/app_info，再订阅事件作为后续通知来源（不再依赖单一事件判断就绪）。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { CMD } from "../contracts/cmd";
import { EVT } from "../contracts/evt";
import type { DocumentDto, LibraryRootDto, ReadMode, TextState } from "../contracts/types";
import { call, subscribe } from "../core/ipc";
import { ReaderView, type ReaderApi } from "../reader/ReaderView";
import { searchPages, type DocSearchHit } from "../reader/search/doc-search";
import { useTheme } from "../theme/ThemeProvider";
import type { ThemeName } from "../theme/tokens";
import { HomeSpace, spineColorFor, type HomeBook } from "./HomeSpace";
import { rootLabel } from "./library-roots";
import { PAGE_TONE_OPTIONS, THEME_SOURCE_OPTIONS } from "../theme/theme-prefs";
import { KEYMAP, keymapEntryCount } from "../settings/keymap";
import {
  DEFAULT_MODE_OPTIONS,
  DEFAULT_SCALE_OPTIONS,
  READER_DEFAULT_MODE_KEY,
  READER_DEFAULT_SCALE_KEY,
  formatScaleOption,
  parseDefaultMode,
  parseDefaultScale,
} from "../settings/reader-prefs";
import { RootRemoveDialog, RootRenameDialog, RootReplaceDialog } from "./LibraryDialogs";
import { LAST_READ_SETTING_KEY, parseLastDocumentId, pickLastRead, type LastReadDoc } from "./last-read";
import { LastReadCard } from "./LastReadCard";
import { LibraryTree } from "./LibraryTree";
import { buildForest, flattenFolders, inFolder, type FolderDoc, type TreeRow } from "./library-tree";
import { useAppStore } from "./router";
import { displayTitle } from "./title-clean";

/// 索引状态文案（docs/16 §3 的用词：无文本 / 索引失败 / 正在建立索引）。
/// 之前直接渲染 TextState 的英文枚举值，属于把内部状态泄漏到界面上。
const TEXT_STATE_TEXT: Record<TextState, string> = {
  pending: "待索引",
  indexing: "索引中",
  indexed: "已索引",
  no_text: "无文本（扫描版）",
  failed: "索引失败",
};

/// 全库书籍分页拉取：后端 document_list 的 MAX_LIMIT 就是 200，这里跟着走。
const ALL_DOCS_PAGE = 200;
/// 文件夹树的数据上限。超过这个量级该换成后端聚合，而不是往 DOM 里塞两万行。
const ALL_DOCS_MAX = 2000;
/// 单屏列表渲染上限：几千行 DOM 会拖慢滚动，超出部分提示用文件夹/过滤词收窄。
const LIBRARY_LIST_CAP = 500;
/// 系统文件夹选择窗口的等待上限：用户在窗口里挑多久都要等（IPC 默认 15s 会直接判超时）。
const PICK_FOLDER_TIMEOUT_MS = 300_000;
/// 同步扫描（library_scan_now）要扫完才返回，大库可能扫很久。
const SCAN_TIMEOUT_MS = 120_000;

function toHomeBook(doc: DocumentDto): HomeBook {
  return {
    documentId: doc.id,
    fileName: doc.fileName,
    // 需求 3：文件名只做显示层清洗，pdf 元数据标题是有意义信息，不清洗。
    title: displayTitle(doc.pdfTitle, doc.fileName),
    author: doc.pdfAuthor,
    spineColor: spineColorFor(doc.id),
    pageCount: doc.pageCount,
    progressPage: doc.progressPage,
  };
}

export function AppShell(): ReactElement {
  const { route, activeDocumentId, readerStartPage, readerOpenCount, globalSearchOpen, openRoute, openDocument, closeDocument } = useAppStore();
  const {
    theme,
    setTheme,
    paperVeil,
    setPaperVeil,
    themeSource,
    setThemeSource,
    pageTone,
    setPageTone,
  } = useTheme();
  const [documents, setDocuments] = useState<DocumentDto[]>([]);
  /// 库根列表：文献库的「更改 / 替换 / 移除」都作用在这一层（R22 / R23）。
  const [roots, setRoots] = useState<LibraryRootDto[]>([]);
  const [rootDialog, setRootDialog] = useState<{ kind: "rename" | "replace" | "remove"; root: LibraryRootDto } | null>(null);
  const [status, setStatus] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<{ documentId: number; title: string; hits: DocSearchHit[] }[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState("");
  const [indexing, setIndexing] = useState<{ done: number; total: number } | null>(null);
  /// 文献库过滤词：走后端 document_list（按文件名/标题 LIKE），不是前端假过滤。
  const [filter, setFilter] = useState("");
  const [filterTotal, setFilterTotal] = useState<number | null>(null);
  const filterRef = useRef("");
  /// 阅读默认值（设置项 reader.defaultMode / reader.defaultScale）。
  const [defaultMode, setDefaultMode] = useState<ReadMode>("continuous");
  const [defaultScale, setDefaultScale] = useState(1);
  /// 全库书籍：文件夹树需要完整数据集，不能用「最近 100 本」那份。
  const [allDocs, setAllDocs] = useState<DocumentDto[]>([]);
  /// 文件夹树展开状态（key 见 library-tree.folderKey）。
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(new Set());
  /// 当前选中的文件夹；null = 全部文献。
  const [selectedFolder, setSelectedFolder] = useState<{ rootId: number; path: string } | null>(null);
  /// 启动续读只做一次，避免 refresh 引起的重渲染反复跳进阅读器。
  const resumeTriedRef = useRef(false);


  /// 拉文献列表：有过滤词就走 document_list（后端按 file_name/pdf_title 做 LIKE），
  /// 否则走 document_recent（主页转盘也吃这份数据）。
  const loadDocuments = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      setFilterTotal(null);
      setDocuments(await call(CMD.DOCUMENT_RECENT, { limit: 100 }));
      return;
    }
    const page = await call(CMD.DOCUMENT_LIST, {
      query: { text: trimmed, sort: "recent", order: "desc", offset: 0, limit: 200 },
    });
    setDocuments(page.items);
    setFilterTotal(page.total);
  }, []);

  /// 分页拿全库书籍（文件夹树的数据源）。失败不阻塞其它加载：保留上一次的结果。
  const loadAllDocuments = useCallback(async () => {
    const acc: DocumentDto[] = [];
    for (let offset = 0; offset < ALL_DOCS_MAX; offset += ALL_DOCS_PAGE) {
      const page = await call(CMD.DOCUMENT_LIST, {
        query: { sort: "name", order: "asc", offset, limit: ALL_DOCS_PAGE },
      });
      acc.push(...page.items);
      if (page.items.length === 0 || acc.length >= page.total) break;
    }
    setAllDocs(acc);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [, rootList] = await Promise.all([
        loadDocuments(filterRef.current),
        call(CMD.LIBRARY_ROOT_LIST, {}),
        loadAllDocuments(),
      ]);
      setRoots(rootList);
    } catch (err) {
      const e = err as { code?: string };
      setStatus("读取文献库失败：" + (e.code ?? "E_INTERNAL"));
    }
  }, [loadAllDocuments, loadDocuments]);

  // 过滤词变化 → 250ms 防抖后重新查询（每敲一个字符都查一次会把索引打满）。
  useEffect(() => {
    filterRef.current = filter;
    const timer = window.setTimeout(() => {
      void loadDocuments(filter).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [filter, loadDocuments]);

  // 就绪：拉取 + 订阅（双保险）
  useEffect(() => {
    void (async () => {
      try {
        await call(CMD.PING, {});
        setReady(true);
        await refresh();
      } catch (err) {
        const e = err as { code?: string; detail?: string };
        setStatus("后端不可用：" + (e.code ?? "E_INTERNAL"));
      }
    })();
    const disposers: (() => void)[] = [];
    void subscribe(EVT.LIBRARY_CHANGED, () => {
      void refresh();
    }).then((fn) => disposers.push(fn));
    // 索引进度：事件只是一次「有进展」的提醒，最终数值仍以 index_status 为准（事件+拉取双保险）。
    void subscribe(EVT.INDEX_PROGRESS, (payload) => {
      const p = payload as { done?: number; total?: number; queued?: number } | null;
      if (typeof p?.done === "number" && typeof p?.total === "number") {
        setIndexing({ done: p.done, total: p.total });
      }
    }).then((fn) => disposers.push(fn));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [refresh]);

  // 阅读默认值：进应用时读一次（设置页展示）；写入走 settings_set。
  useEffect(() => {
    void (async () => {
      try {
        const all = await call(CMD.SETTINGS_GET_ALL, {});
        const mode = parseDefaultMode(all[READER_DEFAULT_MODE_KEY]);
        if (mode !== null) setDefaultMode(mode);
        const scale = parseDefaultScale(all[READER_DEFAULT_SCALE_KEY]);
        if (scale !== null) setDefaultScale(scale);
      } catch {
        // 设置读失败不阻塞界面，保持默认值。
      }
    })();
  }, []);

  const persistSetting = useCallback((key: string, value: string) => {
    void call(CMD.SETTINGS_SET, { key, value }).catch(() => undefined);
  }, []);

  // 需求 5：打开书就记住它；从阅读器退回主页就忘掉它。
  // 于是「退出应用时正在读书」== 设置仍在 == 下次启动直接回到那本书。
  const openBook = useCallback(
    (documentId: number, pageNo?: number) => {
      openDocument(documentId, pageNo);
      persistSetting(LAST_READ_SETTING_KEY, String(documentId));
    },
    [openDocument, persistSetting],
  );

  const leaveReader = useCallback(() => {
    closeDocument();
    persistSetting(LAST_READ_SETTING_KEY, "");
  }, [closeDocument, persistSetting]);

  // 启动续读（需求 5）：设置里还留着 reader.lastDocumentId，说明上次是「正在读书」退出的。
  // 书的记录可能已被移除，所以先用 document_get 探一次；任何失败都留在主页，不阻塞启动。
  useEffect(() => {
    if (!ready || resumeTriedRef.current) return;
    resumeTriedRef.current = true;
    void (async () => {
      try {
        const all = await call(CMD.SETTINGS_GET_ALL, {});
        const id = parseLastDocumentId(all[LAST_READ_SETTING_KEY]);
        if (id === null) return;
        await call(CMD.DOCUMENT_GET, { id });
        openBook(id);
      } catch {
        // 续读是锦上添花，失败不提示。
      }
    })();
  }, [ready, openBook]);

  // 右键不再弹 WebView 自带的菜单（重新加载/另存为/检查——那是调试菜单，不是桌面应用的菜单）。
  // 阅读器会把它换成自己的功能面板（见 ReaderView 的 contextmenu 处理）；
  // 其余页面只是不再露出原生菜单。输入框/文本域保留系统菜单，否则粘贴没法用。
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select") !== null) return;
      event.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Ctrl+K 全局搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useAppStore.getState().setGlobalSearchOpen(!useAppStore.getState().globalSearchOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const runGlobalSearch = useCallback(async (query: string) => {
    if (query.trim().length < 2) {
      setSearchHits([]);
      return;
    }
    try {
      const result = await call(CMD.SEARCH_GLOBAL, {
        params: { query, mode: "phrase", hitsPerDocument: 3, documentOffset: 0, documentLimit: 20 },
      });
      setSearchHits(
        result.items.map((item) => ({
          documentId: item.document.id,
          title: item.document.pdfTitle ?? item.document.fileName,
          hits: item.hits.map((h) => ({ pageNo: h.pageNo, ranges: h.ranges, snippet: h.snippet })),
        })),
      );
    } catch (err) {
      const e = err as { code?: string };
      setStatus("搜索失败：" + (e.code ?? "E_INTERNAL"));
      setSearchHits([]);
    }
  }, []);

  const books = useMemo(() => documents.map(toHomeBook), [documents]);

  // ── 文献库文件夹层级（需求 2）──
  // allDocs 是树的数据源；万一分页拉取失败就退回列表那份，至少还能用。
  const libraryDocs = useMemo(() => (allDocs.length > 0 ? allDocs : documents), [allDocs, documents]);
  const folderDocsInput: FolderDoc[] = useMemo(
    () => libraryDocs.map((doc) => ({ documentId: doc.id, libraryRootId: doc.libraryRootId, relPath: doc.relPath })),
    [libraryDocs],
  );
  const forest = useMemo(
    () => buildForest(roots.map((root) => ({ id: root.id, label: rootLabel(root) })), folderDocsInput),
    [roots, folderDocsInput],
  );
  const treeRows = useMemo(() => flattenFolders(forest, expandedFolders), [forest, expandedFolders]);

  // 列表数据：有过滤词时用后端命中结果（不是前端假过滤），再按当前文件夹收窄。
  const scopedDocs = useMemo(() => {
    const source = filter.trim().length > 0 ? documents : libraryDocs;
    if (selectedFolder === null) return source;
    return source.filter(
      (doc) => doc.libraryRootId === selectedFolder.rootId && inFolder(doc.relPath, selectedFolder.path),
    );
  }, [documents, filter, libraryDocs, selectedFolder]);

  const visibleDocs = scopedDocs.slice(0, LIBRARY_LIST_CAP);
  const hiddenDocCount = scopedDocs.length - visibleDocs.length;

  const scopeRow =
    selectedFolder === null
      ? null
      : treeRows.find((row) => row.rootId === selectedFolder.rootId && row.path === selectedFolder.path) ?? null;
  const scopeLabel =
    selectedFolder === null
      ? "全部文献"
      : scopeRow?.name ?? (selectedFolder.path.length > 0 ? selectedFolder.path : "文献库");

  const selectFolder = useCallback((row: TreeRow) => {
    setSelectedFolder({ rootId: row.rootId, path: row.path });
    // 选中即展开一层，避免「点了文件夹却还是空白」。
    if (row.hasChildren) {
      setExpandedFolders((prev) => (prev.has(row.key) ? prev : new Set(prev).add(row.key)));
    }
  }, []);

  const toggleFolder = useCallback((row: TreeRow) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      return next;
    });
  }, []);

  // ── 上次阅读（需求 5）──
  const lastRead = useMemo<LastReadDoc | null>(() => {
    const list: LastReadDoc[] = libraryDocs.map((doc) => ({
      documentId: doc.id,
      title: displayTitle(doc.pdfTitle, doc.fileName),
      author: doc.pdfAuthor,
      pageCount: doc.pageCount,
      progressPage: doc.progressPage,
      lastOpenedAt: doc.lastOpenedAt,
    }));
    return pickLastRead(list);
  }, [libraryDocs]);
  const nowForLastRead = useMemo(() => new Date(), [lastRead]);

  /// 刷新 = 真刷新：先同步扫描磁盘（library_scan_now 扫完才返回），再重读列表/库根。
  /// 顺序不能反：先读后扫读到的是扫描前的旧数据——「磁盘上新增/删掉 PDF，刷新却看不到」就是这么来的。
  const refreshFromDisk = useCallback(async () => {
    try {
      setBusy("扫描中…");
      const outcome = await call(CMD.LIBRARY_SCAN_NOW, {}, { timeoutMs: SCAN_TIMEOUT_MS });
      await refresh();
      const added = outcome.added + outcome.revived;
      if (added + outcome.updated + outcome.removed === 0) {
        setStatus("已扫描 " + outcome.scanned + " 份文件，没有变化");
        return;
      }
      setStatus(
        "已扫描 " + outcome.scanned + " 份文件：新增 " + added + " 本，移除 " + outcome.removed + " 本" +
          (outcome.updated > 0 ? "，更新 " + outcome.updated + " 本" : ""),
      );
    } catch (err) {
      const e = err as { code?: string; detail?: string };
      setStatus("刷新失败：" + (e.code ?? "E_INTERNAL") + (e.detail ? " — " + e.detail : ""));
    } finally {
      setBusy("");
    }
  }, [refresh]);

  /// 添加文献库：路径只由系统文件管理器窗口给出（WebView2 没有可用的目录选择器，
  /// 手输绝对路径既容易打错，也会被反斜杠转义坑到）。
  const addLibrary = useCallback(async () => {
    try {
      setBusy("选择文件夹…");
      const picked = await call(CMD.LIBRARY_PICK_FOLDER, {}, { timeoutMs: PICK_FOLDER_TIMEOUT_MS });
      // 用户取消：什么都不做（不建库根、不动状态栏文案）。
      if (picked === null) return;
      setBusy("添加文献库…");
      const root = await call(CMD.LIBRARY_ROOT_ADD, { path: picked });
      setStatus("已添加文献库：" + root.displayName);
      setBusy("扫描中…");
      // 同步扫描：拿到确定的完成时刻与计数，不再靠 sleep 猜（原来那个 2s 猜测等待已删）。
      const outcome = await call(CMD.LIBRARY_SCAN_NOW, { rootId: root.id }, { timeoutMs: SCAN_TIMEOUT_MS });
      const docs = await call(CMD.DOCUMENT_RECENT, { limit: 200 });
      setBusy("建立索引…");
      // 索引入队沿用既有做法（扫描后逐个 enqueue），不新增批量命令。
      for (const doc of docs) {
        await call(CMD.INDEX_ENQUEUE, { documentId: doc.id, priority: 0 }).catch(() => undefined);
      }
      setStatus(
        "已加入 " + (outcome.added + outcome.revived) + " 本文献（" + docs.length + " 本在后台索引，搜索需要索引完成）",
      );
      await refresh();
    } catch (err) {
      const e = err as { code?: string; detail?: string; message?: string };
      setStatus("添加失败：" + (e.code ?? "E_INTERNAL") + " — " + (e.detail ?? e.message ?? ""));
    } finally {
      setBusy("");
    }
  }, [refresh]);

  const reindexAll = useCallback(async () => {
    try {
      setBusy("重建索引…");
      const started = await call(CMD.INDEX_REBUILD_ALL, {});
      setStatus("重建索引已启动：" + JSON.stringify(started));
    } catch (err) {
      const e = err as { code?: string; detail?: string };
      setStatus("重建失败：" + (e.code ?? "E_INTERNAL") + " — " + (e.detail ?? ""));
    } finally {
      setBusy("");
    }
  }, []);

  const saveProgress = useCallback(
    (docId: number) => (p: { pageNo: number; scrollRatio: number; zoom: number; mode: "continuous" | "single" }) => {
      void call(CMD.PROGRESS_SAVE, {
        progress: {
          documentId: docId,
          pageNo: p.pageNo,
          scrollRatio: p.scrollRatio,
          zoom: p.zoom,
          mode: p.mode,
          updatedAt: new Date().toISOString(),
        },
      }).catch(() => undefined);
    },
    [],
  );

  return (
    <div className="lg-shell">
      {/* D15 / 14-A1：阅读模式不出现任何与阅读无关的区域，顶部导航整条不渲染，
          把阅读高度完整让给页面；返回主页由阅读器内的返回按钮与 Esc 承担。 */}
      {route !== "reader" ? (
        <header className="lg-header">
          <strong className="lg-brand">Legere</strong>
          <nav className="lg-nav">
            <button type="button" onClick={() => openRoute("home")} className={route === "home" ? "is-active" : ""}>主页</button>
            <button type="button" onClick={() => openRoute("library")} className={route === "library" ? "is-active" : ""}>文献库</button>
            <button type="button" onClick={() => openRoute("settings")} className={route === "settings" ? "is-active" : ""}>设置</button>
          </nav>
          {indexing !== null && indexing.total > 0 ? (
            <span className="lg-progress" title="索引进度">
              <span style={{ width: Math.round((indexing.done / Math.max(1, indexing.total)) * 100) + "%" }} />
            </span>
          ) : null}
          <span className="lg-status">
            {busy !== "" ? busy : indexing !== null && indexing.total > 0 ? "索引 " + indexing.done + "/" + indexing.total : status || (ready ? "就绪" : "连接中…")}
          </span>
        </header>
      ) : null}

      <main className="lg-main">
        {/* 主页常驻挂载：返回时不重置环位置与焦点书（13 §6），active 负责停掉按键/滚轮。 */}
        <HomeSpace
          books={books}
          active={route === "home"}
          onOpenBook={openBook}
          onAddLibrary={() => void addLibrary()}
        />

        {/* 需求 5：上次阅读版块。只在主页显示，且不参与转盘几何。 */}
        {route === "home" && lastRead !== null ? (
          <LastReadCard doc={lastRead} now={nowForLastRead} onContinue={openBook} />
        ) : null}

        {route === "library" ? (
          <section className="lg-library">
            <div className="lg-library-toolbar">
              <button type="button" className="lg-btn" onClick={() => void addLibrary()} disabled={busy !== ""}>添加文献库</button>
              <button type="button" className="lg-btn" onClick={() => void reindexAll()} disabled={busy !== ""}>重建索引</button>
              <button type="button" className="lg-btn" onClick={() => void refreshFromDisk()} disabled={busy !== ""}>刷新</button>
              <input
                className="lg-filter"
                type="search"
                value={filter}
                placeholder="按文件名或标题过滤"
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setFilter("");
                }}
              />
              <span className="lg-muted">
                {scopedDocs.length +
                  " 本" +
                  (filterTotal !== null ? "（全库匹配 " + filterTotal + " 本）" : "")}
              </span>
            </div>
            <section className="lg-roots" aria-label="文献库">
              <header className="lg-roots-head">
                <h2>文献库</h2>
                <span className="lg-muted">{roots.length} 个</span>
              </header>
              {roots.length === 0 ? (
                <p className="lg-muted lg-roots-empty">还没有文献库</p>
              ) : (
                <ul className="lg-root-list">
                  {roots.map((root) => (
                    <li key={root.id}>
                      <span className="lg-root-name" title={root.path}>{rootLabel(root)}</span>
                      <span className="lg-root-path" title={root.path}>{root.path}</span>
                      <span className="lg-root-actions">
                        <button type="button" className="lg-doc-action" onClick={() => setRootDialog({ kind: "rename", root })}>
                          更改
                        </button>
                        <button type="button" className="lg-doc-action" onClick={() => setRootDialog({ kind: "replace", root })}>
                          替换
                        </button>
                        <button type="button" className="lg-doc-action" onClick={() => setRootDialog({ kind: "remove", root })}>
                          移除
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="lg-library-body">
              {/* 需求 2：按 rel_path 还原的文件夹层级（渲染在 LibraryTree.tsx）。 */}
              <LibraryTree
                rows={treeRows}
                totalCount={libraryDocs.length}
                selected={selectedFolder}
                onSelectAll={() => setSelectedFolder(null)}
                onSelectRow={selectFolder}
                onToggleRow={toggleFolder}
              />

              <section className="lg-library-list">
                <div className="lg-library-list-head">
                  <h2>{scopeLabel}</h2>
                  <span className="lg-muted">{scopedDocs.length} 本</span>
                </div>
                {scopedDocs.length === 0 ? (
                  <p className="lg-library-empty">
                    {libraryDocs.length === 0 ? "还没有文献，先添加文献库" : "这个文件夹里没有匹配的文献"}
                  </p>
                ) : (
                  <ul className="lg-doc-list">
                    {visibleDocs.map((doc) => (
                      <li key={doc.id}>
                        <button type="button" onClick={() => openBook(doc.id)} title={doc.relPath}>
                          <span className="lg-doc-title">{displayTitle(doc.pdfTitle, doc.fileName)}</span>
                          <span className="lg-doc-meta">
                            {doc.pageCount !== null ? doc.pageCount + " 页" : "页数未知"}
                          </span>
                          <span className="lg-doc-meta">{TEXT_STATE_TEXT[doc.textState]}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {hiddenDocCount > 0 ? (
                  <p className="lg-library-empty">
                    已显示前 {LIBRARY_LIST_CAP} 本，用左侧文件夹或过滤词收窄范围（还有 {hiddenDocCount} 本未显示）
                  </p>
                ) : null}
              </section>
            </div>
          </section>
        ) : null}

        {route === "reader" && activeDocumentId !== null ? (
          <ReaderView
            key={readerOpenCount}
            documentId={activeDocumentId}
            initialPage={readerStartPage}
            onExit={leaveReader}
            onProgress={saveProgress(activeDocumentId)}
          />
        ) : null}

        {route === "settings" ? (
          <section className="lg-settings">
            <section className="lg-settings-section">
              <h2>外观</h2>
              <div className="lg-row">
                <span className="lg-row-label">主题来源</span>
                <div className="lg-theme-choices">
                  {THEME_SOURCE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={themeSource === option.value ? "is-active" : ""}
                      onClick={() => setThemeSource(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <span className="lg-muted">跟随系统时只在 light / dark 之间切换</span>
              </div>
              <div className="lg-row">
                <span className="lg-row-label">主题</span>
                <div className="lg-theme-choices">
                  {(["light", "dark", "paper"] as ThemeName[]).map((name) => (
                    <button
                      key={name}
                      type="button"
                      className={theme === name ? "is-active" : ""}
                      disabled={themeSource === "system"}
                      onClick={() => setTheme(name)}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>
              <div className="lg-row">
                <span className="lg-row-label">暖色纸光罩</span>
                <input
                  type="checkbox"
                  checked={paperVeil}
                  disabled={theme !== "paper"}
                  onChange={(e) => setPaperVeil(e.target.checked)}
                />
                <span className="lg-muted">仅在 paper 主题生效</span>
              </div>
              <div className="lg-row">
                <span className="lg-row-label">页面色调</span>
                <div className="lg-theme-choices">
                  {PAGE_TONE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={pageTone === option.value ? "is-active" : ""}
                      onClick={() => setPageTone(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <span className="lg-muted">
                  {theme === "dark"
                    ? (PAGE_TONE_OPTIONS.find((o) => o.value === pageTone)?.hint ?? "")
                    : "当前主题不生效；切到 dark 后按上面的选法应用（PDF 页面本身是纸白的，夜里刺眼）"}
                </span>
              </div>
            </section>
            <section className="lg-settings-section">
              <h2>阅读</h2>
              <div className="lg-row">
                <span className="lg-row-label">默认阅读模式</span>
                <div className="lg-theme-choices">
                  {DEFAULT_MODE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={defaultMode === option.value ? "is-active" : ""}
                      onClick={() => {
                        setDefaultMode(option.value);
                        persistSetting(READER_DEFAULT_MODE_KEY, option.value);
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <span className="lg-muted">仅对还没有阅读进度的文献生效</span>
              </div>
              <div className="lg-row">
                <span className="lg-row-label">默认缩放</span>
                <div className="lg-theme-choices">
                  {DEFAULT_SCALE_OPTIONS.map((scale) => (
                    <button
                      key={scale}
                      type="button"
                      className={defaultScale === scale ? "is-active" : ""}
                      onClick={() => {
                        setDefaultScale(scale);
                        persistSetting(READER_DEFAULT_SCALE_KEY, String(scale));
                      }}
                    >
                      {formatScaleOption(scale)}
                    </button>
                  ))}
                </div>
              </div>
            </section>
            <section className="lg-settings-section">
              <h2>快捷键（{keymapEntryCount()} 条）</h2>
              {KEYMAP.map((group) => (
                <div className="lg-keymap-group" key={group.title}>
                  <h3>{group.title}</h3>
                  <ul className="lg-keymap">
                    {group.entries.map((entry) => (
                      <li key={group.title + ":" + entry.keys.join("+") + ":" + entry.label}>
                        {entry.keys.map((key, index) => (
                          <kbd key={key + index}>{key}</kbd>
                        ))}
                        <span>{entry.label}</span>
                        {entry.note !== undefined ? <span className="lg-keymap-note">{entry.note}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          </section>
        ) : null}
      </main>

      {rootDialog !== null && rootDialog.kind === "rename" ? (
        <RootRenameDialog
          root={rootDialog.root}
          onClose={() => setRootDialog(null)}
          onDone={(message) => {
            setRootDialog(null);
            setStatus(message);
            void refresh();
          }}
        />
      ) : null}

      {rootDialog !== null && rootDialog.kind === "replace" ? (
        <RootReplaceDialog
          root={rootDialog.root}
          onClose={() => setRootDialog(null)}
          onDone={(message) => {
            setRootDialog(null);
            setStatus(message);
            void refresh();
          }}
        />
      ) : null}

      {rootDialog !== null && rootDialog.kind === "remove" ? (
        <RootRemoveDialog
          root={rootDialog.root}
          onClose={() => setRootDialog(null)}
          onDone={(message) => {
            setRootDialog(null);
            setStatus(message);
            void refresh();
          }}
        />
      ) : null}

      {globalSearchOpen ? (
        <div className="lg-overlay" role="dialog" aria-modal="true">
          <div className="lg-overlay-panel">
            <input
              autoFocus
              placeholder="搜索全部文献（至少 2 个字，回车执行）"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runGlobalSearch(searchQuery);
                if (e.key === "Escape") useAppStore.getState().setGlobalSearchOpen(false);
              }}
            />
            <ul className="lg-search-results">
              {searchHits.map((group) => (
                <li key={group.documentId}>
                  <strong>{group.title}</strong>
                  <ul>
                    {group.hits.map((hit) => (
                      <li key={hit.pageNo}>
                        <button type="button" onClick={() => openBook(group.documentId, hit.pageNo)}>
                          p{hit.pageNo} {hit.snippet}
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export { searchPages };
