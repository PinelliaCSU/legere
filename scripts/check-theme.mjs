#!/usr/bin/env node
// 主题令牌校验（docs/15-theme-tokens.md §3）：
// 1) 三套主题键集合必须完全一致且为 15 个；
// 2) 对比度门槛：正文/次级/强调按钮/页面底色。
// 纯 Node 实现（不依赖 node_modules），CI 可直接跑。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src/theme/tokens.ts"), "utf8");

const hexToRgb = (hex) => {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
const srgb = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const luminance = (hex) => {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
};
const contrast = (a, b) => {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

// 解析 themes 对象（按主题块提取 key: value）
const themeBlocks = {};
for (const name of ["light", "dark", "paper"]) {
  const re = new RegExp(`${name}\\s*:\\s*\\{([\\s\\S]*?)\\n  \\},`, "m");
  const m = re.exec(src);
  if (!m) {
    console.error(`找不到主题块: ${name}`);
    process.exit(1);
  }
  const tokens = {};
  for (const line of m[1].split("\n")) {
    const kv = /"([a-z-]+)":\s*"(#[0-9A-Fa-f]{6})"/.exec(line);
    if (kv) tokens[kv[1]] = kv[2];
  }
  themeBlocks[name] = tokens;
}

const problems = [];
const keysets = Object.entries(themeBlocks).map(([name, t]) => [name, Object.keys(t).sort().join(",")]);
const [, firstKeyset] = keysets[0];
for (const [name, ks] of keysets) {
  if (ks !== firstKeyset) problems.push(`主题 ${name} 的键集合与 light 不一致`);
}
const keyCount = firstKeyset.split(",").length;
if (keyCount !== 15) problems.push(`每个主题应有 15 个令牌，实际 ${keyCount}`);

const thresholds = [
  ["fg-primary", "bg-surface", 10, "正文"],
  ["fg-secondary", "bg-surface", 4.5, "次级文本"],
  ["fg-muted", "bg-surface", 3, "弱提示"],
  ["accent-fg", "accent", 4.5, "强调按钮"],
  ["fg-primary", "page-bg", 7, "页面底色上的正文"],
];

for (const [name, tokens] of Object.entries(themeBlocks)) {
  for (const [fg, bg, min, label] of thresholds) {
    const ratio = contrast(tokens[fg], tokens[bg]);
    if (ratio < min) {
      problems.push(`${name}: ${label} ${fg}/${bg} 对比度 ${ratio.toFixed(2)} < ${min}`);
    }
  }
}

if (problems.length) {
  console.error("主题校验失败:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(`主题校验通过：3 套 × ${keyCount} 令牌，对比度全部达标`);
