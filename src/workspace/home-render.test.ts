import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HomeSpace, SPINE_PALETTE, spineColorFor, spineTooltip, type HomeBook } from "./HomeSpace";
import { maxMountedSpines } from "./ring";
import { HomePattern } from "./HomePattern";

function books(count: number): HomeBook[] {
  return Array.from({ length: count }, (_, i) => ({
    documentId: i + 1,
    fileName: "doc-" + (i + 1) + ".pdf",
    title: "文献 " + (i + 1),
    author: null,
    spineColor: spineColorFor(i + 1),
    pageCount: 100 + i,
    progressPage: null,
  }));
}

function render(count: number, active = true): string {
  return renderToStaticMarkup(
    createElement(HomeSpace, {
      books: books(count),
      onOpenBook: () => undefined,
      onAddLibrary: () => undefined,
      active,
    }),
  );
}

function spineCount(html: string): number {
  return (html.match(/data-home-spine/g) ?? []).length;
}

describe("主页转盘真实渲染（不只测辅助函数）", () => {
  it("同一个随机种子可重绘同一幅图，更换种子会改变构图", () => {
    const print = (seed: number) => renderToStaticMarkup(createElement(HomePattern, { seed }));
    expect(print(819)).toBe(print(819));
    expect(print(819)).not.toBe(print(820));
  });

  it("N=0 渲染空态，不画环、不生成书脊", () => {
    const html = render(0);
    expect(spineCount(html)).toBe(0);
    expect(html).toContain("还没有文献");
    expect(html).toContain("添加文献库");
    expect(html).not.toContain("lg-home-ring");
  });

  it("单本书独立陈列，从两本起显示弧线和翻书按钮", () => {
    const single = render(1);
    expect(spineCount(single)).toBe(1);
    expect(single).not.toContain("lg-home-ring");
    expect(single).not.toContain("浏览书架");
    const pair = render(2);
    expect(spineCount(pair)).toBe(2);
    expect(pair).toContain("lg-home-ring");
    expect(pair).toContain('aria-label="上一本"');
    expect(pair).toContain('aria-label="下一本"');
  });

  it("N=16/60/98 只挂载可见槽位，隐藏槽位不生成 DOM", () => {
    for (const total of [16, 60, 98]) {
      const count = spineCount(render(total));
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(Math.min(total, 16));
      expect(count).toBeLessThanOrEqual(maxMountedSpines(total));
    }
    // 书越多不会越多 DOM：98 本与 60 本挂载数量相同
    expect(spineCount(render(98))).toBe(spineCount(render(60)));
  });

  it("98 本时焦点书名只出现一次，且书脊上只有书名", () => {
    const html = render(98);
    expect(html).toContain("lg-home-focused");
    // 焦点区只展示一本（一条 title + 一条 meta）
    expect((html.match(/lg-home-focused/g) ?? []).length).toBe(1);
    expect(html).toContain("文献 1");
    // 书脊内不出现作者 / 页码 / 进度
    const spineHtml = html.slice(html.indexOf("lg-spine") - 200);
    expect(spineHtml).not.toContain("作者");
  });

  it("离开主页时仍然挂载（保留环位置），只做视觉隐藏", () => {
    const inactive = render(16, false);
    expect(spineCount(inactive)).toBe(spineCount(render(16)));
    expect(inactive).toContain("is-inactive");
  });

  it("8 色预设色板按 documentId 取色（不读封面）", () => {
    expect(SPINE_PALETTE).toHaveLength(8);
    for (const id of [1, 7, 8, 9, 100, -3]) {
      expect(SPINE_PALETTE).toContain(spineColorFor(id) as (typeof SPINE_PALETTE)[number]);
    }
    expect(spineColorFor(1)).toBe(spineColorFor(9));
  });
});

describe("书脊悬停 tooltip（docs/16 §6）", () => {
  const base = {
    documentId: 1,
    fileName: "a.pdf",
    title: "书名",
    author: null,
    spineColor: "#9AA47A",
    pageCount: 100,
    progressPage: null,
  };

  it("有作者有进度：两项都要出现", () => {
    expect(spineTooltip({ ...base, author: "作者甲", progressPage: 12 })).toBe("作者甲 · 读到第 12 / 100 页");
  });

  it("缺作者：只显示阅读进度", () => {
    expect(spineTooltip({ ...base, progressPage: 12 })).toBe("读到第 12 / 100 页");
  });

  it("没有进度但有页数：显示总页数", () => {
    expect(spineTooltip({ ...base, author: "作者乙" })).toBe("作者乙 · 共 100 页");
  });

  it("什么都没有时回退到书名（不能给出空 tooltip）", () => {
    expect(spineTooltip({ ...base, pageCount: null })).toBe("书名");
  });
});
