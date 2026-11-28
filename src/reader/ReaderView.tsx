// M07 · 阅读交互层 + M08 文内搜索 UI（docs/03 M07/M08、07 §4.0）。
//
// 性能要点（用户反馈「打开很慢」的直接原因）：
// 原实现先 await 全部页面 getPage() 拿到几何，再开始渲染 —— 300 页的 PDF 等于 300 次串行解析。
// 现在：拿到第 1 页几何就立刻渲染首屏，其余几何分批补齐并渐进更新（见 loadGeometries）。
//
// 2026-11 修订：
// 1. 恢复进度（页码 / 缩放 / 模式）：progress_get 是可选信息，读失败不阻断打开；
// 2. 缩放保持当前页位置（anchorScrollTop），不再「一缩放就回到开头」；
// 3. 文内搜索可取消（切文档 / 关面板后旧结果不再覆盖新状态）；
// 4. 图片扫描页不挂空文本层（避免出现无意义的选择区域）；
// 5. 阅读模式无工具栏（D15），页槽水平居中（block + margin auto，超宽页也不会被挤出可滚动区）。
//
// 2026-11 体验优化（本轮）：
// 6. 阅读选项（缩放/阅读模式/目录/书签）从平铺的底栏收进一个可隐藏的「⋯」入口，默认收起；
// 7. 缩放新增触摸板双指捏合（WebView2 里就是 ctrlKey=true 的 wheel）与触摸屏双指捏合，
//    与原有的 −/+ 按钮、1:1、键盘共用同一套参数（见 ./zoom.ts）。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { API_ERROR_TEXT, isApiErrorCode } from "../contracts/errors";
import { pdfEngine } from "../pdf-engine";
import type { DocumentHandle, PageGeometry, TextContentHandle } from "../pdf-engine/types";
import { anchorScrollTop, createIdleTextPrefetcher, createRenderScheduler, computePageBoxes, currentPageAt, PAGE_GAP, READER_PADDING, type PageRenderState, type ReadMode } from "../render";
import {
  READER_DEFAULT_MODE_KEY,
  READER_DEFAULT_SCALE_KEY,
  parseDefaultMode,
  parseDefaultScale,
} from "../settings/reader-prefs";
import {
  PERF_IDLE_TEXT_PREFETCH_KEY,
  PERF_PRELOAD_DOC_MAX_KEY,
  formatIdleTextPrefetch,
  nextIdleTextPrefetch,
  parseIdleTextPrefetch,
  parsePreloadDocMax,
} from "../settings/perf-prefs";
import { useTheme } from "../theme/ThemeProvider";
import { readerToneClass } from "../theme/theme-prefs";
import { BookmarkDrawer } from "./BookmarkDrawer";
import { OutlineDrawer } from "./OutlineDrawer";
import { mountHighlights } from "./highlight";
import { createIndexYield } from "./index-yield";
import { createSearchTextCache, scanFromOrigin, stepOccurrence, type DocSearchHit, type SearchCursor } from "./search/doc-search";
import { mountTextLayer, type MountedTextLayer } from "./text-layer";
import {
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  fitPageScale,
  fitWidthScale,
  formatScale,
  scaleFromWheel,
  scaleStep,
} from "./zoom";

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
  initialPage?: number;
  onExit: () => void;
  onProgress: (p: { pageNo: number; scrollRatio: number; zoom: number; mode: ReadMode }) => void;
  onApiReady?: (api: ReaderApi) => void;
}

/// 一次双指捏合/滚轮手势结束后，缩放提示气泡保留多久（毫秒）。
const ZOOM_HINT_MS = 900;
const GEO_BATCH = 20;
/// 命中页列表一次最多渲染多少条：1200 页的文档可能有上千个命中页，
/// 全量塞进 DOM 只会让搜索条变成一条几万像素的长条（命中总数仍然如实显示）。
const MAX_HITS_SHOWN = 60;
const EMPTY_RANGES: [number, number][] = [];

function visibleSearchTop(reader: HTMLElement): number {
  const bar = reader.querySelector(".lg-docsearch");
  return Math.max(reader.getBoundingClientRect().top, bar?.getBoundingClientRect().bottom ?? 0);
}

function searchOrigin(reader: HTMLElement, scale: number) {
  const pages = reader.querySelector(".lg-pages")?.children;
  if (!pages?.length) return { pageNo: 1, topY: Infinity };
  const top = visibleSearchTop(reader);
  let low = 0;
  let high = pages.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (pages[mid]!.getBoundingClientRect().bottom <= top) low = mid + 1;
    else high = mid;
  }
  const page = pages[low]!;
  return { pageNo: Number(page.getAttribute("data-page")), topY: (page.getBoundingClientRect().bottom - top) / scale };
}

function errorText(code: string | null): string {
  if (code === null) return "";
  return isApiErrorCode(code) ? API_ERROR_TEXT[code] : "出现内部错误";
}

