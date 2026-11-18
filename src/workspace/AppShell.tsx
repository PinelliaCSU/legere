// M14 · 工作区外壳：路由 + 主页转盘 + 文献库 + 阅读器 + 全局搜索 + 设置。
//
// 遗留项处理：「事件 + 拉取」双保险——app://ready 只在页面加载瞬间发一次，容易早于订阅，
// 因此这里先拉 ping/app_info，再订阅事件作为后续通知来源（不再依赖单一事件判断就绪）。

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import { CMD } from "../contracts/cmd";
import { EVT } from "../contracts/evt";
import type { DocumentDto, LibraryRootDto, TextState } from "../contracts/types";
import { call, subscribe } from "../core/ipc";
import { ReaderView, type ReaderApi } from "../reader/ReaderView";
import { searchPages, type DocSearchHit } from "../reader/search/doc-search";
import { useTheme } from "../theme/ThemeProvider";
import type { ThemeName } from "../theme/tokens";
import { HomeSpace, spineColorFor, type HomeBook } from "./HomeSpace";
import { rootLabel } from "./library-roots";
import { RootRemoveDialog, RootRenameDialog, RootReplaceDialog } from "./LibraryDialogs";
import { useAppStore } from "./router";

/// 索引状态文案（docs/16 §3 的用词：无文本 / 索引失败 / 正在建立索引）。
/// 之前直接渲染 TextState 的英文枚举值，属于把内部状态泄漏到界面上。
const TEXT_STATE_TEXT: Record<TextState, string> = {
  pending: "待索引",
  indexing: "索引中",
  indexed: "已索引",
  no_text: "无文本（扫描版）",
  failed: "索引失败",
};

function toHomeBook(doc: DocumentDto): HomeBook {
  return {
    documentId: doc.id,
    fileName: doc.fileName,
    title: doc.pdfTitle ?? doc.fileName.replace(/\.pdf$/i, ""),
    author: doc.pdfAuthor,
    spineColor: spineColorFor(doc.id),
    pageCount: doc.pageCount,
    progressPage: doc.progressPage,
  };
}

