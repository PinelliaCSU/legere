// 主题相关设置项的解析与派生（设置界面 + ReaderView 共用）。
//
// 三件事：
//   1. 主题来源：手动选（light/dark/paper）还是跟随系统；
//   2. 系统偏好 → 主题名（跟随系统时深色用 dark，浅色用 light；paper 只能手动选）；
//   3. 深色主题下的页面色调（PDF 页面本身是白的，夜里刺眼）：不处理 / 调暗 / 反色。

import type { ThemeName } from "./tokens";

export type ThemeSource = "manual" | "system";
export type PageTone = "off" | "dim" | "invert";

export const THEME_SOURCE_KEY = "ui.themeSource";
export const PAGE_TONE_KEY = "ui.pageTone";

export const THEME_SOURCE_OPTIONS: { value: ThemeSource; label: string }[] = [
  { value: "manual", label: "手动" },
  { value: "system", label: "跟随系统" },
];

export const PAGE_TONE_OPTIONS: { value: PageTone; label: string; hint: string }[] = [
  { value: "off", label: "不处理", hint: "页面保持纸白" },
  { value: "dim", label: "调暗", hint: "整体压暗，图片颜色不变" },
  { value: "invert", label: "反色", hint: "字变浅、底变深；图片也会被反色" },
];

export function parseThemeSource(raw: string | null | undefined): ThemeSource | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.replace(/"/g, "").trim();
  return value === "manual" || value === "system" ? value : null;
}

export function parsePageTone(raw: string | null | undefined): PageTone | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.replace(/"/g, "").trim();
  return value === "off" || value === "dim" || value === "invert" ? value : null;
}

/// 跟随系统：深色系统用 dark，浅色系统用 light。
/// paper 是"纸感"主题，只可能来自手动选择，跟随系统不会选中它。
export function themeForSystem(isDark: boolean): ThemeName {
  return isDark ? "dark" : "light";
}

/// 页面色调只有在深色主题下才有意义（浅色/纸白主题下调暗只会显得脏）。
export function readerToneClass(theme: ThemeName, tone: PageTone): string {
  if (theme !== "dark" || tone === "off") return "";
  return tone === "dim" ? "tone-dim" : "tone-invert";
}

export const UI_FONT_SIZES = [90, 100, 115, 130, 150] as const;
export type UiFontSize = (typeof UI_FONT_SIZES)[number];

export function parseUiFontSize(raw: string | undefined): UiFontSize {
  return UI_FONT_SIZES.find(size => String(size) === raw) ?? 100;
}
