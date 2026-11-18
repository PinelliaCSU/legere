import { describe, expect, it } from "vitest";

import {
  FIT_GUTTER_PX,
  MAX_SCALE,
  MIN_SCALE,
  PINCH_WHEEL_PER_PX,
  SCALE_STEP,
  clampScale,
  fitPageScale,
  fitWidthScale,
  formatScale,
  scaleFromWheel,
  scaleStep,
} from "./zoom";

describe("缩放参数（既有限制保持不变）", () => {
  it("适应宽度的默认留白是 32px", () => {
    expect(FIT_GUTTER_PX).toBe(32);
  });

  it("上下限是 25% 与 400%", () => {
    expect(MIN_SCALE).toBe(0.25);
    expect(MAX_SCALE).toBe(4);
    expect(clampScale(0.01)).toBe(0.25);
    expect(clampScale(99)).toBe(4);
    expect(clampScale(1.5)).toBe(1.5);
  });

  it("非法输入回落到 1.0，不产生 NaN 缩放", () => {
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(4);
  });

  it("浮点噪声被收敛到 3 位（0.25 + 0.1 不是 0.35000000000000003）", () => {
    expect(scaleStep(0.25, 1)).toBe(0.35);
    expect(scaleStep(0.35, -1)).toBe(0.25);
    expect(formatScale(scaleStep(1, 1))).toBe("110%");
  });

  it("单步是 10%，到边界后被夹住", () => {
    expect(SCALE_STEP).toBe(0.1);
    expect(scaleStep(1, 1)).toBeCloseTo(1.1, 6);
    expect(scaleStep(MAX_SCALE, 1)).toBe(MAX_SCALE);
    expect(scaleStep(MIN_SCALE, -1)).toBe(MIN_SCALE);
  });
});

describe("触摸板捏合换算（ctrl+wheel）", () => {
  it("向上捏（deltaY<0）放大，向下捏缩小", () => {
    expect(scaleFromWheel(1, -50, 0)).toBeGreaterThan(1);
    expect(scaleFromWheel(1, 50, 0)).toBeLessThan(1);
  });

  it("放大再缩小回到原点附近（指数映射对称）", () => {
    const up = scaleFromWheel(1, -40, 0);
    const back = scaleFromWheel(up, 40, 0);
    expect(back).toBeCloseTo(1, 2);
  });

  it("灵敏度就是 PINCH_WHEEL_PER_PX：100px 约 1.25 倍", () => {
    expect(PINCH_WHEEL_PER_PX).toBe(0.0022);
    expect(scaleFromWheel(1, -100, 0)).toBeCloseTo(Math.exp(0.22), 3);
  });

  it("行模式（deltaMode=1）按 16px/行换算，不会一下跳到边界", () => {
    const lines = scaleFromWheel(1, -1, 1);
    const pixels = scaleFromWheel(1, -16, 0);
    expect(lines).toBeCloseTo(pixels, 6);
  });

  it("捏合不会越过 25%–400%", () => {
    expect(scaleFromWheel(1, -10000, 0)).toBe(MAX_SCALE);
    expect(scaleFromWheel(1, 10000, 0)).toBe(MIN_SCALE);
  });

  it("deltaY=0 不改变缩放（避免无意义的 setState）", () => {
    expect(scaleFromWheel(1.4, 0, 0)).toBe(1.4);
  });
});

describe("适应宽度 / 适应页面（一键到位）", () => {
  it("适应宽度把页面宽度刚好放进视口（两侧各留 FIT_GUTTER_PX）", () => {
    const scale = fitWidthScale(576, 1000);
    expect(scale).toBeCloseTo((1000 - 64) / 576, 3);
    expect(576 * scale).toBeCloseTo(936, 1);
  });

  it("视口很宽时受 MAX_SCALE 约束，不会无限放大", () => {
    expect(fitWidthScale(100, 10000)).toBe(MAX_SCALE);
  });

  it("视口很窄时受 MIN_SCALE 约束", () => {
    expect(fitWidthScale(5000, 300)).toBe(MIN_SCALE);
  });

  it("适应页面取宽高比例的较小者（高度是瓶颈时以高度为准）", () => {
    const scale = fitPageScale(576, 836, 1000, 600);
    expect(scale).toBeCloseTo((600 - 64) / 836, 3);
    expect(836 * scale).toBeLessThanOrEqual(600 - 64 + 0.001);
  });

  it("宽是瓶颈时以宽度为准", () => {
    const scale = fitPageScale(576, 836, 400, 2000);
    expect(scale).toBeCloseTo((400 - 64) / 576, 3);
  });

  it("非法几何不崩，回落到 1", () => {
    expect(fitWidthScale(0, 1000)).toBe(1);
    expect(fitWidthScale(576, 0)).toBe(1);
    expect(fitPageScale(576, 0, 1000, 800)).toBe(1);
  });
});
