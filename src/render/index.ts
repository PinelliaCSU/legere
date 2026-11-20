// M06 公开出口：L3/L4 只能从这里 import。

export { createRenderScheduler, RenderSchedulerImpl } from "./scheduler";
export { BoundedLru } from "./lru";
export {
  JUMP_SPAN_LIMIT,
  PAGE_GAP,
  PREFETCH_TIER,
  PRIORITY_WEIGHTS,
  READER_PADDING,
  SCALE_MISS_MAX,
  anchorScrollTop,
  canvasBytes,
  computePageBoxes,
  computeVisibleRange,
  currentPageAt,
  expandForPrefetch,
  pagePriority,
  pageScore,
  shouldSkipPrefetch,
  totalContentHeight,
  visibleFromViewport,
} from "./layout";
export type { PageBox, PriorityContext } from "./layout";
export { createIdleTextPrefetcher } from "./idle-prefetch";
export type { IdleTextPrefetcher, IdleTextPrefetchOptions } from "./idle-prefetch";
export { DEFAULT_BUDGET } from "./types";
export type {
  PageRenderState,
  PageState,
  ReadMode,
  RenderBudget,
  RenderScheduler,
  TextPrefetchOptions,
  ViewportState,
} from "./types";
