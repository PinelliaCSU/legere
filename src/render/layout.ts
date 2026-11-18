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

/// 优先级：距视口中心越近越小（越先渲染）。
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
