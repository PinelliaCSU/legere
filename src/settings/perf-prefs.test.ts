import { describe, expect, it } from "vitest";

import {
  IDLE_TEXT_PREFETCH_MAX,
  PERF_IDLE_TEXT_PREFETCH_KEY,
  PERF_PRELOAD_DOC_MAX_KEY,
  formatIdleTextPrefetch,
  nextIdleTextPrefetch,
  parseIdleTextPrefetch,
  parsePreloadDocMax,
} from "./perf-prefs";

describe("性能设置项（P2-1 / P2-2）", () => {
  it("存储键命名遵循 <域>.<项>", () => {
    expect(PERF_IDLE_TEXT_PREFETCH_KEY).toBe("perf.idleTextPrefetchPages");
    expect(PERF_PRELOAD_DOC_MAX_KEY).toBe("perf.preloadDocumentMax");
  });

  it("空闲预取默认关闭，非法值一律回 0", () => {
    expect(parseIdleTextPrefetch(null)).toBe(0);
    expect(parseIdleTextPrefetch(undefined)).toBe(0);
    expect(parseIdleTextPrefetch("")).toBe(0);
    expect(parseIdleTextPrefetch("abc")).toBe(0);
    expect(parseIdleTextPrefetch("0")).toBe(0);
    expect(parseIdleTextPrefetch("-3")).toBe(0);
  });

  it("空闲预取接受合法值并夹取上限", () => {
    expect(parseIdleTextPrefetch("2")).toBe(2);
    expect(parseIdleTextPrefetch('"4"')).toBe(4);
    expect(parseIdleTextPrefetch("99")).toBe(IDLE_TEXT_PREFETCH_MAX);
  });

  it("(待补充) 文档常驻预加载恒为 0", () => {
    expect(parsePreloadDocMax("3")).toBe(0);
    expect(parsePreloadDocMax(null)).toBe(0);
  });

  it("菜单档位 0 → 2 → 4 → 0", () => {
    expect(nextIdleTextPrefetch(0)).toBe(2);
    expect(nextIdleTextPrefetch(2)).toBe(4);
    expect(nextIdleTextPrefetch(4)).toBe(0);
    expect(formatIdleTextPrefetch(0)).toBe("关闭");
    expect(formatIdleTextPrefetch(4)).toBe("+4 页");
  });
});
