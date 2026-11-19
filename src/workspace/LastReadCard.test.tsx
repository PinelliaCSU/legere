import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LastReadCard } from "./LastReadCard";

describe("上次阅读卡片真实渲染（需求 5）", () => {
  const now = new Date("2026-11-03T12:00:00.000Z");

  it("标题、进度、时间与「继续阅读」按钮都在", () => {
    const html = renderToStaticMarkup(
      createElement(LastReadCard, {
        doc: {
          documentId: 3,
          title: "西方哲学史",
          author: "罗素",
          pageCount: 420,
          progressPage: 87,
          lastOpenedAt: "2026-11-03T09:00:00.000Z",
        },
        now,
        onContinue: () => undefined,
      }),
    );
    expect(html).toContain("上次阅读");
    expect(html).toContain("西方哲学史");
    expect(html).toContain("罗素 · 读到第 87 / 420 页 · 3 小时前");
    expect(html).toContain("继续阅读");
  });
});
