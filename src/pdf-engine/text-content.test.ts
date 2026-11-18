import { describe, expect, it } from "vitest";

import { buildTextContent, getItemRanges, itemsInRange, toTextItem } from "./text-content";
import type { TextItem } from "./types";

const item = (str: string, x = 0, y = 0): TextItem => ({ str, x, y, width: 10, height: 10, fontSize: 12 });

describe("buildTextContent（契约 R1）", () => {
  it("item 之间无分隔符，hasEOL 处插入换行", () => {
    const content = buildTextContent([item("Hello"), item(" World"), item("Next")], [false, true, false]);
    expect(content.text).toBe("Hello World\nNext");
    expect(content.itemStarts).toEqual([0, 5, 12]);
  });

  it("itemStarts 可精确还原每个 item", () => {
    const items = [item("中文"), item("分词"), item("效果")];
    const content = buildTextContent(items, [false, false, true]);
    items.forEach((it, i) => {
      const start = content.itemStarts[i] ?? 0;
      expect(content.text.slice(start, start + it.str.length)).toBe(it.str);
    });
  });

  it("空内容不炸", () => {
    expect(buildTextContent([], [])).toEqual({ items: [], text: "", itemStarts: [] });
  });
});

describe("坐标与区间", () => {
  it("toTextItem 从 transform 推导坐标与字号", () => {
    const it2 = toTextItem({ str: "x", transform: [12, 0, 0, 12, 100, 200], width: 8, height: 12 });
    expect(it2).toMatchObject({ x: 100, y: 200, fontSize: 12, width: 8, height: 12 });
  });

  it("getItemRanges 与 itemStarts 一致", () => {
    const items = [item("ab"), item("cde")];
    const content = buildTextContent(items, [false, false]);
    const ranges = getItemRanges(items);
    expect(ranges.map((r) => r.start)).toEqual(content.itemStarts);
  });

  it("itemsInRange 能定位跨 item 命中", () => {
    const items = [item("Hello "), item("World")];
    const content = buildTextContent(items, [false, false]);
    const parts = itemsInRange(content, 4, 8);
    expect(parts.length).toBe(2);
    expect(parts[0]?.from).toBe(4);
    expect(parts[1]?.to).toBe(2);
  });
});
