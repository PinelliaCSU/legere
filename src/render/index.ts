// M06 公开出口：L3/L4 只能从这里 import。

export { createRenderScheduler, RenderSchedulerImpl } from "./scheduler";
export { BoundedLru } from "./lru";
export {
  PAGE_GAP,
  READER_PADDING,
  anchorScrollTop,
  canvasBytes,
  computePageBoxes,
  computeVisibleRange,
  currentPageAt,
  expandForPrefetch,
  pagePriority,
  totalContentHeight,
  visibleFromViewport,
} from "./layout";
export type { PageBox } from "./layout";
export { DEFAULT_BUDGET } from "./types";
export type {
  PageRenderState,
  PageState,
  ReadMode,
  RenderBudget,
  RenderScheduler,
  ViewportState,
} from "./types";
