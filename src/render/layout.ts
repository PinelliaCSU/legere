// 页几何与可见页计算（docs/08 §1-§3）。纯函数，无 DOM 依赖，便于单测。

import type { PageGeometry } from "../pdf-engine/types";
import type { ViewportState } from "./types";

/// 阅读区留白（D17 已定：上下 32px）与页间距（12px）。
export const READER_PADDING = 32;
export const PAGE_GAP = 12;

export interface PageBox {
  pageNo: number;
  /// 缩放到 CSS 像素后的页宽高。
  width: number;
  height: number;
  /// 页顶相对滚动内容顶部的偏移。
  top: number;
}

/// 计算每页的盒子与累计偏移（O(n) 前缀和）。
export function computePageBoxes(
  geometries: PageGeometry[],
  scale: number,
  gap: number = PAGE_GAP,
): PageBox[] {
  const boxes: PageBox[] = [];
  let top = 0;
  for (let i = 0; i < geometries.length; i += 1) {
    const geo = geometries[i];
    if (geo === undefined) continue;
    const width = geo.widthPt * scale;
    const height = geo.heightPt * scale;
    boxes.push({ pageNo: i + 1, width, height, top });
    top += height + gap;
  }
  return boxes;
}

/// 总内容高度（含尾部留白）。
export function totalContentHeight(boxes: PageBox[], padding: number = READER_PADDING): number {
  const last = boxes[boxes.length - 1];
  if (last === undefined) return padding * 2;
  return last.top + last.height + padding * 2;
}

