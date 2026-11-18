// 主题应用（M13）：把 tokens 注入为 CSS 变量；paper 主题额外挂暖色光罩。
// 决策约束：切换不做过渡动效（A2）；光罩只覆盖页面容器，不碰 canvas 像素（D07/D06）。

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";

import { call } from "../core/ipc";
import { CMD } from "../contracts/cmd";
import { PAPER_VEIL, themes, toCssVariables, type ThemeName } from "./tokens";
import {
  PAGE_TONE_KEY,
  THEME_SOURCE_KEY,
  parsePageTone,
  parseThemeSource,
  themeForSystem,
  type PageTone,
  type ThemeSource,
} from "./theme-prefs";

interface ThemeContextValue {
  theme: ThemeName;
  paperVeil: boolean;
  /// 主题来源：手动选，还是跟随系统的深/浅色。
  themeSource: ThemeSource;
  /// 深色主题下的页面色调（PDF 页面本身是白的）。
  pageTone: PageTone;
  setTheme: (theme: ThemeName) => void;
  setPaperVeil: (on: boolean) => void;
  setThemeSource: (source: ThemeSource) => void;
  setPageTone: (tone: PageTone) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }): ReactElement {
  // 默认 light（M13 §7.2 第 3 条占位值；跟随系统由 D13/T13 决定但首版先按已存取值为准）。
  const [theme, setThemeState] = useState<ThemeName>("light");
  const [paperVeil, setPaperVeilState] = useState(true);
  const [themeSource, setThemeSourceState] = useState<ThemeSource>("manual");
  const [pageTone, setPageToneState] = useState<PageTone>("off");

  // 读取已存设置（失败不影响界面，用默认值）。
  useEffect(() => {
    void (async () => {
      try {
        const all = await call(CMD.SETTINGS_GET_ALL, {});
        const stored = all["ui.theme"];
        if (stored === "\"light\"" || stored === "\"dark\"" || stored === "\"paper\"") {
          setThemeState(stored.replace(/"/g, "") as ThemeName);
        }
        const veil = all["ui.paperVeil"];
        if (veil === "true" || veil === "false") setPaperVeilState(veil === "true");
        const source = parseThemeSource(all[THEME_SOURCE_KEY]);
        if (source !== null) setThemeSourceState(source);
        const tone = parsePageTone(all[PAGE_TONE_KEY]);
        if (tone !== null) setPageToneState(tone);
      } catch {
        // 数据库不可用时保持默认主题，不阻塞渲染。
      }
    })();
  }, []);

  // 注入 CSS 变量（同步写入，避免闪烁）。
  useEffect(() => {
    const root = document.documentElement;
    const vars = toCssVariables(theme);
    for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
    root.style.setProperty("--lg-paper-veil-opacity", paperVeil && theme === "paper" ? String(PAPER_VEIL.opacity) : "0");
    root.dataset.theme = theme;
    root.style.transition = "none"; // A2：主题切换不加动效
  }, [theme, paperVeil]);

  const persist = useCallback((key: string, value: string) => {
    void call(CMD.SETTINGS_SET, { key, value }).catch(() => {
      // 设置持久化失败不应打断使用（下次启动回默认值）。
    });
  }, []);

  const setTheme = useCallback(
    (next: ThemeName) => {
      setThemeState(next);
      persist("ui.theme", JSON.stringify(next));
    },
    [persist],
  );

  const setPaperVeil = useCallback(
    (on: boolean) => {
      setPaperVeilState(on);
      persist("ui.paperVeil", String(on));
    },
    [persist],
  );

  const setThemeSource = useCallback(
    (source: ThemeSource) => {
      setThemeSourceState(source);
      persist(THEME_SOURCE_KEY, source);
    },
    [persist],
  );

  const setPageTone = useCallback(
    (tone: PageTone) => {
      setPageToneState(tone);
      persist(PAGE_TONE_KEY, tone);
    },
    [persist],
  );

  // 跟随系统：订阅 prefers-color-scheme，系统深色切换时主题立刻跟上。
  // paper 不会被"跟随系统"选中（它是手动主题），只在系统深/浅两者间切换。
  useEffect(() => {
    if (themeSource !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => setThemeState(themeForSystem(query.matches));
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [themeSource]);

  const value = useMemo(
    () => ({ theme, paperVeil, themeSource, pageTone, setTheme, setPaperVeil, setThemeSource, setPageTone }),
    [theme, paperVeil, themeSource, pageTone, setTheme, setPaperVeil, setThemeSource, setPageTone],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) throw new Error("useTheme 必须在 ThemeProvider 内使用");
  return ctx;
}

export { themes };
