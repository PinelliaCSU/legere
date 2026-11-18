import { describe, expect, it } from "vitest";

import type { TextContentHandle } from "../../pdf-engine/types";
import { findInPage, searchPages } from "./doc-search";

function content(text: string): TextContentHandle {
  return {
    items: text.length === 0 ? [] : [{ str: text, x: 0, y: 0, width: 10, height: 10, fontSize: 10 }],
    text,
    itemStarts: [0],
  };
}

describe("文内搜索跨页（M08）", () => {
  const pages = [
    { pageNo: 1, content: content("前言：这本书讨论文学与记忆。") },
    { pageNo: 2, content: content("第一章 文学的定义。文学不是修辞。") },
    { pageNo: 3, content: content("无关内容。") },
    { pageNo: 4, content: content("附录：再谈文学。") },
  ];

  it("跨页命中都带正确的页码，跳页依据就是它", () => {
    const hits = searchPages(pages, "文学");
    expect(hits.map((h) => h.pageNo)).toEqual([1, 2, 4]);
    expect(hits[1]!.ranges).toHaveLength(2);
    for (const hit of hits) {
      for (const [start, end] of hit.ranges) {
        const page = pages.find((p) => p.pageNo === hit.pageNo)!;
        expect(page.content.text.slice(start, end)).toBe("文学");
      }
    }
  });

  it("无命中的页不出现在结果里", () => {
    const hits = searchPages(pages, "文学");
    expect(hits.some((h) => h.pageNo === 3)).toBe(false);
  });

  it("不跨页拼接：跨页边界的词组不会被误判为命中", () => {
    const split = [
      { pageNo: 1, content: content("文学") },
      { pageNo: 2, content: content("记忆") },
    ];
    expect(searchPages(split, "文学记忆")).toEqual([]);
    expect(searchPages(split, "文学")[0]?.pageNo).toBe(1);
    expect(searchPages(split, "记忆")[0]?.pageNo).toBe(2);
  });

  it("全角与大小写不影响命中，但区间仍按原文长度映射", () => {
    const hits = searchPages([{ pageNo: 1, content: content("Ｌｅｇｅｒｅ 与 LEGERE") }], "legere");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.ranges).toHaveLength(2);
    expect(findInPage("Ｌｅｇｅｒｅ", "legere")).toEqual([[0, 6]]);
  });

  it("命中上下文带省略号且不换行", () => {
    const long = "甲".repeat(60) + "文学" + "乙".repeat(60);
    const hits = searchPages([{ pageNo: 1, content: content(long) }], "文学");
    expect(hits[0]!.snippet.startsWith("…")).toBe(true);
    expect(hits[0]!.snippet.endsWith("…")).toBe(true);
    expect(hits[0]!.snippet).not.toContain("\n");
  });
});
