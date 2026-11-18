// 高亮层（D21）：普通命中 = --lg-hit-bg；当前命中 = --lg-hit-active-bg + 1px 描边。
// 只画框，不放文本（否则会被复制进选择内容，M08 Prompt 第 24 条）。

import type { TextContentHandle } from "../pdf-engine/types";
import { itemsInRange } from "../pdf-engine";

export interface HighlightRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/// 把字符区间换算成页面内的矩形（可能多个：跨行/跨 item）。
export function rectsForRanges(
  content: TextContentHandle,
  ranges: [number, number][],
  scale: number,
  pageHeightPt: number,
): HighlightRect[] {
  const rects: HighlightRect[] = [];
  for (const [start, end] of ranges) {
    for (const part of itemsInRange(content, start, end)) {
      const { item, from, to } = part;
      const charWidth = item.str.length > 0 ? item.width / item.str.length : 0;
      rects.push({
        left: (item.x + from * charWidth) * scale,
        top: (pageHeightPt - item.y - item.height) * scale,
        width: Math.max((to - from) * charWidth, 1) * scale,
        height: Math.max(item.height, 1) * scale,
      });
    }
  }
  return rects;
}

/// 在当前命中上叠加高亮；activeIndex 指向 ranges 中的区间。
export function mountHighlights(
  host: HTMLElement,
  content: TextContentHandle,
  ranges: [number, number][],
  activeIndex: number,
  scale: number,
  pageHeightPt: number,
): () => void {
  const layer = document.createElement("div");
  layer.className = "lg-highlight-layer";
  layer.style.position = "absolute";
  layer.style.inset = "0";
  layer.style.pointerEvents = "none";

  ranges.forEach((range, index) => {
    const isActive = index === activeIndex;
    for (const rect of rectsForRanges(content, [range], scale, pageHeightPt)) {
      const box = document.createElement("div");
      box.style.position = "absolute";
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      box.style.background = isActive ? "var(--lg-hit-active-bg)" : "var(--lg-hit-bg)";
      if (isActive) box.style.outline = "1px solid var(--lg-hit-active-border)";
      layer.appendChild(box);
    }
  });

  host.appendChild(layer);
  return () => layer.remove();
}
