// 设置页里展示的快捷键表（唯一展示来源）。
//
// 为什么单独成数据模块：上一版的表只列了 6 条，实际实现里已经有 15+ 条（空格翻页、
// B 书签、T 目录、F11 全屏、Ctrl+滚轮、中键平移、右键面板…），文档与实现长期脱节。
// 现在表在这里，组件只负责渲染；改动快捷键时改这一处，并有单测兜住关键条目。

export interface KeymapEntry {
  /// 一个动作的按键组合，按顺序显示为多个 <kbd>。
  keys: string[];
  label: string;
  /// 可选的限定条件（例如「有内置目录时」）。
  note?: string;
}

export interface KeymapGroup {
  title: string;
  entries: KeymapEntry[];
}

export const KEYMAP: KeymapGroup[] = [
  {
    title: "全局",
    entries: [
      { keys: ["Ctrl", "K"], label: "库级搜索（在所有已索引文献的正文里查找）" },
      { keys: ["Esc"], label: "关闭当前浮层或面板" },
    ],
  },
  {
    title: "主页",
    entries: [
      { keys: ["←", "→"], label: "旋转书墙，切换焦点书" },
      { keys: ["Enter"], label: "打开焦点书" },
      { keys: ["滚轮"], label: "旋转书墙" },
      { keys: ["拖动"], label: "旋转书墙" },
    ],
  },
  {
    title: "阅读器",
    entries: [
      { keys: ["Ctrl", "F"], label: "文内搜索" },
      { keys: ["←", "→"], label: "上一页 / 下一页", note: "PageUp / PageDown 同效" },
      { keys: ["空格"], label: "下一页" },
      { keys: ["Shift", "空格"], label: "上一页" },
      { keys: ["+", "-"], label: "放大 / 缩小", note: "不带 Ctrl 也可以" },
      { keys: ["0"], label: "恢复 100%" },
      { keys: ["Ctrl", "滚轮"], label: "缩放" },
      { keys: ["M"], label: "连续滚动 / 单页翻页" },
      { keys: ["B"], label: "书签面板" },
      { keys: ["T"], label: "目录面板", note: "仅当文献有内置目录" },
      { keys: ["F11"], label: "全屏阅读" },
      { keys: ["Esc"], label: "逐级退出：搜索 → 书签 → 目录 → 功能面板 → 返回主页" },
      { keys: ["右键"], label: "在鼠标位置呼出功能面板" },
      { keys: ["中键拖动"], label: "平移页面", note: "放大到超出一屏时使用" },
      { keys: ["滚轮"], label: "滚动页面" },
    ],
  },
];

/// 拍平后的条目数（设置页用来显示「共 N 条」，也让单测好断言）。
export function keymapEntryCount(groups: KeymapGroup[] = KEYMAP): number {
  return groups.reduce((sum, group) => sum + group.entries.length, 0);
}
