import { describe, expect, it } from "vitest";

import {
  PAGE_GAP,
  READER_PADDING,
  anchorScrollTop,
  canvasBytes,
  computePageBoxes,
  computeVisibleRange,
  currentPageAt,
  expandForPrefetch,
  pagePriority,
  totalContentHeight,
} from "./layout";

const A4 = { widthPt: 595, heightPt: 842, rotation: 0 as const };
const geos = Array.from({ length: 10 }, () => A4);

describe("computePageBoxes", () => {
  it("累积偏移包含页间距", () => {
    const boxes = computePageBoxes(geos, 1);
    expect(boxes).toHaveLength(10);
    expect(boxes[0]?.top).toBe(0);
    expect(boxes[1]?.top).toBe(842 + PAGE_GAP);
    expect(boxes[0]?.height).toBe(842);
  });

  it("缩放线性作用于尺寸", () => {
    const boxes = computePageBoxes(geos, 2);
    expect(boxes[0]?.height).toBe(1684);
  });

  it("总高度含上下留白", () => {
    const boxes = computePageBoxes(geos, 1);
    const last = boxes[boxes.length - 1];
    expect(totalContentHeight(boxes)).toBe((last?.top ?? 0) + (last?.height ?? 0) + READER_PADDING * 2);
  });
});

describe("computeVisibleRange", () => {
  it("顶部时第一页可见", () => {
    const boxes = computePageBoxes(geos, 1);
    const r = computeVisibleRange(boxes, 0, 900);
    expect(r.first).toBe(1);
    expect(r.last).toBeGreaterThanOrEqual(1);
  });

  it("滚动越过第一页底部时第一页退出", () => {
    const boxes = computePageBoxes(geos, 1);
    // 第一页 bottom = 842；viewTop = scrollTop - READER_PADDING，必须 > 842 才算完全离开。
    const scrollTop = 842 + READER_PADDING + 10;
    const r = computeVisibleRange(boxes, scrollTop, 700);
    expect(r.first).toBe(2);
  });

  it("第一页仍有残留时不判定为退出", () => {
    const boxes = computePageBoxes(geos, 1);
    // scrollTop = 842 + 2 -> viewTop = 812 < 842，第一页仍可见（这是正确行为，不是 bug）。
    const r = computeVisibleRange(boxes, 842 + 2, 700);
    expect(r.first).toBe(1);
  });

  it("空文档返回空区间", () => {
    expect(computeVisibleRange([], 0, 800)).toEqual({ first: 1, last: 0 });
  });

  it("二分结果与线性扫描一致", () => {
    const boxes = computePageBoxes(geos, 1);
    for (const scrollTop of [0, 400, 1700, 3000, 7000]) {
      const r = computeVisibleRange(boxes, scrollTop, 800);
      const linear = boxes.filter(
        (b) => b.top + b.height > scrollTop - READER_PADDING && b.top < scrollTop + 800 - READER_PADDING,
      );
      expect(r.first).toBe(linear[0]?.pageNo);
      expect(r.last).toBe(linear[linear.length - 1]?.pageNo);
    }
  });
});

describe("优先级与预取", () => {
  it("当前页优先，预取页排在可见页之后", () => {
    const range = { first: 3, last: 5 };
    expect(pagePriority(4, range, 4)).toBe(0);
    expect(pagePriority(3, range, 4)).toBeLessThan(1000);
    expect(pagePriority(1, range, 4)).toBeGreaterThan(1000);
  });

  it("预取区间夹取到文档范围", () => {
    expect(expandForPrefetch({ first: 1, last: 2 }, 10, 2)).toEqual({ first: 1, last: 4 });
    expect(expandForPrefetch({ first: 9, last: 10 }, 10, 2)).toEqual({ first: 7, last: 10 });
  });
});

describe("缩放锚点与内存", () => {
  it("锚点缩放后同一页的相对位置不跳变", () => {
    const boxes = computePageBoxes(geos, 1);
    const scrollTop = anchorScrollTop(boxes, 3, 0.5, 2, geos);
    // 缩放后第 3 页应落在视口内：其 top 应小于 scrollTop
    const boxes2 = computePageBoxes(geos, 2);
    expect(boxes2[2]?.top).toBeLessThanOrEqual(scrollTop);
  });

  it("canvas 字节按 dpr 平方增长", () => {
    const a = canvasBytes(595, 842, 1, 1);
    const b = canvasBytes(595, 842, 1, 2);
    expect(b).toBe(a * 4);
  });

  it("单页模式当前页由视口中心决定", () => {
    const boxes = computePageBoxes(geos, 1);
    expect(currentPageAt(boxes, 0, 800)).toBe(1);
    expect(currentPageAt(boxes, 860, 800)).toBe(2);
  });
});
