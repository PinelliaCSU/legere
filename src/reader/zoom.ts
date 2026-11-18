// M07 · 阅读器缩放参数与换算（本轮「触摸板双指捏合缩放」的实现基础）。
//
// 为什么单独成纯函数模块：缩放上下限、步进、捏合灵敏度这些数值需要被单测钉住，
// 也需要在按钮 / 键盘 / 滚轮 / 触摸四条输入路径之间保持一致。

/// 缩放上下限（沿用既有 25%–400%，不改既有行为）。
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;

/// 按钮与键盘的单步（既有行为：每次 10%）。
export const SCALE_STEP = 0.1;

/// 触摸板捏合 / Ctrl+滚轮 的灵敏度：指数映射，每 1px deltaY 约 0.22%。
/// 选指数而不是线性步进，是因为捏合是连续手势，线性步进会出现「一下跳 10%」的顿挫。
export const PINCH_WHEEL_PER_PX = 0.0022;

const PRECISION = 1000;

/// 夹取到 [MIN_SCALE, MAX_SCALE]，并收敛浮点噪声（否则 1.3000000000000003 会显示成 130.00000000000003%）。
export function clampScale(value: number): number {
  // NaN 没有可用语义（调用方算错了），回落到 1；±Infinity 是「超出量程」，按边界夹取。
  if (Number.isNaN(value)) return 1;
  const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
  return Math.round(clamped * PRECISION) / PRECISION;
}

/// 按钮 / 键盘的单步缩放。
export function scaleStep(current: number, direction: 1 | -1): number {
  return clampScale(current + direction * SCALE_STEP);
}

/// 滚轮 / 触摸板捏合。
///
/// Chromium（含 WebView2）把触摸板双指捏合合成为 **ctrlKey=true 的 wheel 事件**，
/// 所以捏合与「Ctrl+滚轮鼠标」天然是同一条路径，这里按连续比例换算。
/// deltaMode: 0=像素 1=行 2=页（Firefox 有行模式，Chromium 一般是像素，仍做兜底换算）。
export function scaleFromWheel(current: number, deltaY: number, deltaMode: number): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 100 : deltaY;
  if (!Number.isFinite(pixels) || pixels === 0) return clampScale(current);
  return clampScale(current * Math.exp(-pixels * PINCH_WHEEL_PER_PX));
}

export function formatScale(scale: number): string {
  return Math.round(scale * 100) + "%";
}

/// 页面两侧留白（CSS 像素）：页槽与视口边缘之间至少留这么多，避免贴边。
export const FIT_GUTTER_PX = 32;

/// 适应宽度：让页面宽度刚好放进视口。
/// 用「几何宽度（pt）」而不是当前缩放后的宽度，所以在任何缩放下都能一键回到合适大小。
export function fitWidthScale(pageWidthPt: number, viewportWidth: number, gutter: number = FIT_GUTTER_PX): number {
  if (!(pageWidthPt > 0) || !(viewportWidth > 0)) return 1;
  return clampScale((viewportWidth - gutter * 2) / pageWidthPt);
}

/// 适应页面：宽高都要放得下，取两者较小的比例。
/// 单页翻阅时用这个最合适（整页可见、不用滚）。
export function fitPageScale(
  pageWidthPt: number,
  pageHeightPt: number,
  viewportWidth: number,
  viewportHeight: number,
  gutter: number = FIT_GUTTER_PX,
): number {
  if (!(pageWidthPt > 0) || !(pageHeightPt > 0)) return 1;
  const byWidth = fitWidthScale(pageWidthPt, viewportWidth, gutter);
  const byHeight = viewportHeight > 0 ? (viewportHeight - gutter * 2) / pageHeightPt : byWidth;
  return clampScale(Math.min(byWidth, byHeight));
}
