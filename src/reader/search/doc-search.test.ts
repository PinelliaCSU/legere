import { describe, expect, it } from "vitest";

import { createSearchTextCache, findInPage, normalizeForKey, scanFromOrigin, searchPages, snippetAt, stepOccurrence } from "./doc-search";
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

describe("PDF line wrapping", () => {
  it.each([
    ["甲乙  \r\n 丙丁", "乙丙", "乙  \r\n 丙"],
    ["two \n words", "two words", "two \n words"],
    ["multi-\ncolumn inter-\nnational", "multi-column international", "multi-\ncolumn inter-\nnational"],
    ["Ａ ﬁ inter\u00adnational", "international", "inter\u00adnational"],
    ["😀İＡＢＣ", "abc", "ＡＢＣ"],
  ])("maps %s back to the original UTF-16 range", (text, query, expected) => {
    expect(findInPage(text, query).map(([a, b]) => text.slice(a, b))).toEqual([expected]);
  });

  it("preserves ordinary hyphens, word boundaries and every occurrence", () => {
    expect(findInPage("well-known", "wellknown")).toEqual([]);
    expect(findInPage("two\nwords", "twowords")).toEqual([]);
    expect(findInPage("同".repeat(201), "同")).toHaveLength(201);
  });
});

describe("occurrence navigation", () => {
  const page = buildTextContent([700, 400, 100].map(y => ({ ...item("hit"), y })), [true, true, false]);
  it("publishes the nearest match before reading the next page, then wraps", async () => {
    const reads: number[] = [];
    const stream = scanFromOrigin(3, { pageNo: 2, topY: 450 }, "hit", async n => {
      reads.push(n);
      return page;
    }, () => false);
    const first = await stream.next();
    expect(first.value?.firstAhead).toBe(1);
    expect(reads).toEqual([2]);
    const pages = [first.value!.page];
    for await (const result of stream) pages.push(result.page);
    expect(reads).toEqual([2, 3, 1]);
    expect(stepOccurrence(pages, { pageNo: 2, rangeIndex: 1 }, 1)).toEqual({ pageNo: 2, rangeIndex: 2 });
    expect(stepOccurrence(pages, { pageNo: 3, rangeIndex: 2 }, 1)).toEqual({ pageNo: 1, rangeIndex: 0 });
    expect(stepOccurrence(pages, { pageNo: 2, rangeIndex: 0 }, -1)).toEqual({ pageNo: 1, rangeIndex: 2 });
  });

  it("defers hits above the viewport and discards a cancelled pending read", async () => {
    let cancelled = false;
    const stream = scanFromOrigin(2, { pageNo: 2, topY: 0 }, "hit", async n => {
      if (n === 1) cancelled = true;
      return page;
    }, () => cancelled);
    expect((await stream.next()).value?.firstAhead).toBe(-1);
    expect((await stream.next()).done).toBe(true);
  });
});

it("reuses normalized text while retaining exact UTF-16 ranges for multiline highlights", async () => {
  const pages = [
    buildTextContent([item("😀İ Ａ inter-"), item("national"), item("中文"), item("术语")], [true, true, true, false]),
    buildTextContent([item("other page")], [false]),
  ];
  const cache = createSearchTextCache();
  const reads: number[] = [];
  for (const [query, original] of [["international", "inter-\nnational"], ["中文术语", "中文\n术语"]]) {
    reads.length = 0;
    const hits = [];
    for await (const { page } of scanFromOrigin(2, { pageNo: 1, topY: Infinity }, query!, async n => {
      reads.push(n);
      return pages[n - 1]!;
    }, () => false, cache)) hits.push(page);
    expect(hits).toHaveLength(1);
    const range = hits[0]!.ranges[0]!;
    expect(pages[0]!.text.slice(...range)).toBe(original);
    if (query === "中文术语") expect(reads).toEqual([1]);
  }
});
