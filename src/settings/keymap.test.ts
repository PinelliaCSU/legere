import { describe, expect, it } from "vitest";

import { KEYMAP, keymapEntryCount } from "./keymap";

describe("快捷键表（设置页展示）", () => {
  it("每条都有按键与说明，分组非空", () => {
    expect(KEYMAP.length).toBeGreaterThanOrEqual(3);
    for (const group of KEYMAP) {
      expect(group.title.length).toBeGreaterThan(0);
      expect(group.entries.length).toBeGreaterThan(0);
      for (const entry of group.entries) {
        expect(entry.keys.length).toBeGreaterThan(0);
        expect(entry.keys.every((k) => k.trim().length > 0)).toBe(true);
        expect(entry.label.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("已经实现的快捷键都必须出现在表里（防止文档与实现脱节）", () => {
    const all = KEYMAP.flatMap((g) => g.entries);
    const has = (keys: string[]) => all.some((e) => e.keys.join("+") === keys.join("+"));
    // 这些是代码里真实存在的分支（ReaderView / HomeSpace / AppShell 的 keydown）
    expect(has(["Ctrl", "F"])).toBe(true);
    expect(has(["Ctrl", "K"])).toBe(true);
    expect(has(["空格"])).toBe(true);
    expect(has(["Shift", "空格"])).toBe(true);
    expect(has(["M"])).toBe(true);
    expect(has(["B"])).toBe(true);
    expect(has(["T"])).toBe(true);
    expect(has(["F11"])).toBe(true);
    expect(has(["0"])).toBe(true);
    expect(has(["Ctrl", "滚轮"])).toBe(true);
    expect(has(["右键"])).toBe(true);
    expect(has(["中键拖动"])).toBe(true);
    expect(has(["Esc"])).toBe(true);
    expect(has(["←", "→"])).toBe(true);
    expect(has(["Enter"])).toBe(true);
  });

  it("条目总数可统计（设置页显示用）", () => {
    expect(keymapEntryCount()).toBe(KEYMAP.reduce((n, g) => n + g.entries.length, 0));
    expect(keymapEntryCount()).toBeGreaterThanOrEqual(15);
  });
});
