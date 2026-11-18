// M07 · 阅读交互层（docs/03 M07、07 §4.0）。
//
// 关键修复（2026-11-18）：页面槽必须有显式宽高。原实现槽高为 0，canvas 绝对定位在零高容器里，
// 于是「只看到测试页、没有实际页面」。现在页槽尺寸由 PageGeometry × scale 决定。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { pdfEngine } from "../pdf-engine";
import type { DocumentHandle, PageGeometry, PageHandle, TextContentHandle } from "../pdf-engine/types";
import { createRenderScheduler, computePageBoxes, currentPageAt, PAGE_GAP, READER_PADDING, type PageRenderState, type ReadMode } from "../render";
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

  // 打开文档：URL -> 引擎 -> 页几何（一次取全，用于布局与调度）
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setDoc(null);
    setGeos([]);
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
        const pages: PageHandle[] = [];
        for (let p = 1; p <= handle.pageCount; p += 1) pages.push(await handle.getPage(p));
        if (!alive) {
          await handle.dispose();
          return;
        }
        setDoc(handle);
        setGeos(pages.map((page) => page.geometry));
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

  // 释放旧文档（契约 R4：换文档即释放）
  useEffect(() => () => void doc?.dispose(), [doc]);

  // 调度器挂接 + 订阅
  useEffect(() => {
    scheduler.setDocument(doc);
    const unsubscribe = scheduler.subscribe((next) => setStates(new Map(next)));
    return () => {
      unsubscribe();
      scheduler.setDocument(null);
    };
  }, [doc, scheduler]);

  // 视口发布（滚动/resize/缩放/模式变化都重发）
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

  // 当前页（用于页码胶囊与进度）
  useEffect(() => {
    const scroll = scrollRef.current;
    if (scroll === null || geos.length === 0) return;
    const onScroll = () => {
      const boxes = computePageBoxes(geos, scale);
      setCurrentPage(currentPageAt(boxes, scroll.scrollTop, scroll.clientHeight));
    };
    onScroll();
    scroll.addEventListener("scroll", onScroll, { passive: true });
    return () => scroll.removeEventListener("scroll", onScroll);
  }, [geos, scale]);

  // 进度回写（节流 1s）
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
      const total = Math.max(1, geos.length);
      const target = Math.min(Math.max(1, pageNo), total);
      setCurrentPage(target);
      const scroll = scrollRef.current;
      if (scroll === null || geos.length === 0) return;
      const boxes = computePageBoxes(geos, scale);
      const box = boxes[target - 1];
      if (box !== undefined) scroll.scrollTop = box.top + READER_PADDING;
    },
    [geos, scale],
  );

  // 键盘（T21）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === "+" || e.key === "=") setScale((s) => Math.min(MAX_SCALE, Number((s + 0.1).toFixed(2))));
        if (e.key === "-") setScale((s) => Math.max(MIN_SCALE, Number((s - 0.1).toFixed(2))));
        return;
      }
      if (e.key === "ArrowRight" || e.key === "PageDown") goToPage(currentPage + 1);
      if (e.key === "ArrowLeft" || e.key === "PageUp") goToPage(currentPage - 1);
      if (e.key.toLowerCase() === "m") setMode((m) => (m === "continuous" ? "single" : "continuous"));
      if (e.key === "Escape") onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentPage, goToPage, onExit]);

  const getSelectionText = useCallback(() => window.getSelection()?.toString() ?? "", []);

  useEffect(() => {
    onApiReady?.({ mode, scale, currentPage, pageCount: geos.length, setMode, setScale, goToPage, getSelectionText });
  }, [mode, scale, currentPage, geos.length, goToPage, getSelectionText, onApiReady]);

  // 渲染哪些槽：连续模式全页（虚拟化交给调度器），单页模式只给当前页
  const slotPages = useMemo(() => {
    if (geos.length === 0) return [];
    if (mode === "single") return [currentPage];
    return Array.from({ length: geos.length }, (_, i) => i + 1);
  }, [geos.length, mode, currentPage]);

  return (
    <div className="lg-reader" ref={scrollRef} tabIndex={0}>
      {loading ? <p className="lg-reader-status">正在打开…</p> : null}
      {error !== null ? <p className="lg-reader-status">打开失败：{error}</p> : null}
      <div className="lg-pages">
        {slotPages.map((pageNo) => {
          const geo = geos[pageNo - 1];
          if (geo === undefined) return null;
          const state = states.get(pageNo);
          return (
            <PageSlot
              key={pageNo}
              doc={doc}
              pageNo={pageNo}
              geometry={geo}
              scale={scale}
              state={state}
            />
          );
        })}
      </div>
      <div className="lg-page-capsule">
        {currentPage} / {geos.length}
      </div>
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
  pageNo: number;
  geometry: PageGeometry;
  scale: number;
  state: PageRenderState | undefined;
}

function PageSlot({ doc, pageNo, geometry, scale, state }: PageSlotProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<{ destroy: () => void } | null>(null);
  const width = Math.round(geometry.widthPt * scale);
  const height = Math.round(geometry.heightPt * scale);

  // 文本层：位图未就绪也先挂（可先选择、先搜索）
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || doc === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await doc.getPage(pageNo);
        const content: TextContentHandle = state?.textContent ?? (await page.getTextContent());
        if (cancelled) return;
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
  }, [doc, pageNo, scale, geometry.heightPt, state?.textContent]);

  return (
    <div
      className="lg-page"
      data-page={pageNo}
      ref={hostRef}
      style={{ width, height, marginBottom: PAGE_GAP }}
    >
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