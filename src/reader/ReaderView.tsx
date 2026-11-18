// M07 · 阅读交互层（docs/03 M07、07 §4.0 外壳契约）。
//
// 职责：模式（连续/单页）、缩放、跳页、选择、进度回写；渲染由 M06 调度器负责。
// 禁止：直接调 page.render()、直接 invoke 存进度（走注入的 ProgressPort）。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { pdfEngine } from "../pdf-engine";
import type { DocumentHandle, PageHandle, TextContentHandle } from "../pdf-engine/types";
import { createRenderScheduler, computePageBoxes, computeVisibleRange, currentPageAt, type PageRenderState, type ReadMode, type ViewportState } from "../render";
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
  onProgress: (progress: { pageNo: number; scrollRatio: number; zoom: number; mode: ReadMode }) => void;
  onApiReady?: (api: ReaderApi) => void;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;

export function ReaderView({ documentId, onExit, onProgress, onApiReady }: ReaderViewProps): ReactElement {
  const scheduler = useMemo(() => createRenderScheduler(), []);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [doc, setDoc] = useState<DocumentHandle | null>(null);
  const [mode, setMode] = useState<ReadMode>("continuous");
  const [scale, setScaleState] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [states, setStates] = useState<ReadonlyMap<number, PageRenderState>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // 打开文档（共享同一 DocumentHandle；切换模式不重新 getDocument）
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
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
        setPageCount(handle.pageCount);
        await call(CMD.DOCUMENT_TOUCH_OPENED, { id: documentId });
      } catch (err) {
        const e = err as { code?: string; message?: string };
        setError(e.code ?? "E_INTERNAL");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [documentId]);

  // 把文档交给调度器并订阅状态
  useEffect(() => {
    scheduler.setDocument(doc);
    const unsubscribe = scheduler.subscribe((next) => setStates(new Map(next)));
    return () => {
      unsubscribe();
      scheduler.setDocument(null);
    };
  }, [doc, scheduler]);

  // 文档变化时释放旧 handle
  useEffect(() => {
    return () => {
      void doc?.dispose();
    };
  }, [doc]);

  // 视口 -> 调度器
  useEffect(() => {
    const scroll = scrollRef.current;
    if (doc === null || scroll === null) return;

    let geo: ViewportState["pageGeometries"] = [];
    const buildViewport = async () => {
      // 页几何逐页取（M05 有缓存），先取前 1 页撑起布局，其余异步补齐。
      const pages: PageHandle[] = [];
      for (let p = 1; p <= doc.pageCount; p += 1) {
        pages.push(await doc.getPage(p));
      }
      geo = pages.map((p) => p.geometry);
    };

    void buildViewport().then(() => {
      const publish = () => {
        const viewport: ViewportState = {
          mode,
          scale,
          scrollTop: scroll.scrollTop,
          viewportHeight: scroll.clientHeight,
          viewportWidth: scroll.clientWidth,
          pageGeometries: geo,
        };
        scheduler.setViewport(viewport);
      };
      publish();
      scroll.addEventListener("scroll", publish, { passive: true });
      const onResize = () => publish();
      window.addEventListener("resize", onResize);
      return () => {
        scroll.removeEventListener("scroll", publish);
        window.removeEventListener("resize", onResize);
      };
    });
  }, [doc, mode, scale, scheduler]);

  // 进度回写（节流 1s，由 M12 的端口落库）
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

  // 键盘：翻页/缩放/模式/退出（T21 默认键位）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === "+" || e.key === "=") setScaleState((s) => Math.min(MAX_SCALE, s + 0.1));
        if (e.key === "-") setScaleState((s) => Math.max(MIN_SCALE, s - 0.1));
        return;
      }
      if (e.key === "ArrowRight" || e.key === "PageDown") goToPage(currentPage + 1);
      if (e.key === "ArrowLeft" || e.key === "PageUp") goToPage(currentPage - 1);
      if (e.key.toLowerCase() === "m") setMode((m) => (m === "continuous" ? "single" : "continuous"));
      if (e.key === "Escape") onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const goToPage = useCallback(
    (pageNo: number) => {
      const target = Math.min(Math.max(1, pageNo), Math.max(1, pageCount));
      setCurrentPage(target);
      const scroll = scrollRef.current;
      if (scroll === null || doc === null) return;
      void doc.getPage(1).then(() => {
        const boxes = computePageBoxes(
          Array.from({ length: pageCount }, () => ({ widthPt: 595, heightPt: 842, rotation: 0 as const })),
          scale,
        );
        const box = boxes[target - 1];
        if (box !== undefined) scroll.scrollTop = box.top + 32;
      });
    },
    [doc, pageCount, scale],
  );

  const getSelectionText = useCallback(() => window.getSelection()?.toString() ?? "", []);

  useEffect(() => {
    onApiReady?.({ mode, scale, currentPage, pageCount, setMode, setScale: setScaleState, goToPage, getSelectionText });
  }, [mode, scale, currentPage, pageCount, goToPage, getSelectionText, onApiReady]);

  // 当前页（滚动时更新，供页码胶囊与进度）
  useEffect(() => {
    const scroll = scrollRef.current;
    if (scroll === null || pageCount === 0) return;
    const onScroll = () => {
      const boxes = computePageBoxes(
        Array.from({ length: pageCount }, () => ({ widthPt: 595, heightPt: 842, rotation: 0 as const })),
        scale,
      );
      setCurrentPage(currentPageAt(boxes, scroll.scrollTop, scroll.clientHeight));
    };
    onScroll();
    scroll.addEventListener("scroll", onScroll, { passive: true });
    return () => scroll.removeEventListener("scroll", onScroll);
  }, [pageCount, scale]);

  const visiblePages = useMemo(() => {
    const entries = [...states.values()].filter((s) => s.state === "ready" || s.state === "rendering");
    return entries.sort((a, b) => a.pageNo - b.pageNo);
  }, [states]);

  return (
    <div className="lg-reader" ref={scrollRef} tabIndex={0}>
      {loading ? <p className="lg-reader-status">正在打开…</p> : null}
      {error !== null ? <p className="lg-reader-status">打开失败：{error}</p> : null}
      {visiblePages.map((state) => (
        <PageSlot key={state.pageNo} doc={doc} state={state} scale={scale} />
      ))}
      {/* D16：底部页码胶囊 */}
      <div className="lg-page-capsule">
        {currentPage} / {pageCount}
      </div>
      {/* D15：无工具栏，左右悬浮圆按钮（结构先落地，展开态在 M14 细化） */}
      <button type="button" className="lg-float-btn lg-float-left" title="上一页" onClick={() => goToPage(currentPage - 1)}>
        ‹
      </button>
      <button type="button" className="lg-float-btn lg-float-right" title="下一页" onClick={() => goToPage(currentPage + 1)}>
        ›
      </button>
    </div>
  );
}

interface PageSlotProps {
  doc: DocumentHandle | null;
  state: PageRenderState;
  scale: number;
}

function PageSlot({ doc, state, scale }: PageSlotProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<{ destroy: () => void } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || doc === null) return;
    void (async () => {
      const page = await doc.getPage(state.pageNo);
      const content: TextContentHandle = state.textContent ?? (await page.getTextContent());
      textRef.current?.destroy();
      textRef.current = mountTextLayer(host, content, scale, page.geometry.heightPt);
    })();
    return () => {
      textRef.current?.destroy();
      textRef.current = null;
    };
  }, [doc, state.pageNo, state.textContent, scale]);

  return (
    <div className="lg-page" data-page={state.pageNo} ref={hostRef}>
      {state.canvas !== null ? <CanvasHost canvas={state.canvas} /> : <div className="lg-page-placeholder" />}
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

export { computeVisibleRange };