/// 二分查找：给定滚动位置与视口高度，返回可见页区间（1-based，闭区间）。
export function computeVisibleRange(
  boxes: PageBox[],
  scrollTop: number,
  viewportHeight: number,
  padding: number = READER_PADDING,
): { first: number; last: number } {
  if (boxes.length === 0) return { first: 1, last: 0 };

  const viewTop = scrollTop - padding;
  const viewBottom = scrollTop + viewportHeight - padding;

  // 第一个 bottom > viewTop 的页
  let lo = 0;
  let hi = boxes.length - 1;
  let firstIdx = boxes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const box = boxes[mid];
    if (box === undefined) break;
    if (box.top + box.height > viewTop) {
      firstIdx = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  // 最后一个 top < viewBottom 的页
  lo = firstIdx;
  hi = boxes.length - 1;
  let lastIdx = firstIdx;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const box = boxes[mid];
    if (box === undefined) break;
    if (box.top < viewBottom) {
      lastIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return { first: boxes[firstIdx]?.pageNo ?? 1, last: boxes[lastIdx]?.pageNo ?? 1 };
}

/// 预取区间：可见区间向两侧扩展。
export function expandForPrefetch(
  range: { first: number; last: number },
  pageCount: number,
  prefetch: number,
): { first: number; last: number } {
  return {
    first: Math.max(1, range.first - prefetch),
    last: Math.min(pageCount, range.last + prefetch),
  };
}

/// 跳页保护阈值（docs/08 §2 第 53 行）：可见跨度超过它的一轮只渲染 visible、跳过预取。
/// goToPage 或极小窗口会让 visible ∪ prefetch 瞬间变成一大片，一次全排队只会把队列撑爆。
export const JUMP_SPAN_LIMIT = 30;

export function shouldSkipPrefetch(range: { first: number; last: number }): boolean {
  return range.last - range.first > JUMP_SPAN_LIMIT;
}

/// 优先级权重（docs/08 §3 第 65-71 行的表）。改这里必须同步文档与该表的算例，
/// 单测只断言排序结果（priority.test.ts），不断言分数绝对值。
export const PRIORITY_WEIGHTS = {
  distance: 1.0,
  direction: 0.5,
  current: 0.8,
  scaleMiss: 2.0,
} as const;

/// 无缓存时的最大缩放失配（等价 log2(8)）。
export const SCALE_MISS_MAX = 3;

/// 预取页的固定层级偏移：可见页永远排在预取页之前（0..~10 vs 1000+）。
export const PREFETCH_TIER = 1000;

/// 打分上下文：docs/08 §3 的 w1·d − w2·dir − w3·cur + w4·miss 四个输入。
export interface PriorityContext {
  range: { first: number; last: number };
  scrollTop: number;
  viewportHeight: number;
  currentPage: number;
  /// 滚动方向：1=向下、-1=向上、0=静止/未知（缩放与换文档时归零）。
  scrollSign: -1 | 0 | 1;
  scale: number;
  /// 该页已缓存位图的 scale（无缓存返回 null）。
  cachedScaleOf: (pageNo: number) => number | null;
}

/// 单页调度分数：越小越先渲染。可见页返回 0..10 量级，预取页统一加 PREFETCH_TIER。
export function pageScore(box: PageBox, ctx: PriorityContext): number {
  const viewCenter = ctx.scrollTop + ctx.viewportHeight / 2;
  const center = box.top + box.height / 2;
  const viewportHeight = ctx.viewportHeight > 0 ? ctx.viewportHeight : 1;
  const distance = Math.abs(center - viewCenter) / viewportHeight;
  // 在滚动方向前方：半页提前量，让下一屏领先同距离的上一屏。
  const ahead = ctx.scrollSign !== 0 && (center - viewCenter) * ctx.scrollSign > 0 ? 1 : 0;
  const isCurrent = box.pageNo === ctx.currentPage ? 1 : 0;
  const cachedScale = ctx.cachedScaleOf(box.pageNo);
  const scaleMiss = cachedScale === null || cachedScale <= 0 ? SCALE_MISS_MAX : Math.abs(Math.log2(cachedScale / ctx.scale));
  const score =
    PRIORITY_WEIGHTS.distance * distance -
    PRIORITY_WEIGHTS.direction * ahead -
    PRIORITY_WEIGHTS.current * isCurrent +
    PRIORITY_WEIGHTS.scaleMiss * scaleMiss;
  const inVisible = box.pageNo >= ctx.range.first && box.pageNo <= ctx.range.last;
  return inVisible ? score : PREFETCH_TIER + score;
}

/// 旧的三档排序（v0.11 及以前）。保留给外部调用与既有单测，调度器已改用 pageScore。
/// @deprecated 用 pageScore（含滚动方向偏好与缩放失配，docs/08 §3）。
export function pagePriority(
  pageNo: number,
  range: { first: number; last: number },
  currentPage: number,
): number {
  if (pageNo < range.first || pageNo > range.last) {
    // 预取页排在所有可见页之后。
    return 1000 + Math.min(Math.abs(pageNo - range.first), Math.abs(pageNo - range.last));
  }
  if (pageNo === currentPage) return 0;
  return 1 + Math.abs(pageNo - currentPage);
}

/// 缩放时保持锚点（鼠标位置对应的文档坐标不动）。
export function anchorScrollTop(
  boxes: PageBox[],
  pageNo: number,
  ratioY: number,
  newScale: number,
  geometries: PageGeometry[],
  padding: number = READER_PADDING,
): number {
  const newBoxes = computePageBoxes(geometries, newScale);
  const box = newBoxes[pageNo - 1];
  if (box === undefined) return 0;
  const prev = boxes[pageNo - 1];
  const prevOffset = prev === undefined ? 0 : ratioY * prev.height;
  return box.top + ratioY * box.height - prevOffset + padding;
}

/// canvas 字节数（docs/08 §5）：w × h × dpr² × 4。
export function canvasBytes(widthPt: number, heightPt: number, scale: number, dpr: number): number {
  const w = Math.ceil(widthPt * scale * dpr);
  const h = Math.ceil(heightPt * scale * dpr);
  return w * h * 4;
}

/// 单页模式下的当前页（视口中心所在页）。
export function currentPageAt(boxes: PageBox[], scrollTop: number, viewportHeight: number): number {
  const center = scrollTop + viewportHeight / 2;
  let current = 1;
  for (const box of boxes) {
    if (box.top <= center) current = box.pageNo;
    else break;
  }
  return current;
}

/// 从 ViewportState 派生可见区间（供 M07 调用）。
export function visibleFromViewport(v: ViewportState): { first: number; last: number; boxes: PageBox[] } {
  const boxes = computePageBoxes(v.pageGeometries, v.scale);
  return { ...computeVisibleRange(boxes, v.scrollTop, v.viewportHeight), boxes };
}
