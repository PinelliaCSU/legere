import { describe, expect, it } from "vitest";

import { anchorScrollTop, canvasBytes, computePageBoxes, computeVisibleRange, PAGE_GAP, READER_PADDING } from "./layout";
import type { PageGeometry } from "../pdf-engine/types";

const geo = (widthPt: number, heightPt: number, rotation: 0 | 90 | 180 | 270 = 0): PageGeometry => ({
  widthPt,
  heightPt,
  rotation,
});

describe("页几何（大页 / 旋转页 / 高 DPI）", () => {
  it("大页的页槽尺寸按 scale 线性增长，且宽度不被截断", () => {
    const a0 = computePageBoxes([geo(2384, 3370)], 1);
    expect(a0[0]!.width).toBeCloseTo(2384, 6);
    expect(a0[0]!.height).toBeCloseTo(3370, 6);
    const zoomed = computePageBoxes([geo(2384, 3370)], 2.5);
    expect(zoomed[0]!.width).toBeCloseTo(5960, 6);
  });

  it("旋转页：几何宽高已由引擎交换，页槽不再二次交换", () => {
    const boxes = computePageBoxes([geo(842, 595, 90)], 1);
    expect(boxes[0]!.width).toBeCloseTo(842, 6);
    expect(boxes[0]!.height).toBeCloseTo(595, 6);
  });

  it("高 DPI 下 canvas 像素数按 dpr² 增长（内存预算的判据）", () => {
    const base = canvasBytes(595, 842, 1, 1);
    const dpr2 = canvasBytes(595, 842, 1, 2);
    expect(dpr2).toBe(base * 4);
  });

  it("多页累计偏移含页间距，可见区间与滚动位置一致", () => {
    const geos = [geo(600, 800), geo(600, 800), geo(600, 800)];
    const boxes = computePageBoxes(geos, 1);
    expect(boxes[1]!.top).toBeCloseTo(800 + PAGE_GAP, 6);
    expect(boxes[2]!.top).toBeCloseTo(2 * (800 + PAGE_GAP), 6);

    const firstPageOnly = computeVisibleRange(boxes, READER_PADDING, 800);
    expect(firstPageOnly.first).toBe(1);
    const secondPage = computeVisibleRange(boxes, READER_PADDING + 812, 800);
    expect(secondPage.first).toBe(2);
  });

  it("缩放后当前页顶部仍在视口顶部（不跳回开头）", () => {
    const geos = [geo(600, 800), geo(600, 800)];
    const before = computePageBoxes(geos, 1);
    // 页间距是不随缩放变化的 CSS 像素（D17），所以 2 倍缩放下第 2 页顶部 = 2×800 + 12。
    const scrollTop = anchorScrollTop(before, 2, 0, 2, geos);
    expect(scrollTop).toBeCloseTo(2 * 800 + PAGE_GAP + READER_PADDING, 6);
    // 再缩放回 1.0 应该回到原始位置
    const back = anchorScrollTop(computePageBoxes(geos, 2), 2, 0, 1, geos);
    expect(back).toBeCloseTo(800 + PAGE_GAP + READER_PADDING, 6);
  });
});
