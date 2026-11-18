// M07 · 阅读交互层 + M08 文内搜索 UI（docs/03 M07/M08、07 §4.0）。
//
// 性能要点（用户反馈「打开很慢」的直接原因）：
// 原实现先 await 全部页面 getPage() 拿到几何，再开始渲染 —— 300 页的 PDF 等于 300 次串行解析。
// 现在：拿到第 1 页几何就立刻渲染首屏，其余几何分批补齐并渐进更新（见 loadGeometries）。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { pdfEngine } from "../pdf-engine";
import type { DocumentHandle, PageGeometry, TextContentHandle } from "../pdf-engine/types";
import { createRenderScheduler, computePageBoxes, currentPageAt, PAGE_GAP, READER_PADDING, type PageRenderState, type ReadMode } from "../render";
import { BookmarkDrawer } from "./BookmarkDrawer";
import { mountHighlights } from "./highlight";
import { searchPages, type DocSearchHit } from "./search/doc-search";
import { mountTextLayer } from "./text-layer";

export interface ReaderApi {
  mode: ReadMode;
  scale: number;
  currentPage: number;
  pageCount: number;
  setMode: (m: ReadMode) => void;
  setScale: (s: number) => void;
  goToPage: (pageNo: number) => void;
  getSelectionText: () => string;
}

