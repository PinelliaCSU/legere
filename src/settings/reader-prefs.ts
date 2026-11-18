// 阅读默认值（设置项）：这本书还没有阅读进度时用哪套初始状态。
//
// 存储键与 docs/15 的命名风格一致（<域>.<项>），值是纯文本，不依赖 JSON 引号。
// 读过一次之后 progress 表就有记录，默认值不再生效——这是刻意的：
// 用户已经在这本书里调过的东西不该被设置覆盖。

import type { ReadMode } from "../contracts/types";

export const READER_DEFAULT_MODE_KEY = "reader.defaultMode";
export const READER_DEFAULT_SCALE_KEY = "reader.defaultScale";

export const DEFAULT_MODE_OPTIONS: { value: ReadMode; label: string }[] = [
  { value: "continuous", label: "连续滚动" },
  { value: "single", label: "单页翻页" },
];

export const DEFAULT_SCALE_OPTIONS: number[] = [0.75, 1, 1.25, 1.5];

/// 解析设置值：非法/缺失都返回 null，由调用方保住当前值。
export function parseDefaultMode(raw: string | null | undefined): ReadMode | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.replace(/"/g, "").trim();
  return value === "continuous" || value === "single" ? value : null;
}

export function parseDefaultScale(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const value = Number(raw.replace(/"/g, "").trim());
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function formatScaleOption(scale: number): string {
  return Math.round(scale * 100) + "%";
}
