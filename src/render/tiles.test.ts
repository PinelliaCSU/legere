import { describe, expect, it } from "vitest";
import { planTiles } from "./tiles";
import type { ViewportState } from "./types";

describe("viewport tiles", () => {
  const box = { pageNo: 1, width: 50000, height: 30000, top: 0 };
  const viewport: ViewportState = { mode: "single", currentPage: 1, scale: 4, pixelRatio: 2,
    scrollTop: 15032, scrollLeft: 30000, viewportWidth: 1200, viewportHeight: 800, pageGeometries: [] };
  it("covers a panned HiDPI viewport, rendering visible tiles first", () => {
    const plan = planTiles([box], viewport, 1, 0);
    expect(plan.length).toBeLessThanOrEqual(30);
    const visible = plan.filter(t => t.visible);
    expect(plan.slice(0, visible.length)).toEqual(visible);
    for (const x of [60000, 62399]) for (const y of [30000, 31599]) {
      expect(visible.some(t => t.clip && x >= t.clip.x && x < t.clip.x + t.clip.w &&
        y >= t.clip.y && y < t.clip.y + t.clip.h)).toBe(true);
    }
    expect(plan.every(t => t.clip!.w <= 1024 && t.clip!.h <= 1024)).toBe(true);
  });
});
