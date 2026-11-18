// M14 · 工作区外壳：路由 + 主页转盘 + 文献库 + 阅读器 + 全局搜索 + 设置。
//
// 遗留项处理：「事件 + 拉取」双保险——app://ready 只在页面加载瞬间发一次，容易早于订阅，
// 因此这里先拉 ping/app_info，再订阅事件作为后续通知来源（不再依赖单一事件判断就绪）。

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import { CMD } from "../contracts/cmd";
import { EVT } from "../contracts/evt";
import type { DocumentDto } from "../contracts/types";
import { call, subscribe } from "../core/ipc";
import { ReaderView, type ReaderApi } from "../reader/ReaderView";
import { searchPages, type DocSearchHit } from "../reader/search/doc-search";
import { useTheme } from "../theme/ThemeProvider";
import { themes, type ThemeName } from "../theme/tokens";
import { HomeSpace, spineColorFor, type HomeBook } from "./HomeSpace";
import { useAppStore } from "./router";

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
  const { route, activeDocumentId, openRoute, openDocument, closeDocument } = useAppStore();
  const { theme, setTheme, paperVeil, setPaperVeil } = useTheme();
  const [documents, setDocuments] = useState<DocumentDto[]>([]);
  const [status, setStatus] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<{ documentId: number; title: string; hits: DocSearchHit[] }[]>([]);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const page = await call(CMD.DOCUMENT_RECENT, { limit: 100 });
      setDocuments(page);
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
    let dispose: (() => void) | null = null;
    void subscribe(EVT.LIBRARY_CHANGED, () => {
      void refresh();
    }).then((fn) => {
      dispose = fn;
    });
    return () => dispose?.();
  }, [refresh]);

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

  const onAddLibrary = useCallback(async () => {
    const path = window.prompt("输入文献库文件夹的绝对路径");
    if (path === null || path.trim().length === 0) return;
    try {
      const root = await call(CMD.LIBRARY_ROOT_ADD, { path: path.trim() });
      setStatus("已添加文献库：" + root.displayName);
      await call(CMD.LIBRARY_SCAN_START, { rootId: root.id });
      window.setTimeout(() => void refresh(), 1500);
    } catch (err) {
      const e = err as { code?: string; detail?: string };
      setStatus("添加失败：" + (e.code ?? "E_INTERNAL") + (e.detail ? " — " + e.detail : ""));
    }
  }, [refresh]);

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
      <header className="lg-header">
        <strong className="lg-brand">Legere</strong>
        <nav className="lg-nav">
          <button type="button" onClick={() => openRoute("home")} className={route === "home" ? "is-active" : ""}>主页</button>
          <button type="button" onClick={() => openRoute("library")} className={route === "library" ? "is-active" : ""}>文献库</button>
          <button type="button" onClick={() => openRoute("settings")} className={route === "settings" ? "is-active" : ""}>设置</button>
        </nav>
        <span className="lg-status">{status || (ready ? "就绪" : "连接中…")}</span>
      </header>

      <main className="lg-main">
        {route === "home" ? (
          <HomeSpace books={books} onOpenBook={(id) => openDocument(id)} onAddLibrary={() => void onAddLibrary()} />
        ) : null}

        {route === "library" ? (
          <section className="lg-library">
            <div className="lg-library-toolbar">
              <button type="button" className="lg-btn" onClick={() => void onAddLibrary()}>添加文献库</button>
              <button type="button" className="lg-btn" onClick={() => void refresh()}>刷新</button>
              <span className="lg-muted">{documents.length} 本</span>
            </div>
            <ul className="lg-doc-list">
              {documents.map((doc) => (
                <li key={doc.id}>
                  <button type="button" onClick={() => openDocument(doc.id)}>
                    <span className="lg-doc-title">{doc.pdfTitle ?? doc.fileName}</span>
                    <span className="lg-muted">
                      {doc.pageCount !== null ? doc.pageCount + " 页" : "页数未知"} · {doc.textState}
                    </span>
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
            <h2>外观</h2>
            <div className="lg-row">
              <span>主题</span>
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
              <span>暖色纸光罩</span>
              <input type="checkbox" checked={paperVeil} onChange={(e) => setPaperVeil(e.target.checked)} />
            </div>
            <h2>数据</h2>
            <p className="lg-muted">主题令牌数：{Object.keys(themes[theme]).length}</p>
          </section>
        ) : null}
      </main>

      {useAppStore.getState().globalSearchOpen ? (
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
