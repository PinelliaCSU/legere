import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODE_OPTIONS,
  DEFAULT_SCALE_OPTIONS,
  formatScaleOption,
  parseDefaultMode,
  parseDefaultScale,
} from "./reader-prefs";

describe("阅读默认值（设置项）", () => {
  it("阅读模式只接受两个合法值，带引号的旧格式也能读", () => {
    expect(parseDefaultMode("single")).toBe("single");
    expect(parseDefaultMode('"single"')).toBe("single");
    expect(parseDefaultMode(" continuous ")).toBe("continuous");
    expect(parseDefaultMode("spread")).toBeNull();
    expect(parseDefaultMode("")).toBeNull();
    expect(parseDefaultMode(null)).toBeNull();
    expect(parseDefaultMode(undefined)).toBeNull();
  });

  it("默认缩放只接受正数", () => {
    expect(parseDefaultScale("1.25")).toBe(1.25);
    expect(parseDefaultScale('"1.25"')).toBe(1.25);
    expect(parseDefaultScale("0")).toBeNull();
    expect(parseDefaultScale("-2")).toBeNull();
    expect(parseDefaultScale("abc")).toBeNull();
    expect(parseDefaultScale(null)).toBeNull();
  });

  it("档位是 75% / 100% / 125% / 150%，模式只有两项", () => {
    expect(DEFAULT_SCALE_OPTIONS.map(formatScaleOption)).toEqual(["75%", "100%", "125%", "150%"]);
    expect(DEFAULT_MODE_OPTIONS.map((o) => o.value)).toEqual(["continuous", "single"]);
  });
});
