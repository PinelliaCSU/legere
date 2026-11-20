import { describe, expect, it } from "vitest";

import {
  PREFETCH_TIER,
  SCALE_MISS_MAX,
  computePageBoxes,
  pageScore,
  shouldSkipPrefetch,
  type PageBox,
  type PriorityContext,
} from "./layout";

/// docs/08 §3 第 75 行的算例：vh=800、视口中心 400、scale=1.5、向下滚动。
/// 断言只看排序（B ≺ C ≺ A），不看分数绝对值 —— 与 docs/12 第 76 行一致。
function box(pageNo: number, center: number, height = 800): PageBox {
  return { pageNo, width: 600, height, top: center - height / 2 };
}

function context(over: Partial<PriorityContext> = {}): PriorityContext {
  return {
    range: { first: 1, last: 3 },
    scrollTop: 0,
    viewportHeight: 800,
    currentPage: 1,
    scrollSign: 1,
    scale: 1.5,
    cachedScaleOf: () => 1.5,
    ...over,
  };
}

describe("调度打分（P1-3）", () => {
  it("复现 docs/08 §3 的算例顺序：下方在前 > 更下方 > 上方缩放失配", () => {
    const cachedScaleOf = (pageNo: number): number | null => (pageNo === 1 ? 1.0 : 1.5);
    // 算例里三页都不是「当前页」（当前页加分只属于 cur_i 那一项）。
    const ctx = context({ cachedScaleOf, currentPage: 99 });
    const a = pageScore(box(1, 100), ctx);
    const b = pageScore(box(2, 700), ctx);
    const c = pageScore(box(3, 1400), ctx);
    expect(b).toBeLessThan(c);
    expect(c).toBeLessThan(a);
    // 算例给出的数值：-0.125 / 0.75 / 1.545
    expect(b).toBeCloseTo(-0.125, 3);
    expect(c).toBeCloseTo(0.75, 3);
    expect(a).toBeCloseTo(1.545, 3);
  });

  it("同样距离下，滚动方向前方的一页更优先", () => {
    const down = context({ scrollSign: 1 });
    const up = context({ scrollSign: -1 });
    const below = box(2, 700);
    const above = box(3, 100);
    // 向下滚动：下方页（700）优于上方页（100）
    expect(pageScore(below, down)).toBeLessThan(pageScore(above, down));
    // 向上滚动：反过来
    expect(pageScore(above, up)).toBeLessThan(pageScore(below, up));
  });

  it("当前页优先于同距离的相邻页", () => {
    const ctx = context({ currentPage: 2, range: { first: 1, last: 3 } });
    const current = pageScore(box(2, 400), ctx);
    const adjacent = pageScore(box(1, 400), ctx);
    expect(current).toBeLessThan(adjacent);
  });

  it("无缓存位的页（missMax）排在缩放匹配的页之后", () => {
    const ctx = context({ cachedScaleOf: (p) => (p === 1 ? 1.5 : null), currentPage: 99 });
    const hit = pageScore(box(1, 400), ctx);
    const miss = pageScore(box(2, 400), ctx);
    expect(miss - hit).toBeCloseTo(2.0 * SCALE_MISS_MAX, 5);
  });

  it("预取页永远排在所有可见页之后", () => {
    const ctx = context({ range: { first: 1, last: 3 }, cachedScaleOf: () => null });
    const worstVisible = pageScore(box(3, 20000), context({ range: { first: 1, last: 3 }, cachedScaleOf: () => null }));
    const bestPrefetch = pageScore(box(4, 400), ctx);
    expect(bestPrefetch).toBeGreaterThan(worstVisible);
    expect(bestPrefetch).toBeGreaterThan(PREFETCH_TIER);
  });

  it("跳页保护按可见跨度判定", () => {
    // docs/08 §2：last − first > 30 才跳过预取，等于 30 仍然预取。
    expect(shouldSkipPrefetch({ first: 1, last: 20 })).toBe(false);
    expect(shouldSkipPrefetch({ first: 1, last: 31 })).toBe(false);
    expect(shouldSkipPrefetch({ first: 1, last: 32 })).toBe(true);
    expect(shouldSkipPrefetch({ first: 100, last: 101 })).toBe(false);
  });

  it("打分与盒子计算一致：真实几何下当前页得分最低", () => {
    const geometries = Array.from({ length: 5 }, () => ({ widthPt: 595, heightPt: 842, rotation: 0 as const }));
    const boxes = computePageBoxes(geometries, 1);
    const ctx = context({
      range: { first: 1, last: 3 },
      viewportHeight: 842,
      scrollTop: 842 + 12,
      currentPage: 2,
      scale: 1,
      cachedScaleOf: () => 1,
    });
    const scores = boxes.map((b) => ({ pageNo: b.pageNo, score: pageScore(b, ctx) }));
    scores.sort((x, y) => x.score - y.score);
    expect(scores[0]?.pageNo).toBe(2);
  });
});
