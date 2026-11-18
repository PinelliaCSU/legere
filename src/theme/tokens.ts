// 主题令牌（docs/15-theme-tokens.md，决策 D05/D06 已定）。
// 这里是 45 个色值的唯一来源；组件只允许引用 var(--lg-*)，不得硬编码颜色。

export const THEME_TOKEN_KEYS = [
  "bg-app",
  "bg-surface",
  "bg-elevated",
  "border-subtle",
  "border-strong",
  "fg-primary",
  "fg-secondary",
  "fg-muted",
  "accent",
  "accent-fg",
  "page-bg",
  "page-border",
  "hit-bg",
  "hit-active-bg",
  "hit-active-border",
] as const;

export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];
export type ThemeName = "light" | "dark" | "paper";
export type ThemeTokens = Record<ThemeTokenKey, string>;

export const themes: Record<ThemeName, ThemeTokens> = {
  light: {
    "bg-app": "#F5F7F9",
    "bg-surface": "#FFFFFF",
    "bg-elevated": "#FBFCFD",
    "border-subtle": "#E2E8EE",
    "border-strong": "#C6D0D9",
    "fg-primary": "#1B2430",
    "fg-secondary": "#55636F",
    "fg-muted": "#8A96A1",
    "accent": "#3E7B6B",
    "accent-fg": "#FFFFFF",
    "page-bg": "#EDF0F3",
    "page-border": "#DCE3E9",
    "hit-bg": "#FFE9A8",
    "hit-active-bg": "#FFD666",
    "hit-active-border": "#C99A2E",
  },
  dark: {
    "bg-app": "#12171C",
    "bg-surface": "#1A2027",
    "bg-elevated": "#222A32",
    "border-subtle": "#2C353D",
    "border-strong": "#3D4852",
    "fg-primary": "#E6EBEF",
    "fg-secondary": "#A8B3BC",
    "fg-muted": "#78848E",
    "accent": "#5FA391",
    "accent-fg": "#0F1418",
    "page-bg": "#0E1216",
    "page-border": "#2B333A",
    "hit-bg": "#57491B",
    "hit-active-bg": "#7C6526",
    "hit-active-border": "#C9A83C",
  },
  paper: {
    "bg-app": "#F3EAD9",
    "bg-surface": "#FBF5E9",
    "bg-elevated": "#F7F0E1",
    "border-subtle": "#E5D9C3",
    "border-strong": "#D2C3A8",
    "fg-primary": "#33291C",
    "fg-secondary": "#6B5B45",
    "fg-muted": "#9A8A72",
    "accent": "#8C5E3C",
    "accent-fg": "#FFF7EA",
    "page-bg": "#EFE4D0",
    "page-border": "#DFD1B8",
    "hit-bg": "#F6D98A",
    "hit-active-bg": "#E8C46A",
    "hit-active-border": "#A8813A",
  },
};

/// 暖色纸光罩（D06）：只叠在页面容器上，不触碰 canvas 像素。
export const PAPER_VEIL = { color: "#C9A063", opacity: 0.06, blend: "multiply" } as const;

/// 转成 CSS 变量表（供根元素 style 注入）。
export function toCssVariables(theme: ThemeName): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const key of THEME_TOKEN_KEYS) {
    vars[`--lg-${key}`] = themes[theme][key];
  }
  vars["--lg-overlay-tint"] = PAPER_VEIL.color;
  vars["--lg-overlay-opacity"] = String(PAPER_VEIL.opacity);
  return vars;
}
