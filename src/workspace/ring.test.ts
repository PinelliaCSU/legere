import { describe, expect, it } from "vitest";

import {
  RING,
  focusIndex,
  initialBaseRad,
  isVisible,
  layoutSpines,
  maxMountedSpines,
  normalizeAngle,
  ringCenter,
} from "./ring";

describe("环几何（D01/D02/D03）", () => {
  it("半径取 min(vw,vh) 的 0.34，环心上移 4%", () => {
    const c = ringCenter(1280, 800);
    expect(c.radius).toBeCloseTo(0.34 * 800);
    expect(c.cx).toBe(640);
    expect(c.cy).toBeCloseTo(400 - 0.04 * 800);
  });

  it("可见弧为 200°：正前方向两侧 100° 内可见", () => {
    const focus = Math.PI / 2;
    expect(isVisible(focus, focus)).toBe(true);
    expect(isVisible(focus + (99 * Math.PI) / 180, focus)).toBe(true);
    expect(isVisible(focus - (99 * Math.PI) / 180, focus)).toBe(true);
    expect(isVisible(focus + (101 * Math.PI) / 180, focus)).toBe(false);
  });

  it("角度归一化到 (-π, π]", () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(Math.PI * 2)).toBeCloseTo(0);
    // ±π 是同一个方向，只要求模长正确。
    expect(Math.abs(normalizeAngle(-Math.PI * 3))).toBeCloseTo(Math.PI);
  });
});

describe("书脊布局（D07/D08）", () => {
  it("深度决定 scale/opacity/zIndex，越靠前越大", () => {
    const center = ringCenter(1200, 900);
    const layouts = layoutSpines(12, initialBaseRad(12), Math.PI / 2, center);
    const near = layouts.reduce((a, b) => (a.depth > b.depth ? a : b));
    const far = layouts.reduce((a, b) => (a.depth < b.depth ? a : b));
    expect(near.scale).toBeGreaterThan(far.scale);
    expect(near.opacity).toBeGreaterThan(far.opacity);
    expect(near.zIndex).toBeGreaterThan(far.zIndex);
    expect(far.scale).toBeCloseTo(RING.scaleFar, 2);
  });

  it("可见书脊数不超过 ceil(visibleArc/360×N)+2", () => {
    for (const total of [1, 2, 12, 60]) {
      const center = ringCenter(1200, 900);
      const layouts = layoutSpines(total, initialBaseRad(total), Math.PI / 2, center);
      const visibleCount = layouts.filter((l) => l.visible).length;
      expect(visibleCount).toBeLessThanOrEqual(maxMountedSpines(total));
    }
  });

  it("书脊按径向摆放（rotation = 角度 + 90°）", () => {
    const center = ringCenter(1000, 1000);
    const layouts = layoutSpines(8, 0, Math.PI / 2, center);
    const first = layouts[0];
    expect(first).toBeDefined();
    expect(first?.rotationDeg).toBeCloseTo((0 * 180) / Math.PI + 90);
  });
});

describe("焦点书", () => {
  it("焦点是最接近正前方向的那本", () => {
    const center = ringCenter(1000, 1000);
    const base = initialBaseRad(12);
    const layouts = layoutSpines(12, base, Math.PI / 2, center);
    const idx = focusIndex(layouts, Math.PI / 2);
    const target = layouts.find((l) => l.index === idx);
    expect(target).toBeDefined();
    const diff = Math.abs(normalizeAngle((target?.angle ?? 0) - Math.PI / 2));
    for (const l of layouts) {
      expect(diff).toBeLessThanOrEqual(Math.abs(normalizeAngle(l.angle - Math.PI / 2)) + 1e-9);
    }
  });
});
