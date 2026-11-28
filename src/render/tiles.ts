import type { RenderRequest } from "../pdf-engine/types";
import { computeVisibleRange, expandForPrefetch, pageScore, READER_PADDING, shouldSkipPrefetch, type PageBox } from "./layout";
import type { ViewportState } from "./types";

const TILE_SIZE = 1024; // device pixels
type Rect = NonNullable<RenderRequest["clipBox"]>;

export interface TileSpec {
  key: string;
  pageNo: number;
  scale: number;
  pixelRatio: number;
  clip?: Rect;
  // Fractions of the rotated page; old bitmaps retain their position at any zoom.
  bounds: Rect;
  visible: boolean;
  priority: number;
}

export interface TileBitmap extends TileSpec {
  canvas: HTMLCanvasElement;
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function planTiles(boxes: PageBox[], v: ViewportState, prefetch: number, direction: -1 | 0 | 1,
  cachedScaleOf: (pageNo: number) => number | null = () => null): TileSpec[] {
  if (!boxes.length || v.viewportWidth <= 0 || v.viewportHeight <= 0) return [];
  const ratio = v.pixelRatio ?? 1;
  const visible = v.mode === "single" ? { first: v.currentPage, last: v.currentPage }
    : computeVisibleRange(boxes, v.scrollTop, v.viewportHeight);
  const window = shouldSkipPrefetch(visible) ? visible : expandForPrefetch(visible, boxes.length, prefetch);
  const currentPage = v.mode === "single" ? v.currentPage
    : computeVisibleRange(boxes, v.scrollTop + v.viewportHeight / 2, 1).first;
  const result: TileSpec[] = [];
  for (let pageNo = window.first; pageNo <= window.last; pageNo++) {
    const box = boxes[pageNo - 1];
    if (!box) continue;
    const onScreen = pageNo >= visible.first && pageNo <= visible.last;
    const width = Math.ceil(box.width * ratio);
    const height = Math.ceil(box.height * ratio);
    if (!width || !height) continue;
    const top = v.mode === "single" ? 0 : box.top;
    const localTop = (v.scrollTop - READER_PADDING - top) * ratio;
    const localLeft = ((v.scrollLeft ?? 0) - Math.max(0, (v.viewportWidth - box.width) / 2)) * ratio;
    const view = { x: localLeft, y: localTop, w: v.viewportWidth * ratio, h: v.viewportHeight * ratio };
    const pagePriority = pageScore(box, {
      range: visible, scrollTop: v.scrollTop + (v.mode === "single" ? box.top : 0),
      viewportHeight: v.viewportHeight, currentPage,
      scrollSign: direction, scale: v.scale, cachedScaleOf,
    });
    const key = [pageNo, v.scale, ratio].join("/");
    // Small pages fit comfortably in a single bitmap; avoid replaying their display list.
    if (width <= TILE_SIZE * 2 && height <= TILE_SIZE * 2 && width * height <= TILE_SIZE ** 2) {
      result.push({ key, pageNo, scale: v.scale, pixelRatio: ratio, visible: onScreen,
        priority: pagePriority, bounds: { x: 0, y: 0, w: 1, h: 1 } });
      continue;
    }
    if (!onScreen) continue;
    const col0 = Math.max(0, Math.floor(view.x / TILE_SIZE) - 1);
    const row0 = Math.max(0, Math.floor(view.y / TILE_SIZE) - 1);
    const right = Math.min(width, (Math.ceil((view.x + view.w) / TILE_SIZE) + 1) * TILE_SIZE);
    const bottom = Math.min(height, (Math.ceil((view.y + view.h) / TILE_SIZE) + 1) * TILE_SIZE);
    for (let y = row0 * TILE_SIZE; y < bottom; y += TILE_SIZE) {
      for (let x = col0 * TILE_SIZE; x < right; x += TILE_SIZE) {
        const w = Math.min(TILE_SIZE, width - x);
        const h = Math.min(TILE_SIZE, height - y);
        const clip = { x, y, w, h };
        const distance = Math.hypot((x + w / 2 - view.x - view.w / 2) / view.w,
          (y + h / 2 - view.y - view.h / 2) / view.h);
        result.push({ key: key + "/" + x + "/" + y, pageNo, scale: v.scale, pixelRatio: ratio,
          visible: intersects(clip, view), priority: pagePriority + distance, clip,
          bounds: { x: x / width, y: y / height, w: w / width, h: h / height } });
      }
    }
  }
  return result.sort((a, b) => Number(b.visible) - Number(a.visible) || a.priority - b.priority);
}
