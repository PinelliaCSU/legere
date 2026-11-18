import { describe, expect, it } from "vitest";

import { findInPage, normalizeForKey, searchPages, snippetAt } from "./doc-search";
import { buildTextContent } from "../../pdf-engine/text-content";
import type { TextItem } from "../../pdf-engine/types";

const item = (str: string): TextItem => ({ str, x: 0, y: 0, width: 10, height: 10, fontSize: 12 });

describe("normalizeForKey", () => {
  it("全角转半角且等长", () => {
    const input = "ＡＢＣ１２３";
    expect(normalizeForKey(input).length).toBe(input.length);
    expect(normalizeForKey(input)).toBe("abc123");
  });

  it("大小写折叠", () => {
    expect(normalizeForKey("Legere")).toBe("legere");
  });
});

describe("findInPage", () => {
  it("中文子串命中（不分词）", () => {
    const ranges = findInPage("中文分词的效果很好", "分词的效");
    expect(ranges).toEqual([[2, 6]]);
  });

  it("英文大小写不敏感", () => {
    expect(findInPage("Legere sample page", "SAMPLE")).toEqual([[7, 13]]);
  });

  it("多次出现都返回", () => {
    expect(findInPage("aa bb aa", "aa").length).toBe(2);
  });

  it("空查询返回空", () => {
    expect(findInPage("abc", "   ")).toEqual([]);
  });

  it("跨行命中（文本里含换行）", () => {
    const text = "第一行结尾\n第二行开头";
    const ranges = findInPage(text, "结尾\n第二");
    expect(ranges.length).toBe(1);
  });
});

describe("searchPages + snippet", () => {
  it("按页返回命中并带上下文", () => {
    const p1 = buildTextContent([item("Legere sample page")], [false]);
    const p2 = buildTextContent([item("another document")], [false]);
    const hits = searchPages([
      { pageNo: 1, content: p1 },
      { pageNo: 2, content: p2 },
    ], "legere");
    expect(hits.length).toBe(1);
    expect(hits[0]?.pageNo).toBe(1);
    expect(hits[0]?.snippet).toContain("Legere");
  });

  it("长文本上下文带省略号", () => {
    const long = "字".repeat(50) + "目标" + "字".repeat(50);
    const snip = snippetAt(long, 50, 52);
    expect(snip.startsWith("…") && snip.endsWith("…")).toBe(true);
    expect(snip.length).toBeLessThan(60);
  });
});
