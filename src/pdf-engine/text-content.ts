// items -> text / itemStarts（契约 R1）。
//
// V-01 实测：pdfjs 6.x 的 TextItem 有 hasEOL 字段，因此换行判据直接用 hasEOL，
// 不再依赖 y 差阈值（旧设计会因字号/行距不同产生漏判）。

import type { TextContentHandle, TextItem } from "./types";

export interface RawTextItemLike {
  str: string;
  transform: Array<number>;
  width: number;
  height: number;
  hasEOL?: boolean;
}

/// 把 pdfjs 的原始 item 转成契约里的 TextItem（坐标：scale=1 的页面 CSS 像素）。
export function toTextItem(raw: RawTextItemLike): TextItem {
  const t = raw.transform;
  const fontSize = Math.sqrt((t[2] ?? 0) ** 2 + (t[3] ?? 0) ** 2);
  return {
    str: raw.str,
    x: t[4] ?? 0,
    y: t[5] ?? 0,
    width: raw.width,
    height: raw.height,
    fontSize,
  };
}

/// 构造 text 与 itemStarts：item 之间无分隔符，hasEOL 处插入单个 '\n'。
export function buildTextContent(items: TextItem[], hasEol: boolean[]): TextContentHandle {
  const itemStarts: number[] = [];
  let text = "";
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item === undefined) continue;
    itemStarts.push(text.length);
    text += item.str;
    if (hasEol[i] === true) text += "\n";
  }
  return { items, text, itemStarts };
}

/// 便捷封装（契约字段是 itemStarts；两者不一致时以 itemStarts 为准）。
export function getItemRanges(items: TextItem[]): { index: number; start: number; end: number }[] {
  let cursor = 0;
  return items.map((item, index) => {
    const start = cursor;
    cursor += item.str.length;
    return { index, start, end: cursor };
  });
}

/// 字符区间 -> 命中的 item 列表（供 M08 高亮用）。
export function itemsInRange(
  content: TextContentHandle,
  start: number,
  end: number,
): { item: TextItem; from: number; to: number }[] {
  const out: { item: TextItem; from: number; to: number }[] = [];
  // itemStarts is ordered; each highlighted occurrence only needs its own items.
  let low = 0;
  let high = content.itemStarts.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (content.itemStarts[mid]! <= start) low = mid + 1;
    else high = mid;
  }
  for (let i = Math.max(0, low - 1); i < content.items.length; i += 1) {
    const item = content.items[i];
    const itemStart = content.itemStarts[i];
    if (item === undefined || itemStart === undefined) continue;
    const itemEnd = itemStart + item.str.length;
    if (itemStart >= end) break;
    if (itemEnd <= start || item.str.length === 0) continue;
    out.push({
      item,
      from: Math.max(start, itemStart) - itemStart,
      to: Math.min(end, itemEnd) - itemStart,
    });
  }
  return out;
}