export function AppShell(): ReactElement {
  const { route, activeDocumentId, globalSearchOpen, openRoute, openDocument, closeDocument } = useAppStore();
  const { theme, setTheme, paperVeil, setPaperVeil } = useTheme();
  const [documents, setDocuments] = useState<DocumentDto[]>([]);
  /// 库根列表：文献库的「更改 / 替换 / 移除」都作用在这一层（R22 / R23）。
  const [roots, setRoots] = useState<LibraryRootDto[]>([]);
  const [rootDialog, setRootDialog] = useState<{ kind: "rename" | "replace" | "remove"; root: LibraryRootDto } | null>(null);
  const [status, setStatus] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<{ documentId: number; title: string; hits: DocSearchHit[] }[]>([]);
  const [ready, setReady] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addPath, setAddPath] = useState("");
  const [busy, setBusy] = useState("");
  const [indexing, setIndexing] = useState<{ done: number; total: number } | null>(null);


  const refresh = useCallback(async () => {
    try {
      const [page, rootList] = await Promise.all([
        call(CMD.DOCUMENT_RECENT, { limit: 100 }),
        call(CMD.LIBRARY_ROOT_LIST, {}),
      ]);
      setDocuments(page);
      setRoots(rootList);
    } catch (err) {
      const e = err as { code?: string };
      setStatus("读取文献库失败：" + (e.code ?? "E_INTERNAL"));
    }
  }, []);

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

  // 注意：WebView2 不支持 window.prompt，必须用应用内输入框（否则按钮点了没反应）。
  const onAddLibrary = useCallback(async (rawPath: string) => {
    const path = rawPath.trim();
    if (path.length === 0) return;
    try {
      setBusy("添加文献库…");
      const root = await call(CMD.LIBRARY_ROOT_ADD, { path });
      setStatus("已添加文献库：" + root.displayName);
      setBusy("扫描中…");
      await call(CMD.LIBRARY_SCAN_START, { rootId: root.id });
      // 扫描是后台任务：等一会儿再刷新，并把新文档送进索引队列（否则搜不到）。
      await new Promise((r) => setTimeout(r, 2000));
      const docs = await call(CMD.DOCUMENT_RECENT, { limit: 200 });
      setBusy("建立索引…");
      for (const doc of docs) {
        await call(CMD.INDEX_ENQUEUE, { documentId: doc.id, priority: 0 }).catch(() => undefined);
      }
      setStatus("已加入 " + docs.length + " 本文献，正在后台索引（搜索需要索引完成）");
      setAddOpen(false);
      setAddPath("");
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

      {addOpen ? (
        <div className="lg-addbar">
          <input
            autoFocus
            placeholder="粘贴文献库文件夹的绝对路径，例如 D:\Papers"
            value={addPath}
            onChange={(e) => setAddPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void onAddLibrary(addPath);
              if (e.key === "Escape") setAddOpen(false);
            }}
          />
          <button type="button" className="lg-btn lg-btn-primary" onClick={() => void onAddLibrary(addPath)}>
            添加并扫描
          </button>
          <button type="button" className="lg-btn" onClick={() => setAddOpen(false)}>
            取消
          </button>
        </div>
      ) : null}

      <main className="lg-main">
        {/* 主页常驻挂载：返回时不重置环位置与焦点书（13 §6），active 负责停掉按键/滚轮。 */}
        <HomeSpace
          books={books}
          active={route === "home"}
          onOpenBook={(id) => openDocument(id)}
          onAddLibrary={() => setAddOpen(true)}
        />

        {route === "library" ? (
          <section className="lg-library">
            <div className="lg-library-toolbar">
              <button type="button" className="lg-btn" onClick={() => setAddOpen(true)}>添加文献库</button>
              <button type="button" className="lg-btn" onClick={() => void reindexAll()} disabled={busy !== ""}>重建索引</button>
              <button type="button" className="lg-btn" onClick={() => void refresh()}>刷新</button>
              <span className="lg-muted">{documents.length} 本</span>
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

            <ul className="lg-doc-list">
              {documents.map((doc) => (
                <li key={doc.id}>
                  <button type="button" onClick={() => openDocument(doc.id)}>
                    <span className="lg-doc-title">{doc.pdfTitle ?? doc.fileName}</span>
                    <span className="lg-doc-meta">{doc.pageCount !== null ? doc.pageCount + " 页" : "页数未知"}</span>
                    <span className="lg-doc-meta">{TEXT_STATE_TEXT[doc.textState]}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {route === "reader" && activeDocumentId !== null ? (
          <ReaderView
            documentId={activeDocumentId}
            onExit={closeDocument}
            onProgress={saveProgress(activeDocumentId)}
          />
        ) : null}

        {route === "settings" ? (
          <section className="lg-settings">
            <section className="lg-settings-section">
              <h2>外观</h2>
              <div className="lg-row">
                <span className="lg-row-label">主题</span>
                <div className="lg-theme-choices">
                  {(["light", "dark", "paper"] as ThemeName[]).map((name) => (
                    <button
                      key={name}
                      type="button"
                      className={theme === name ? "is-active" : ""}
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
            </section>
            <section className="lg-settings-section">
              <h2>快捷键</h2>
              <ul className="lg-keymap">
                <li><kbd>Ctrl</kbd><kbd>K</kbd><span>文献库搜索</span></li>
                <li><kbd>Ctrl</kbd><kbd>F</kbd><span>文内搜索</span></li>
                <li><kbd>←</kbd><kbd>→</kbd><span>上一页 / 下一页</span></li>
                <li><kbd>Ctrl</kbd><kbd>+</kbd><kbd>-</kbd><span>缩放</span></li>
                <li><kbd>M</kbd><span>连续 / 单页切换</span></li>
                <li><kbd>Esc</kbd><span>退出阅读模式</span></li>
              </ul>
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
                        <button type="button" onClick={() => openDocument(group.documentId)}>
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