export function ReaderView({ documentId, initialPage, onExit, onProgress, onApiReady }: ReaderViewProps): ReactElement {
  const scheduler = useMemo(() => createRenderScheduler(), []);
  /// 阅读期间让位给前台：连续交互暂停后台索引，空闲后恢复（P2-2，docs/08 §10）。
  const indexYield = useMemo(() => createIndexYield(), []);
  /// 空闲文本预取的页数（0 = 关闭，默认）。位图预取不在本轮范围内（docs/20 §5）。
  const [idleTextPages, setIdleTextPages] = useState(0);
  /// (待补充) 文档常驻预加载的本数上限：产品参数未定，parse 恒为 0，只做占位。
  const [preloadDocMax, setPreloadDocMax] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [doc, setDoc] = useState<DocumentHandle | null>(null);
  const searchTextCache = useMemo(createSearchTextCache, [doc]);
  const [geos, setGeos] = useState<PageGeometry[]>([]);
  const [mode, setMode] = useState<ReadMode>("continuous");
  const [scale, setScale] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [states, setStates] = useState<ReadonlyMap<number, PageRenderState>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DocSearchHit[]>([]);
  const [activeHit, setActiveHit] = useState<SearchCursor | null>(null);
  const pendingReveal = useRef<SearchCursor | null>(null);
  const searchRun = useRef(0);
  const [submitted, setSubmitted] = useState("");
  const [searchFailed, setSearchFailed] = useState(false);
  const [searching, setSearching] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [outline, setOutline] = useState<{ title: string; pageNo: number | null }[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  /// 阅读选项面板（本轮需求 1）：默认收起，不占版面。
  const [menuOpen, setMenuOpen] = useState(false);
  const { theme, pageTone } = useTheme();

  /// 阅读区内的临时提示（缩放的百分比 / 已复制 / 已回到第 N 页）。
  const [notice, setNotice] = useState<string | null>(null);
  /// 右键呼出功能面板时的落点（null = 用默认的右下角锚点）。
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  /// 全屏阅读（F11 / 面板项）。
  const [fullscreen, setFullscreen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = menuRef.current;
    if (!menuOpen || !menuPos || !panel) return;
    const position = () => {
      panel.style.left = Math.max(8, Math.min(menuPos.x, window.innerWidth - panel.offsetWidth - 8)) + "px";
      panel.style.top = Math.max(8, Math.min(menuPos.y, window.innerHeight - panel.offsetHeight - 8)) + "px";
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(panel);
    window.addEventListener("resize", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      panel.style.removeProperty("left");
      panel.style.removeProperty("top");
    };
  }, [menuOpen, menuPos]);
  const jumpRef = useRef<HTMLInputElement | null>(null);
  /// 面板里的「跳页」输入（长文档没有内置目录时，这是唯一能直达的办法）。
  const [jumpInput, setJumpInput] = useState("");
  /// 搜索命中或上次阅读的页码：等几何补齐到该页后再跳。
  const [resumePage, setResumePage] = useState<number | null>(null);

  /// 页盒子只随「几何 / 缩放」变化重算一次：滚动路径上复用同一份（P0-2）。
  const pageBoxes = useMemo(() => (geos.length === 0 ? [] : computePageBoxes(geos, scale)), [geos, scale]);

  // 打开文档：首屏优先（只等第 1 页几何），其余分批补齐
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setDoc(null);
    setGeos([]);
    setHits([]);
    setActiveHit(null);
    pendingReveal.current = null;
    setSearchOpen(false);
    setSearching(false);
    setQuery("");
    setSubmitted("");
    setSearchFailed(false);
    setOutline([]);
    setResumePage(null);
    setCurrentPage(1);

    void (async () => {
      let handle: DocumentHandle | null = null;
      let opened = false;
      let savedPage = 1;
      try {
        const [{ call }, { CMD }] = await Promise.all([import("../core/ipc"), import("../contracts/cmd")]);

        // 进度是可选信息：读失败（含 DB 不可用）不能挡住打开文档。
        try {
          const progress = await call(CMD.PROGRESS_GET, { documentId });
          if (alive && progress !== null) {
            if (typeof progress.zoom === "number" && progress.zoom >= MIN_SCALE && progress.zoom <= MAX_SCALE) {
              setScale(progress.zoom);
            }
            if (progress.mode === "single" || progress.mode === "continuous") setMode(progress.mode);
            savedPage = progress.pageNo;
          } else if (alive) {
            // 这本书还没有进度：用设置里的「默认阅读模式 / 默认缩放」。
            // 已经读过一次的书不再受默认值影响 —— 用户在书里调过的东西优先。
            try {
              const all = await call(CMD.SETTINGS_GET_ALL, {});
              if (!alive) return;
              const mode = parseDefaultMode(all[READER_DEFAULT_MODE_KEY]);
              if (mode !== null) setMode(mode);
              const scale = parseDefaultScale(all[READER_DEFAULT_SCALE_KEY]);
              if (scale !== null) setScale(clampScale(scale));
            } catch {
              // 默认值读不到就用内置默认（连续 + 100%）。
            }
          }
        } catch {
          // 忽略：进度只是锦上添花。
        }

        if (!alive) return;
        const source = await call(CMD.DOCUMENT_URL, { id: documentId });
        if (!alive) return;
        handle = await pdfEngine.openDocument({ url: source.url, docId: documentId });
        if (!alive) {
          await handle.dispose();
          return;
        }
        const first = await handle.getPage(1);
        if (!alive) {
          await handle.dispose();
          return;
        }
        const target = Math.min(handle.pageCount, Math.max(1, initialPage ?? savedPage));
        opened = true;
        setResumePage(target > 1 ? target : null);
        setDoc(handle);
        setGeos([first.geometry]);
        setLoading(false);
        void call(CMD.DOCUMENT_TOUCH_OPENED, { id: documentId }).catch(() => undefined);

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
      } catch (err) {
        if (!opened) await handle?.dispose();
        if (!alive) return;
        const e = err as { code?: string };
        setError(e.code ?? "E_INTERNAL");
        setLoading(false);
      }
    })();

    return () => {
      alive = false;
      searchRun.current++;
    };
  }, [documentId, initialPage, reloadKey]);

  useEffect(() => () => void doc?.dispose(), [doc]);

  useLayoutEffect(() => {
    scheduler.setDocument(doc);
    const unsubscribe = scheduler.subscribe((next) => setStates(new Map(next)));
    return () => {
      unsubscribe();
      scheduler.setDocument(null);
    };
  }, [doc, scheduler]);

  // The document effect releases jobs, caches and its subscription on unmount.

  // 性能设置（v0.13）：空闲文本预取默认关闭；文档常驻预加载 (待补充) 恒为 0。
  useEffect(() => {
    void (async () => {
      try {
        const [{ call }, { CMD }] = await Promise.all([import("../core/ipc"), import("../contracts/cmd")]);
        const all = await call(CMD.SETTINGS_GET_ALL, {});
        setIdleTextPages(parseIdleTextPrefetch(all[PERF_IDLE_TEXT_PREFETCH_KEY]));
        setPreloadDocMax(parsePreloadDocMax(all[PERF_PRELOAD_DOC_MAX_KEY]));
      } catch {
        // 读不到设置就用内置默认（空闲预取关闭）。
      }
    })();
  }, []);

  const persistIdleTextPrefetch = useCallback((pages: number) => {
    setIdleTextPages(pages);
    void Promise.all([import("../core/ipc"), import("../contracts/cmd")])
      .then(([{ call }, { CMD }]) => call(CMD.SETTINGS_SET, { key: PERF_IDLE_TEXT_PREFETCH_KEY, value: String(pages) }))
      .catch(() => undefined);
  }, []);

  // 空闲文本预取（P2-1）：windowPages = 0 时预取器完全惰性，不排任何空闲回调。
  const idlePrefetcher = useMemo(
    () => createIdleTextPrefetcher(scheduler, { windowPages: idleTextPages }),
    [scheduler, idleTextPages],
  );
  useEffect(() => () => idlePrefetcher.dispose(), [idlePrefetcher]);

  useEffect(() => {
    if (doc === null || idleTextPages === 0) return;
    idlePrefetcher.schedule(currentPage, doc.pageCount);
    return () => idlePrefetcher.cancel();
  }, [currentPage, doc, idlePrefetcher, idleTextPages]);

  // 离开阅读器必须把索引恢复回去（P2-2）。
  useEffect(() => () => indexYield.dispose(), [indexYield]);

  const singlePage = mode === "single" ? currentPage : null;

  // 视口发布 + 当前页：滚动只记位置，计算与调度合并到下一帧（docs/08 §8）。
  // 旧实现每个 scroll 事件都直接 setViewport + 重算当前页：60Hz 滚动 = 每秒 60 次
  // O(页数) 的盒子重算 + 60 次全量状态 Map 拷贝，滚动的大头开销就在这里。
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (doc === null || scroll === null || geos.length === 0) return;
    let raf = 0;
    const flush = (): void => {
      raf = 0;
      const el = scrollRef.current;
      if (el === null) return;
      scheduler.setViewport({
        ...(singlePage === null ? { mode: "continuous" } : { mode: "single", currentPage: singlePage }),
        scale,
        scrollTop: el.scrollTop - (el.querySelector<HTMLElement>(".lg-pages")?.offsetTop ?? READER_PADDING) + READER_PADDING,
        scrollLeft: el.scrollLeft,
        pixelRatio: window.devicePixelRatio || 1,
        viewportHeight: el.clientHeight,
        viewportWidth: el.clientWidth,
        pageGeometries: geos,
      });
      // 单页模式的页码由 currentPage 决定，不能由滚动位置反推（容器里只有一页）。
      if (singlePage === null) {
        const next = currentPageAt(pageBoxes, el.scrollTop, el.clientHeight);
        setCurrentPage((prev) => (prev === next ? prev : next));
      }
    };
    const schedule = (): void => {
      if (raf === 0) raf = window.requestAnimationFrame(flush);
    };
    const onScroll = (): void => {
      indexYield.notifyInteraction();
      schedule();
    };
    flush();
    scroll.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(scroll);
    window.addEventListener("resize", schedule);
    return () => {
      if (raf !== 0) window.cancelAnimationFrame(raf);
      scroll.removeEventListener("scroll", onScroll);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [doc, geos, indexYield, pageBoxes, scale, scheduler, searchOpen, singlePage]);

  // 缩放锚点：保持当前页顶部仍在视口顶部（否则一缩放就跳回开头）。
  const prevScale = useRef(scale);
  useLayoutEffect(() => {
    const before = prevScale.current;
    prevScale.current = scale;
    const scroll = scrollRef.current;
    if (before === scale || scroll === null || geos.length === 0) return;
    if (mode === "single") {
      scroll.scrollTop = Math.max(0, (scroll.scrollTop - READER_PADDING) * scale / before + READER_PADDING);
      return;
    }
    scroll.scrollTop = anchorScrollTop(computePageBoxes(geos, before), currentPage, 0, scale, geos);
  }, [scale, geos, currentPage, mode]);

  // 单页 -> 连续：把当前页滚回视口顶部（否则切回来后停在第 1 页，位置全丢）。
  const prevMode = useRef(mode);
  useLayoutEffect(() => {
    const before = prevMode.current;
    prevMode.current = mode;
    if (before === mode || mode !== "continuous") return;
    const scroll = scrollRef.current;
    if (scroll === null || geos.length === 0) return;
    const box = pageBoxes[currentPage - 1];
    if (box !== undefined) scroll.scrollTop = box.top + READER_PADDING;
  }, [mode, geos.length, pageBoxes, currentPage]);

  useEffect(() => {
    if (doc === null || resumePage !== null) return;
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
  }, [doc, currentPage, resumePage, scale, mode, onProgress]);

  const goToPage = useCallback(
    (pageNo: number) => {
      const target = Math.min(Math.max(1, pageNo), Math.max(1, doc?.pageCount ?? 1));
      setCurrentPage(target);
      const scroll = scrollRef.current;
      if (scroll === null) return;
      // 单页模式只挂载当前页，滚动几何是全文档的；用它算 scrollTop 会被浏览器夹回顶部，
      // 再被 scroll 监听反推回第 1 页（实测「搜索跳页后又回到第 1 页」就是这条路径）。
      if (mode === "single") {
        scroll.scrollTop = 0;
        return;
      }
      if (geos.length === 0) return;
      const box = pageBoxes[target - 1];
      if (box !== undefined) scroll.scrollTop = box.top + READER_PADDING;
    },
    [doc, geos.length, mode, pageBoxes],
  );


  /// 原生监听回调里读不到最新的 scale（闭包会过期），所以镜像一份到 ref。
  const scaleRef = useRef(scale);
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  const noticeTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), ZOOM_HINT_MS);
  }, []);


  /// 手势/键盘缩放统一走这里：夹取 + 立刻显示百分比气泡（面板收起时这是唯一的反馈）。
  const applyScale = useCallback(
    (next: number) => {
      const clamped = clampScale(next);
      setScale(clamped);
      showNotice(formatScale(clamped));
    },
    [showNotice],
  );
  // 恢复进度：几何补齐到目标页后跳一次（只跳一次，避免用户翻页后被拽回）。
  useEffect(() => {
    if (resumePage === null) return;
    if (geos.length < resumePage) return;
    goToPage(resumePage);
    showNotice("已回到第 " + resumePage + " 页");
    setResumePage(null);
  }, [geos.length, resumePage, goToPage, showNotice]);

  /// 全屏阅读：用 Tauri 的窗口 API，不改任何后端契约。
  const toggleFullscreen = useCallback(async () => {
    const next = !fullscreen;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setFullscreen(next);
      setFullscreen(next);
      showNotice(next ? "已进入全屏，Esc 退出阅读" : "已退出全屏");
    } catch (err) {
      // 全屏失败不该打断阅读：提示一句即可（受限环境/权限不足时会走到这里）。
      console.warn("切换全屏失败", err);
      showNotice("当前环境不支持全屏");
    }
  }, [fullscreen, showNotice]);

  // 离开阅读器时一定退出全屏，别把用户锁在全屏窗口里。
  useEffect(
    () => () => {
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().setFullscreen(false))
        .catch(() => undefined);
    },
    [],
  );

  // 复制选中文字后给一句「已复制」（docs/16 §6 的第 3 条文案，之前没接）。
  useEffect(() => {
    const onCopy = (): void => {
      if ((window.getSelection()?.toString() ?? "").length > 0) showNotice("已复制");
    };
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, [showNotice]);

  /// 一键适应：按**当前页几何**与**阅读区实际尺寸**算一个合适比例。
  /// 之前只能按 10% 步进去凑，读者要试好几次才刚好放下。
  const applyFit = useCallback(
    (kind: "width" | "page") => {
      const host = scrollRef.current;
      const geo = geos[currentPage - 1] ?? geos[0];
      if (host === null || geo === undefined) return;
      const next =
        kind === "width"
          ? fitWidthScale(geo.widthPt, host.clientWidth)
          : fitPageScale(geo.widthPt, geo.heightPt, host.clientWidth, host.clientHeight);
      applyScale(next);
    },
    [applyScale, currentPage, geos],
  );

  const jumpToInput = useCallback(() => {
    const pageNo = Number.parseInt(jumpInput.trim(), 10);
    if (!Number.isFinite(pageNo)) return;
    goToPage(pageNo);
    setJumpInput("");
    setMenuOpen(false);
  }, [goToPage, jumpInput]);

  /// 文内搜索：逐页取文本并即时匹配。
  /// 文本统一走 scheduler.getTextContent（P0-3）：与渲染/文本层共用同一份字节预算 LRU，
  /// 第二次同样的搜索不再重新解析；也不再一次性把整本 300 页文本攒进数组。
  /// 可取消：切文档 / 关面板后，旧一轮的结果不再写回 state。
  const resetSearch = useCallback(() => {
    searchRun.current++;
    pendingReveal.current = null;
    setActiveHit(null);
    setHits([]);
    setSubmitted("");
    setSearching(false);
    setSearchFailed(false);
  }, []);

  const selectHit = useCallback((cursor: SearchCursor) => {
    pendingReveal.current = cursor;
    setResumePage(null);
    setActiveHit(cursor);
  }, []);

  useLayoutEffect(() => {
    if (mode === "single" && activeHit && pendingReveal.current === activeHit) setCurrentPage(activeHit.pageNo);
  }, [mode, activeHit]);

  const runSearch = async () => {
    resetSearch();
    const reader = scrollRef.current;
    if (!doc || !reader || !query.trim()) return;
    const run = searchRun.current;
    const cancelled = () => searchRun.current !== run;
    const origin = searchOrigin(reader, scale);
    setSubmitted(query);
    setSearching(true);
    const found: DocSearchHit[] = [];
    let selected = false;
    let lastUpdate = performance.now();
    try {
      for await (const { page, firstAhead } of scanFromOrigin(doc.pageCount, origin, query, requestText, cancelled, searchTextCache)) {
        if (cancelled()) return;
        found.push(page);
        if (!selected && firstAhead >= 0) {
          selected = true;
          setHits([...found]);
          selectHit({ pageNo: page.pageNo, rangeIndex: firstAhead });
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        } else if (selected && performance.now() - lastUpdate >= 32) {
          setHits([...found]);
          lastUpdate = performance.now();
        }
      }
      if (cancelled()) return;
      setHits(found);
      if (!selected && found[0]) selectHit({ pageNo: found[0].pageNo, rangeIndex: 0 });
    } catch {
      if (!cancelled()) {
        setHits(found);
        setSearchFailed(true);
      }
    } finally {
      if (!cancelled()) setSearching(false);
    }
  };

  const closeSearch = useCallback(() => {
    resetSearch();
    setSearchOpen(false);
  }, [resetSearch]);

  const stepHit = (delta: 1 | -1) => {
    const cursor = pendingReveal.current ?? activeHit;
    if (cursor) selectHit(stepOccurrence(hits, cursor, delta));
  };

  const revealHighlight = useCallback((cursor: SearchCursor, boxes: DOMRect[]) => {
    const reader = scrollRef.current;
    if (!reader || pendingReveal.current !== cursor) return;
    pendingReveal.current = null;
    const first = boxes[0];
    if (!first) return;
    const viewport = reader.getBoundingClientRect();
    const top = visibleSearchTop(reader);
    // Include both lines of a wrapped phrase, keeping its first line in view for very long matches.
    const bounds = boxes.reduce((r, b) => ({
      top: Math.min(r.top, b.top), bottom: Math.max(r.bottom, b.bottom),
      left: Math.min(r.left, b.left), right: Math.max(r.right, b.right),
    }), { top: first.top, bottom: first.bottom, left: first.left, right: first.right });
    const height = viewport.bottom - top;
    if (bounds.top < top || bounds.bottom > viewport.bottom) {
      const margin = Math.max(0, (height - (bounds.bottom - bounds.top)) / 3);
      reader.scrollTop += bounds.top - top - margin;
    }
    if (bounds.left < viewport.left || bounds.right > viewport.right) {
      const left = bounds.right - bounds.left > reader.clientWidth ? first.left : bounds.left;
      reader.scrollLeft += left - viewport.left;
    }
  }, []);

  // 键盘：Ctrl+F 文内搜索，Ctrl± 缩放，翻页/模式/退出
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      indexYield.notifyInteraction();
      const target = e.target as HTMLElement | null;
      const typing = target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === "f") {
          e.preventDefault();
          setSearchOpen(true);
          return;
        }
        if (typing) return;
        if (e.key === "+" || e.key === "=") applyScale(scaleStep(scaleRef.current, 1));
        if (e.key === "-") applyScale(scaleStep(scaleRef.current, -1));
        if (e.key === "0") applyScale(1);
        return;
      }
      if (e.key === "Escape") {
        if (searchOpen) closeSearch();
        else if (bookmarksOpen) setBookmarksOpen(false);
        else if (outlineOpen) setOutlineOpen(false);
        else if (menuOpen) setMenuOpen(false);
        else onExit();
        return;
      }
      if (typing) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") goToPage(currentPage + 1);
      if (e.key === "ArrowLeft" || e.key === "PageUp") goToPage(currentPage - 1);
      if (e.key.toLowerCase() === "m") setMode((m) => (m === "continuous" ? "single" : "continuous"));
      // 空格翻页：阅读器里最顺手的一个键（Shift+空格 回退）。
      if (e.key === " " || e.code === "Space") {
        if (target instanceof Element && target.closest("button, summary")) return;
        e.preventDefault();
        goToPage(currentPage + (e.shiftKey ? -1 : 1));
        return;
      }
      // B 打开书签（docs/14 T21 的键位表里已登记，之前没实现）。
      if (e.key.toLowerCase() === "b") setBookmarksOpen((open) => !open);
      // T 打开目录（只在这本文档真的有内置目录时才响应）。
      if (e.key.toLowerCase() === "t" && outline.length > 0) setOutlineOpen((open) => !open);
      if (e.key === "F11") {
        e.preventDefault();
        void toggleFullscreen();
      }
      // 不带 Ctrl 的 +/-/0 也能缩放（阅读器里最常用的三个键，和多数阅读软件一致）。
      if (e.key === "+" || e.key === "=") applyScale(scaleStep(scaleRef.current, 1));
      if (e.key === "-") applyScale(scaleStep(scaleRef.current, -1));
      if (e.key === "0") applyScale(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyScale, bookmarksOpen, closeSearch, currentPage, goToPage, indexYield, menuOpen, onExit, outline.length, outlineOpen, searchOpen, toggleFullscreen]);

  // 阅读页的右键 = 呼出本页的功能面板，而不是 WebView 自带的「重新加载/另存为/检查」。
  //
  // 为什么用 contextmenu 而不是"屏蔽右键"：屏蔽只会让用户什么都没有；
  // 这里把它换成阅读器自己的菜单，行为与左下角「⋯」完全一致。
  // 输入框（搜索、跳页）内不拦截，保留系统的粘贴/选择菜单。
  useEffect(() => {
    const host = scrollRef.current;
    if (host === null) return;
    const onContextMenu = (event: MouseEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select") !== null) return;
      event.preventDefault();
      setMenuPos({ x: event.clientX, y: event.clientY });
      setMenuOpen(true);
    };
    host.addEventListener("contextmenu", onContextMenu);
    return () => host.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Ctrl + 滚轮缩放（鼠标快捷键）。
  //
  // 触摸板双指捏合的多指手势识别已删除：平台的捏合在部分触摸板驱动下根本不会投递给页面，
  // 留着只是死代码，也让「为什么还是没反应」无从解释。这里只保留鼠标能确认可用的这一条。
  // 为什么不用 React 的 onWheel：React 在根节点上是**被动**监听，preventDefault 无效，
  // 会连带把整个 WebView 页面缩放掉，所以挂在滚动容器上并显式 passive: false。
  useEffect(() => {
    const host = scrollRef.current;
    if (host === null) return;
    const onWheel = (event: WheelEvent): void => {
      indexYield.notifyInteraction();
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      applyScale(scaleFromWheel(scaleRef.current, event.deltaY, event.deltaMode));
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [applyScale, indexYield]);

  // 放大后没有抓手只能拖滚动条：中键（滚轮键）按住拖动即可平移页面。
  // 为什么不用左键拖动：会抢走文本选择；为什么不用空格+左键：空格已经承担翻页。
  useEffect(() => {
    const host = scrollRef.current;
    if (host === null) return;
    let pan: { x: number; y: number; left: number; top: number } | null = null;

    const suppressMiddleAutoscroll = (event: MouseEvent | PointerEvent): void => {
      if (event.button === 1) event.preventDefault();
    };
    const onDown = (event: PointerEvent): void => {
      if (event.button !== 1) return;
      event.preventDefault();
      pan = { x: event.clientX, y: event.clientY, left: host.scrollLeft, top: host.scrollTop };
      host.classList.add("is-panning");
      host.setPointerCapture(event.pointerId);
    };
    const onMove = (event: PointerEvent): void => {
      if (pan === null) return;
      host.scrollLeft = pan.left - (event.clientX - pan.x);
      host.scrollTop = pan.top - (event.clientY - pan.y);
    };
    const onUp = (event: PointerEvent): void => {
      if (pan === null) return;
      pan = null;
      host.classList.remove("is-panning");
      if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
    };

    host.addEventListener("mousedown", suppressMiddleAutoscroll);
    host.addEventListener("pointerdown", onDown);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerup", onUp);
    host.addEventListener("pointercancel", onUp);
    return () => {
      host.removeEventListener("mousedown", suppressMiddleAutoscroll);
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerup", onUp);
      host.removeEventListener("pointercancel", onUp);
    };
  }, []);

  // 点空白处收起阅读选项面板（面板是浮层，不该拦着阅读）。
  useEffect(() => {
    if (!menuOpen) return;
    const host = scrollRef.current;
    if (host === null) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".lg-reader-menu") !== null) return;
      if (target.closest(".lg-reader-menu-btn") !== null) return;
      // 点页码胶囊是「打开面板跳页」，不能被当成点空白。
      if (target.closest(".lg-page-capsule") !== null) return;
      setMenuOpen(false);
    };
    host.addEventListener("pointerdown", onDown);
    return () => host.removeEventListener("pointerdown", onDown);
  }, [menuOpen]);

  const getSelectionText = useCallback(() => window.getSelection()?.toString() ?? "", []);

  /// 文本层与搜索都从这里取文本：缓存所有权在调度器，组件不再自己碰 pdf.js。
  const requestText = useCallback((pageNo: number) => scheduler.getTextContent(pageNo), [scheduler]);

  useEffect(() => {
    onApiReady?.({ mode, scale, currentPage, pageCount: doc?.pageCount ?? 0, setMode, setScale, goToPage, getSelectionText });
  }, [mode, scale, currentPage, doc?.pageCount, goToPage, getSelectionText, onApiReady]);

  const slotPages = useMemo(() => {
    if (geos.length === 0) return [];
    if (mode === "single") return [currentPage];
    return Array.from({ length: geos.length }, (_, i) => i + 1);
  }, [geos.length, mode, currentPage]);

  const activePage = hits.find((page) => page.pageNo === activeHit?.pageNo);
  const hitCount = hits.reduce((sum, page) => sum + page.ranges.length, 0);
  const ordinal = activeHit === null ? 0 : activeHit.rangeIndex + 1 +
    hits.reduce((sum, page) => sum + (page.pageNo < activeHit.pageNo ? page.ranges.length : 0), 0);

  return (
    <div
      className={
        "lg-reader" +
        // 深色主题下的页面色调（不处理 / 调暗 / 反色）：只改 canvas 的呈现，不动像素数据。
        (readerToneClass(theme, pageTone) === "" ? "" : " " + readerToneClass(theme, pageTone))
      }
      ref={scrollRef}
      tabIndex={0}
    >
      {loading ? <p className="lg-reader-status">正在打开…</p> : null}
      {error !== null ? (
        <div className="lg-reader-status lg-reader-failed">
          <p>{errorText(error)}</p>
          <button
            type="button"
            className="lg-btn"
            onClick={() => {
              setReloadKey((k) => k + 1);
            }}
          >
            重试
          </button>
          <button type="button" className="lg-btn" onClick={onExit}>
            返回主页
          </button>
        </div>
      ) : null}

      {searchOpen ? (
        <div className="lg-docsearch">
          <input
            autoFocus
            placeholder="在本文中搜索，回车执行"
            value={query}
            onChange={(e) => {
              resetSearch();
              setQuery(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              e.preventDefault();
              if (!submitted || searchFailed) void runSearch();
              else stepHit(e.shiftKey ? -1 : 1);
            }}
          />
          <span className="lg-muted">
            {searchFailed ? "搜索中断，回车重试" : searching ? "搜索中…" : submitted && !hitCount ? "未找到「" + submitted + "」" : ""}
          </span>
          {activeHit ? (
            <>
              <button type="button" className="lg-btn" title="上一个命中（Shift+Enter）" onClick={() => stepHit(-1)}>上一处</button>
              <button type="button" className="lg-btn" title="下一个命中（Enter）" onClick={() => stepHit(1)}>下一处</button>
              <span className="lg-muted">{ordinal}/{hitCount} 处</span>
            </>
          ) : null}
          <button type="button" className="lg-btn" onClick={closeSearch}>关闭</button>
          {hits.length > 0 ? (
            <ul className="lg-docsearch-list">
              {hits.slice(0, MAX_HITS_SHOWN).map((hit) => (
                <li key={hit.pageNo}>
                  <button
                    type="button"
                    className={hit.pageNo === activeHit?.pageNo ? "is-active" : ""}
                    onClick={() => selectHit({ pageNo: hit.pageNo, rangeIndex: 0 })}
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
              requestText={requestText}
              pageNo={pageNo}
              geometry={geo}
              scale={scale}
              state={states.get(pageNo)}
              highlights={pageNo === activePage?.pageNo ? activePage.ranges : EMPTY_RANGES}
              cursor={activeHit?.pageNo === pageNo ? activeHit : null}
              revealHighlight={revealHighlight}
              mountText={Math.abs(pageNo - currentPage) <= 2}
              onRetry={() => scheduler.retry(pageNo)}
            />
          );
        })}
      </div>

      <button type="button" className="lg-reader-back" title="返回主页" onClick={onExit}>
        <span className="lg-arrow lg-arrow-back" aria-hidden="true" />主页
      </button>
      <div className="lg-reader-dock" role="group" aria-label="阅读导航">
        <button type="button" title="上一页" aria-label="上一页" disabled={!doc || currentPage <= 1}
          onClick={() => goToPage(currentPage - 1)}>
          <span className="lg-arrow" aria-hidden="true" />
        </button>
        {doc ? (
          <button type="button" className="lg-page-capsule" title="跳页" aria-label={`第 ${currentPage} 页，共 ${doc.pageCount} 页，跳页`}
            onClick={() => {
              setMenuPos(null);
              setMenuOpen(true);
              window.requestAnimationFrame(() => jumpRef.current?.focus());
            }}>
            <b>{currentPage}</b><span aria-hidden="true">/</span>{doc.pageCount}
          </button>
        ) : null}
        <button type="button" title="下一页" aria-label="下一页" disabled={!doc || currentPage >= doc.pageCount}
          onClick={() => goToPage(currentPage + 1)}>
          <span className="lg-arrow lg-arrow-next" aria-hidden="true" />
        </button>
        <button type="button" className="lg-reader-menu-btn" title="阅读选项" aria-label="阅读选项"
          aria-haspopup="menu" aria-expanded={menuOpen} aria-controls="lg-reader-menu"
          onClick={() => { setMenuPos(null); setMenuOpen((open) => !open); }}>
          <span className="lg-more-dots" aria-hidden="true" />
        </button>
      </div>

      {menuOpen ? (
        <div
          className={"lg-reader-menu" + (menuPos ? " at-pointer" : "")}
          id="lg-reader-menu"
          role="menu"
          aria-label="阅读选项"
          ref={menuRef}
        >
          <div className="lg-reader-menu-row">
            <span className="lg-reader-menu-label">缩放</span>
            <button type="button" className="lg-reader-menu-step" title="缩小（-）" onClick={() => applyScale(scaleStep(scaleRef.current, -1))}>
              −
            </button>
            <span className="lg-reader-menu-value">{formatScale(scale)}</span>
            <button type="button" className="lg-reader-menu-step" title="放大（+）" onClick={() => applyScale(scaleStep(scaleRef.current, 1))}>
              +
            </button>
            <button type="button" className="lg-reader-menu-item" title="恢复默认（0）" onClick={() => applyScale(1)}>
              1:1
            </button>
          </div>
          <div className="lg-reader-menu-pair">
            <button type="button" className="lg-reader-menu-fit" title="让页面宽度刚好填满阅读区" onClick={() => applyFit("width")}>
              适应宽度
            </button>
            <button type="button" className="lg-reader-menu-fit" title="整页放进阅读区（适合单页翻阅）" onClick={() => applyFit("page")}>
              适应页面
            </button>
          </div>
          <button
            type="button"
            role="menuitem"
            className="lg-reader-menu-item"
            title="切换阅读模式（M）"
            onClick={() => setMode((m) => (m === "continuous" ? "single" : "continuous"))}
          >
            {mode === "continuous" ? "切到单页翻页" : "切到连续滚动"}
            <kbd>M</kbd>
          </button>
          <div className="lg-reader-menu-pair">
            <input
              ref={jumpRef}
              className="lg-reader-menu-input"
              type="number"
              min={1}
              max={doc?.pageCount ?? undefined}
              placeholder="页码"
              value={jumpInput}
              onChange={(e) => setJumpInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") jumpToInput();
                if (e.key === "Escape") setMenuOpen(false);
              }}
            />
            <button type="button" className="lg-reader-menu-fit" title="跳到输入的页码" onClick={jumpToInput}>
              跳页
            </button>
          </div>
          <button
            type="button"
            role="menuitem"
            className="lg-reader-menu-item"
            title="在本文中搜索（Ctrl+F）"
            onClick={() => {
              setSearchOpen(true);
              setMenuOpen(false);
            }}
          >
            搜索
            <kbd>Ctrl F</kbd>
          </button>
          {outline.length > 0 ? (
            <button
              type="button"
              role="menuitem"
              className="lg-reader-menu-item"
              onClick={() => {
                setOutlineOpen((open) => !open);
                setMenuOpen(false);
              }}
            >
              目录
              <kbd>T</kbd>
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="lg-reader-menu-item"
            onClick={() => {
              setBookmarksOpen((open) => !open);
              setMenuOpen(false);
            }}
          >
            书签
            <kbd>B</kbd>
          </button>
          <button type="button" role="menuitem" className="lg-reader-menu-item" onClick={() => void toggleFullscreen()}>
            {fullscreen ? "退出全屏" : "全屏阅读"}
            <kbd>F11</kbd>
          </button>
          <details className="lg-reader-performance">
            <summary>性能选项</summary>
            <button
              type="button"
              role="menuitem"
              className="lg-reader-menu-item"
              title="空闲时向前预取文本，让搜索更快（默认关闭）"
              onClick={() => persistIdleTextPrefetch(nextIdleTextPrefetch(idleTextPages))}
            >
              空闲预取文本
              <kbd>{formatIdleTextPrefetch(idleTextPages)}</kbd>
            </button>
            <button
              type="button"
              role="menuitem"
              className="lg-reader-menu-item"
              disabled
              title="(待补充) 产品参数未定：常驻几本 / 内存上限"
            >
              预加载下一篇
              <kbd>{preloadDocMax <= 0 ? "未启用" : preloadDocMax + " 篇"}</kbd>
            </button>
          </details>
          <p className="lg-reader-menu-hint">Ctrl+滚轮可缩放</p>
        </div>
      ) : null}

      {notice !== null ? <div className="lg-reader-notice">{notice}</div> : null}

      {(doc?.pageCount ?? 0) > 0 ? (
        <div className="lg-reader-progress" aria-hidden="true">
          <span style={{ width: Math.round((currentPage / Math.max(1, doc?.pageCount ?? 1)) * 100) + "%" }} />
        </div>
      ) : null}

      {outlineOpen && outline.length > 0 ? (
        <OutlineDrawer outline={outline} onJump={(pageNo) => goToPage(pageNo)} onClose={() => setOutlineOpen(false)} />
      ) : null}

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
  pageNo: number;
  geometry: PageGeometry;
  scale: number;
  state: PageRenderState | undefined;
  highlights: [number, number][];
  cursor: SearchCursor | null;
  revealHighlight: (cursor: SearchCursor, boxes: DOMRect[]) => void;
  /// 是否挂文本层：只给当前页附近，避免一次打开发起 N 次 getTextContent（性能关键）。
  mountText: boolean;
  /// 取页文本：走调度器的共享缓存（P0-3），组件不再直接调用引擎。
  requestText: (pageNo: number) => Promise<TextContentHandle>;
  onRetry: () => void;
}

function PageSlot({
  pageNo,
  geometry,
  scale,
  state,
  highlights,
  cursor,
  revealHighlight,
  mountText,
  requestText,
  onRetry,
}: PageSlotProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<MountedTextLayer | null>(null);
  const mountedRef = useRef<{ content: TextContentHandle; scale: number; heightPt: number } | null>(null);
  const detachGuard = useRef<(() => void) | null>(null);
  const width = Math.round(geometry.widthPt * scale);
  const height = Math.round(geometry.heightPt * scale);

  /// 选区还落在本页的文本层里吗：卸层会把选区连同节点一起抽走，所以要等它先散。
  const holdsSelection = (): boolean => {
    const container = textRef.current?.container;
    if (container === undefined) return false;
    const sel = window.getSelection();
    if (sel === null || sel.rangeCount === 0 || sel.isCollapsed) return false;
    return container.contains(sel.anchorNode) || container.contains(sel.focusNode);
  };

  const dropLayer = (): void => {
    textRef.current?.destroy();
    textRef.current = null;
    mountedRef.current = null;
  };

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    detachGuard.current?.();
    detachGuard.current = null;
    if (!mountText) {
      // 远离当前页：卸掉文本层，释放 DOM 与文本内容；选区还在这页上时先留着，散开后再卸。
      if (textRef.current === null || !holdsSelection()) {
        dropLayer();
        return;
      }
      const onSelectionChange = (): void => {
        if (holdsSelection()) return;
        detachGuard.current?.();
        detachGuard.current = null;
        dropLayer();
      };
      document.addEventListener("selectionchange", onSelectionChange);
      detachGuard.current = () => document.removeEventListener("selectionchange", onSelectionChange);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const content = await requestText(pageNo);
        if (cancelled) return;
        const mounted = mountedRef.current;
        // 同一份文本、同一比例已经挂好了就不再重挂：文本迟到或状态补丁会把节点整体换掉，
        // 正在拖的选区会在没有任何可见原因的情况下消失。
        if (
          textRef.current !== null &&
          mounted !== null &&
          mounted.content === content &&
          mounted.scale === scale &&
          mounted.heightPt === geometry.heightPt
        ) {
          return;
        }
        // 没有可见字符的页不挂文本层（16 §2）：扫描页是这样，字体缺 Unicode 映射时 pdfjs 也可能
        // 只给出空串 item —— 那种情况下去挂层会留下一层透明、吃指针事件却选不出任何东西的容器。
        if (!content.items.some((item) => item.str.trim().length > 0)) {
          dropLayer();
          return;
        }
        textRef.current?.destroy();
        textRef.current = mountTextLayer(host, content, scale, geometry.heightPt);
        mountedRef.current = { content, scale, heightPt: geometry.heightPt };
      } catch (err) {
        console.warn("文本层挂载失败", pageNo, err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pageNo, requestText, scale, geometry.heightPt, mountText]);

  // 只有卸载（切页、换文档、退出阅读器）才真的销毁文本层；挂载/更新路径靠上面的判断复用旧层。
  useEffect(
    () => () => {
      detachGuard.current?.();
      detachGuard.current = null;
      dropLayer();
    },
    [],
  );

  // 高亮：当前命中页的命中区间
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !cursor || !highlights.length) return;
    let cancelled = false;
    let unmount: (() => void) | undefined;
    void requestText(pageNo).then((content) => {
      if (cancelled) return;
      unmount = mountHighlights(host, content, highlights, cursor.rangeIndex, scale, geometry.heightPt);
      const boxes = host.querySelectorAll("[data-active-hit]");
      revealHighlight(cursor, Array.from(boxes, (box) => box.getBoundingClientRect()));
    }).catch((err) => console.warn("搜索高亮失败", pageNo, err));
    return () => {
      cancelled = true;
      unmount?.();
    };
  }, [cursor, highlights, pageNo, requestText, scale, geometry.heightPt, revealHighlight]);

  return (
    <div className="lg-page" data-page={pageNo} ref={hostRef} style={{ width, height, marginBottom: PAGE_GAP }}>
      {state?.tiles.map(tile => (
        <CanvasHost key={tile.key} canvas={tile.canvas} bounds={tile.bounds} />
      ))}
      {!state?.tiles.length || state.error ? (
        <div className="lg-page-placeholder">
          {state?.state === "error" ? (
            <>
              <span>{errorText(state.error?.code ?? null)}</span>
              <button type="button" className="lg-btn" onClick={onRetry}>重试</button>
            </>
          ) : (
            <span>加载中…</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

function CanvasHost({ canvas, bounds }: {
  canvas: HTMLCanvasElement;
  bounds: { x: number; y: number; w: number; h: number };
}): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (host === null) return;
    host.appendChild(canvas);
    return () => {
      if (canvas.parentElement === host) host.removeChild(canvas);
    };
  }, [canvas]);
  return <div className="lg-page-canvas" ref={ref} style={{
    left: bounds.x * 100 + "%", top: bounds.y * 100 + "%",
    width: bounds.w * 100 + "%", height: bounds.h * 100 + "%",
  }} />;
}
