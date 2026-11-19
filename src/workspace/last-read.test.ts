import { describe, expect, it } from "vitest";

import { lastReadMeta, parseLastDocumentId, pickLastRead, relativeTime, type LastReadDoc } from "./last-read";

function doc(over: Partial<LastReadDoc> = {}): LastReadDoc {
  return {
    documentId: 1,
    title: "文献",
    author: null,
    pageCount: 100,
    progressPage: null,
    lastOpenedAt: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

describe("上次阅读（需求 5）的设置值解析", () => {
  it("只接受正整数", () => {
    expect(parseLastDocumentId("12")).toBe(12);
    expect(parseLastDocumentId(" 7 ")).toBe(7);
    expect(parseLastDocumentId("")).toBeNull();
    expect(parseLastDocumentId(undefined)).toBeNull();
    expect(parseLastDocumentId("0")).toBeNull();
    expect(parseLastDocumentId("-3")).toBeNull();
    expect(parseLastDocumentId("abc")).toBeNull();
  });
});

describe("上次阅读的选取", () => {
  it("取最近打开的一本，忽略从没打开过的书", () => {
    const picked = pickLastRead([
      doc({ documentId: 1, lastOpenedAt: "2026-11-01T00:00:00.000Z" }),
      doc({ documentId: 2, lastOpenedAt: "2026-11-03T00:00:00.000Z" }),
      doc({ documentId: 3, lastOpenedAt: null }),
    ]);
    expect(picked?.documentId).toBe(2);
  });

  it("一本都没打开过时返回 null（不拿新导入的书顶替）", () => {
    expect(pickLastRead([doc({ lastOpenedAt: null })])).toBeNull();
    expect(pickLastRead([])).toBeNull();
  });
});

describe("相对时间与卡片第二行", () => {
  const now = new Date("2026-11-03T12:00:00.000Z");

  it("分钟/小时/天/日期四档", () => {
    expect(relativeTime("2026-11-03T11:59:40.000Z", now)).toBe("刚刚");
    expect(relativeTime("2026-11-03T11:30:00.000Z", now)).toBe("30 分钟前");
    expect(relativeTime("2026-11-03T06:00:00.000Z", now)).toBe("6 小时前");
    expect(relativeTime("2026-10-31T12:00:00.000Z", now)).toBe("3 天前");
    expect(relativeTime("2025-01-02T12:00:00.000Z", now)).toBe("2025-01-02");
    expect(relativeTime(null, now)).toBe("");
  });

  it("卡片第二行 = 作者 + 进度 + 时间", () => {
    expect(lastReadMeta(doc({ author: "张三", progressPage: 12 }), now)).toBe("张三 · 读到第 12 / 100 页 · 2 天前");
    expect(lastReadMeta(doc({ author: null, progressPage: null, pageCount: null }), now)).toBe("2 天前");
  });
});