interface ReaderViewProps {
  documentId: number;
  onExit: () => void;
  onProgress: (p: { pageNo: number; scrollRatio: number; zoom: number; mode: ReadMode }) => void;
  onApiReady?: (api: ReaderApi) => void;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const GEO_BATCH = 20;

export function ReaderView({ documentId, onExit, onProgress, onApiReady }: ReaderViewProps): ReactElement {
  const scheduler = useMemo(() => createRenderScheduler(), []);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [doc, setDoc] = useState<DocumentHandle | null>(null);
  const [geos, setGeos] = useState<PageGeometry[]>([]);
  const [mode, setMode] = useState<ReadMode>("continuous");
  const [scale, setScale] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [states, setStates] = useState<ReadonlyMap<number, PageRenderState>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DocSearchHit[]>([]);
  const [activeHit, setActiveHit] = useState(0);
  const [searching, setSearching] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [outline, setOutline] = useState<{ title: string; pageNo: number | null }[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);

  // 打开文档：首屏优先（只等第 1 页几何），其余分批补齐
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setDoc(null);
    setGeos([]);
    setHits([]);
    void (async () => {
      try {
        const { call } = await import("../core/ipc");
        const { CMD } = await import("../contracts/cmd");
        const source = await call(CMD.DOCUMENT_URL, { id: documentId });
        const handle = await pdfEngine.openDocument({ url: source.url, docId: documentId });
        if (!alive) {
          await handle.dispose();
          return;
        }
        setDoc(handle);

        const first = await handle.getPage(1);
        if (!alive) return;
        setGeos([first.geometry]);
        setLoading(false);

        // 渐进补齐：每批 GEO_BATCH 页更新一次 state，首屏不被阻塞。
        const acc: PageGeometry[] = [first.geometry];
        for (let p = 2; p <= handle.pageCount; p += 1) {
          if (!alive) return;
          acc.push((await handle.getPage(p)).geometry);
          if (p % GEO_BATCH === 0 || p === handle.pageCount) {
            setGeos([...acc]);
          }
        }
        // PDF 自带书签（outline）：用户明确要求能获取
        const nodes = await handle.getOutline();
        if (alive) {
          const flat: { title: string; pageNo: number | null }[] = [];
          const walk = (list: typeof nodes) => {
            for (const node of list) {
              flat.push({ title: node.title, pageNo: node.pageNo });
              if (node.children.length > 0) walk(node.children);
            }
          };
          walk(nodes);
          setOutline(flat);
        }
        await call(CMD.DOCUMENT_TOUCH_OPENED, { id: documentId });
      } catch (err) {
        const e = err as { code?: string };
        setError(e.code ?? "E_INTERNAL");
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [documentId]);

  useEffect(() => () => void doc?.dispose(), [doc]);

  useEffect(() => {
    scheduler.setDocument(doc);
    const unsubscribe = scheduler.subscribe((next) => setStates(new Map(next)));
    return () => {
      unsubscribe();
      scheduler.setDocument(null);
    };
  }, [doc, scheduler]);

  // 视口发布：几何可能还没补全，用当前已知的部分
  useEffect(() => {
    const scroll = scrollRef.current;
    if (doc === null || scroll === null || geos.length === 0) return;
    const publish = () => {
      scheduler.setViewport({
        mode,
        scale,
        scrollTop: scroll.scrollTop,
        viewportHeight: scroll.clientHeight,
        viewportWidth: scroll.clientWidth,
        pageGeometries: geos,
      });
    };
    publish();
    scroll.addEventListener("scroll", publish, { passive: true });
    window.addEventListener("resize", publish);
    return () => {
      scroll.removeEventListener("scroll", publish);
      window.removeEventListener("resize", publish);
    };
  }, [doc, geos, mode, scale, scheduler]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (scroll === null || geos.length === 0) return;
    const onScroll = () => setCurrentPage(currentPageAt(computePageBoxes(geos, scale), scroll.scrollTop, scroll.clientHeight));
    onScroll();
    scroll.addEventListener("scroll", onScroll, { passive: true });
    return () => scroll.removeEventListener("scroll", onScroll);
  }, [geos, scale]);

  useEffect(() => {
    if (doc === null) return;
    const timer = window.setInterval(() => {
      const scroll = scrollRef.current;
      if (scroll === null) return;
      onProgress({
        pageNo: currentPage,
        scrollRatio: scroll.scrollHeight > 0 ? scroll.scrollTop / scroll.scrollHeight : 0,
        zoom: scale,
        mode,
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [doc, currentPage, scale, mode, onProgress]);

  const goToPage = useCallback(
    (pageNo: number) => {
      const target = Math.min(Math.max(1, pageNo), Math.max(1, doc?.pageCount ?? 1));
      setCurrentPage(target);
      const scroll = scrollRef.current;
      if (scroll === null || geos.length === 0) return;
      const box = computePageBoxes(geos, scale)[target - 1];
      if (box !== undefined) scroll.scrollTop = box.top + READER_PADDING;
    },
    [doc, geos, scale],
  );

  /// 文内搜索：逐页取文本（有缓存），命中聚合；结果跳到对应页并高亮。
  const runSearch = useCallback(
    async (raw: string) => {
      if (doc === null || raw.trim().length === 0) {
        setHits([]);
        return;
      }
      setSearching(true);
      try {
        const collected: { pageNo: number; content: TextContentHandle }[] = [];
        for (let p = 1; p <= doc.pageCount; p += 1) {
          const page = await doc.getPage(p);
          collected.push({ pageNo: p, content: await page.getTextContent() });
        }
        const found = searchPages(collected, raw);
        setHits(found);
        setActiveHit(0);
        const first = found[0];
        if (first !== undefined) goToPage(first.pageNo);
      } finally {
        setSearching(false);
      }
    },
    [doc, goToPage],
  );

  // 键盘：Ctrl+F 文内搜索，Ctrl± 缩放，翻页/模式/退出
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === "f") {
          e.preventDefault();
          setSearchOpen(true);
          return;
        }
        if (e.key === "+" || e.key === "=") setScale((s) => Math.min(MAX_SCALE, Number((s + 0.1).toFixed(2))));
        if (e.key === "-") setScale((s) => Math.max(MIN_SCALE, Number((s - 0.1).toFixed(2))));
        return;
      }
      if (e.key === "ArrowRight" || e.key === "PageDown") goToPage(currentPage + 1);
      if (e.key === "ArrowLeft" || e.key === "PageUp") goToPage(currentPage - 1);
      if (e.key.toLowerCase() === "m") setMode((m) => (m === "continuous" ? "single" : "continuous"));
      if (e.key === "Escape") {
        if (searchOpen) setSearchOpen(false);
        else onExit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentPage, goToPage, onExit, searchOpen]);

  // Ctrl + 滚轮缩放（用户反馈「阅读无法放大」：原来只支持 Ctrl +/-，滚轮无效）
  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const factor = e.deltaY > 0 ? -0.1 : 0.1;
    setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number((s + factor).toFixed(2)))));
  }, []);

  const getSelectionText = useCallback(() => window.getSelection()?.toString() ?? "", []);

  useEffect(() => {
    onApiReady?.({ mode, scale, currentPage, pageCount: doc?.pageCount ?? 0, setMode, setScale, goToPage, getSelectionText });
  }, [mode, scale, currentPage, doc?.pageCount, goToPage, getSelectionText, onApiReady]);

  const slotPages = useMemo(() => {
    if (geos.length === 0) return [];
    if (mode === "single") return [currentPage];
    return Array.from({ length: geos.length }, (_, i) => i + 1);
  }, [geos.length, mode, currentPage]);

  const activeHitPage = hits[activeHit]?.pageNo;
  const activeRanges = hits[activeHit]?.ranges ?? [];

  return (
    <div className="lg-reader" ref={scrollRef} tabIndex={0} onWheel={onWheel}>
      {loading ? <p className="lg-reader-status">正在打开…</p> : null}
      {error !== null ? <p className="lg-reader-status">打开失败：{error}</p> : null}

      {searchOpen ? (
        <div className="lg-docsearch">
          <input
            autoFocus
            placeholder="在本文中搜索，回车执行"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runSearch(query);
              if (e.key === "Escape") setSearchOpen(false);
            }}
          />
          <span className="lg-muted">
            {searching ? "搜索中…" : hits.length > 0 ? hits.reduce((n, h) => n + h.ranges.length, 0) + " 处命中" : query.length > 0 ? "无命中" : ""}
          </span>
          <button type="button" className="lg-btn" onClick={() => setSearchOpen(false)}>关闭</button>
          {hits.length > 0 ? (
            <ul className="lg-docsearch-list">
              {hits.map((hit, index) => (
                <li key={hit.pageNo}>
                  <button
                    type="button"
                    className={index === activeHit ? "is-active" : ""}
                    onClick={() => {
                      setActiveHit(index);
                      goToPage(hit.pageNo);
                    }}
                  >
                    p{hit.pageNo} · {hit.ranges.length} 处 · {hit.snippet.slice(0, 40)}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="lg-pages">
        {slotPages.map((pageNo) => {
          const geo = geos[pageNo - 1];
          if (geo === undefined) return null;
          return (
            <PageSlot
              key={pageNo}
              doc={doc}
              pageNo={pageNo}
              geometry={geo}
              scale={scale}
              state={states.get(pageNo)}
              highlights={pageNo === activeHitPage ? activeRanges : []}
              mountText={Math.abs(pageNo - currentPage) <= 2}
            />
          );
        })}
      </div>
      <div className="lg-zoom-bar">
        <button type="button" title="缩小" onClick={() => setScale((s) => Math.max(MIN_SCALE, Number((s - 0.1).toFixed(2))))}>−</button>
        <span>{Math.round(scale * 100)}%</span>
        <button type="button" title="放大" onClick={() => setScale((s) => Math.min(MAX_SCALE, Number((s + 0.1).toFixed(2))))}>+</button>
        <button type="button" title="适应宽度" onClick={() => setScale(1)}>1:1</button>
        {outline.length > 0 ? (
          <button type="button" title="目录" onClick={() => setOutlineOpen((o) => !o)}>目录</button>
        ) : null}
      </div>
      {outlineOpen && outline.length > 0 ? (
        <aside className="lg-drawer lg-outline" aria-label="目录">
          <header className="lg-drawer-head">
            <strong>目录</strong>
            <button type="button" className="lg-btn" onClick={() => setOutlineOpen(false)}>关闭</button>
          </header>
          <ul className="lg-drawer-list">
            {outline.map((node, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => {
                    if (node.pageNo !== null) goToPage(node.pageNo);
                  }}
                >
                  {node.title}
                  {node.pageNo !== null ? " · p" + node.pageNo : ""}
                </button>
              </li>
            ))}
          </ul>
        </aside>
      ) : null}
      <div className="lg-page-capsule">
        {currentPage} / {doc?.pageCount ?? geos.length}
      </div>
      <button type="button" className="lg-float-btn lg-float-left" title="上一页" onClick={() => goToPage(currentPage - 1)}>‹</button>
      <button type="button" className="lg-float-btn lg-float-right" title="下一页" onClick={() => goToPage(currentPage + 1)}>›</button>
      {/* D15：无工具栏，右侧悬浮按钮展开书签抽屉 */}
      <button
        type="button"
        className="lg-float-btn lg-float-bookmark"
        title="书签"
        onClick={() => setBookmarksOpen((open) => !open)}
      >
        ⚑
      </button>
      {bookmarksOpen ? (
        <BookmarkDrawer
          documentId={documentId}
          currentPage={currentPage}
          onJump={(pageNo) => goToPage(pageNo)}
          onClose={() => setBookmarksOpen(false)}
        />
      ) : null}
    </div>
  );
}

interface PageSlotProps {
  doc: DocumentHandle | null;
  pageNo: number;
  geometry: PageGeometry;
  scale: number;
  state: PageRenderState | undefined;
  highlights: [number, number][];
  /// 是否挂文本层：只给当前页附近，避免一次打开发起 N 次 getTextContent（性能关键）。
  mountText: boolean;
}

function PageSlot({ doc, pageNo, geometry, scale, state, highlights, mountText }: PageSlotProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<{ destroy: () => void } | null>(null);
  const highlightRef = useRef<(() => void) | null>(null);
  const contentRef = useRef<TextContentHandle | null>(null);
  const width = Math.round(geometry.widthPt * scale);
  const height = Math.round(geometry.heightPt * scale);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || doc === null) return;
    if (!mountText) {
      // 远离当前页：卸掉文本层，释放 DOM 与文本内容
      textRef.current?.destroy();
      textRef.current = null;
      contentRef.current = null;
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const page = await doc.getPage(pageNo);
        const content = state?.textContent ?? (await page.getTextContent());
        if (cancelled) return;
        contentRef.current = content;
        textRef.current?.destroy();
        textRef.current = mountTextLayer(host, content, scale, geometry.heightPt);
      } catch (err) {
        console.warn("文本层挂载失败", pageNo, err);
      }
    })();
    return () => {
      cancelled = true;
      textRef.current?.destroy();
      textRef.current = null;
    };
  }, [doc, pageNo, scale, geometry.heightPt, state?.textContent, mountText]);

  // 高亮：当前命中页的命中区间
  useEffect(() => {
    const host = hostRef.current;
    highlightRef.current?.();
    highlightRef.current = null;
    const content = contentRef.current;
    if (host === null || content === null || highlights.length === 0) return;
    highlightRef.current = mountHighlights(host, content, highlights, 0, scale, geometry.heightPt);
    return () => {
      highlightRef.current?.();
      highlightRef.current = null;
    };
  }, [highlights, scale, geometry.heightPt, state?.textContent]);

  return (
    <div className="lg-page" data-page={pageNo} ref={hostRef} style={{ width, height, marginBottom: PAGE_GAP }}>
      {state?.canvas !== undefined && state.canvas !== null ? (
        <CanvasHost canvas={state.canvas} />
      ) : (
        <div className="lg-page-placeholder">
          <span>{state?.state === "error" ? "渲染失败" : "加载中…"}</span>
        </div>
      )}
    </div>
  );
}

function CanvasHost({ canvas }: { canvas: HTMLCanvasElement }): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = ref.current;
    if (host === null) return;
    host.appendChild(canvas);
    return () => {
      if (canvas.parentElement === host) host.removeChild(canvas);
    };
  }, [canvas]);
  return <div className="lg-page-canvas" ref={ref} />;
}