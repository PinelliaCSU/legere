// 文本层挂载（路径 B：自绘绝对定位 span）。
//
// 为什么不用 pdfjs 的 TextLayer 类：它需要 pdfjs 自己的 TextContent/PageViewport 实例，
// 从契约层硬造只能造出假对象（既脆又会把 pdfjs 类型泄漏出 engine）。
// 自绘 span 的数据来源是 TextContentHandle（契约类型），坐标已是 scale=1 的 CSS 像素，
// 乘以当前 scale 即可；选择与高亮都按同一套坐标工作。

import type { TextContentHandle, TextItem } from "../pdf-engine/types";

export interface MountedTextLayer {
  container: HTMLDivElement;
  destroy: () => void;
}

/// 把文本层渲染到 host 内；文字透明（D20），位置按 scale 缩放。
export function mountTextLayer(
  host: HTMLElement,
  content: TextContentHandle,
  scale: number,
  pageHeightPt: number,
): MountedTextLayer {
  const container = document.createElement("div");
  container.className = "lg-text-layer";
  container.style.position = "absolute";
  container.style.inset = "0";
  container.style.pointerEvents = "auto";
  container.style.userSelect = "text";

  const frag = document.createDocumentFragment();
  content.items.forEach((item: TextItem, index) => {
    if (item.str.trim().length === 0) return;
    const span = document.createElement("span");
    span.textContent = item.str;
    span.dataset.offset = String(content.itemStarts[index] ?? 0);
    span.style.position = "absolute";
    // pdfjs 的 y 是基线坐标（自下而上），CSS 用顶部坐标（自上而下）。
    span.style.left = `${item.x * scale}px`;
    span.style.top = `${(pageHeightPt - item.y - item.height) * scale}px`;
    span.style.fontSize = `${Math.max(item.fontSize, 1) * scale}px`;
    span.style.lineHeight = "1";
    span.style.whiteSpace = "pre";
    span.style.color = "transparent";
    span.style.transformOrigin = "left bottom";
    frag.appendChild(span);
  });
  container.appendChild(frag);
  host.appendChild(container);

  return {
    container,
    destroy: () => container.remove(),
  };
}
