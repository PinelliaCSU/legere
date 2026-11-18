import { describe, expect, it } from "vitest";

import {
  PAGE_TONE_OPTIONS,
  THEME_SOURCE_OPTIONS,
  parsePageTone,
  parseThemeSource,
  readerToneClass,
  themeForSystem,
} from "./theme-prefs";

describe("主题设置项", () => {
  it("主题来源只接受 manual / system", () => {
    expect(parseThemeSource("system")).toBe("system");
    expect(parseThemeSource('"manual"')).toBe("manual");
    expect(parseThemeSource("auto")).toBeNull();
    expect(parseThemeSource(null)).toBeNull();
  });

  it("页面色调只接受三档", () => {
    expect(parsePageTone("off")).toBe("off");
    expect(parsePageTone('"dim"')).toBe("dim");
    expect(parsePageTone("invert")).toBe("invert");
    expect(parsePageTone("black")).toBeNull();
    expect(parsePageTone(undefined)).toBeNull();
  });

  it("跟随系统只会在 light / dark 之间切换，不会选中 paper", () => {
    expect(themeForSystem(true)).toBe("dark");
    expect(themeForSystem(false)).toBe("light");
  });

  it("页面色调只在深色主题下生效", () => {
    expect(readerToneClass("dark", "dim")).toBe("tone-dim");
    expect(readerToneClass("dark", "invert")).toBe("tone-invert");
    expect(readerToneClass("dark", "off")).toBe("");
    expect(readerToneClass("light", "dim")).toBe("");
    expect(readerToneClass("paper", "invert")).toBe("");
  });

  it("选项文案齐备", () => {
    expect(THEME_SOURCE_OPTIONS.map((o) => o.value)).toEqual(["manual", "system"]);
    expect(PAGE_TONE_OPTIONS.map((o) => o.value)).toEqual(["off", "dim", "invert"]);
    expect(PAGE_TONE_OPTIONS.every((o) => o.hint.length > 0)).toBe(true);
  });
});
