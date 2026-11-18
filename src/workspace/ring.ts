// 主页空间转盘几何（docs/13-ui-home-concept.md，D01–D04 已冻结）。
// 纯函数：不碰 DOM，便于按 13 §8 的验收条件做单测。

export const RING = {
  /// D01：R = 0.34 × min(vw, vh)
  radiusRatio: 0.34,
  /// D01：环心上移 4% 视口高
  centerOffsetRatio: -0.04,
  /// D02：可见弧 200°
  visibleArcDeg: 200,
  /// D03：书脊长度 = 0.42R，宽度固定 28px
  spineHeightRatio: 0.42,
  spineWidthPx: 28,
  /// D04：字号随深度略微缩小
  fontSizeNear: 15,
  fontSizeFar: 12,
  /// D07：纵深
  scaleFar: 0.86,
  opacityFar: 0.55,
  /// Δ 的角距下限（少书时不挤在一起）
  minSlots: 12,
} as const;

export interface RingCenter {
  cx: number;
  cy: number;
  radius: number;
}

export function ringCenter(viewportWidth: number, viewportHeight: number): RingCenter {
  const radius = RING.radiusRatio * Math.min(viewportWidth, viewportHeight);
  return {
    cx: viewportWidth / 2,
    cy: viewportHeight / 2 + RING.centerOffsetRatio * viewportHeight,
    radius,
  };
}

/// 第 i 本书的角度（弧度，0 = 正右方向）。
export function angleFor(index: number, total: number, baseRad: number): number {
  const slots = Math.max(total, RING.minSlots);
  return baseRad + (index * 2 * Math.PI) / slots;
}

/// 归一化到 (-π, π]。
export function normalizeAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  let a = angle % twoPi;
  if (a <= -Math.PI) a += twoPi;
  else if (a > Math.PI) a -= twoPi;
  return a;
}

/// 是否落在可见弧内（**隐藏弧内不生成 DOM**，13 §2 绝对约束）。
export function isVisible(angle: number, focusRad: number): boolean {
  const half = (RING.visibleArcDeg * Math.PI) / 360;
  return Math.abs(normalizeAngle(angle - focusRad)) <= half;
}

export interface SpineLayout {
  index: number;
  /// 角度（弧度）
  angle: number;
  left: number;
  top: number;
  /// 书脊绕自身中心的旋转（径向取向 = 角度 + 90°）
  rotationDeg: number;
  /// 深度 0..1（1 = 最靠近观察者）
  depth: number;
  scale: number;
  opacity: number;
  zIndex: number;
  fontSize: number;
  /// 是否落在可见弧内
  visible: boolean;
}

/// 计算所有书脊的布局；不可见的也返回（visible=false），由调用方决定不挂载。
export function layoutSpines(
  total: number,
  baseRad: number,
  focusRad: number,
  center: RingCenter,
): SpineLayout[] {
  const spineLength = RING.spineHeightRatio * center.radius;
  const out: SpineLayout[] = [];
  for (let i = 0; i < total; i += 1) {
    const angle = angleFor(i, total, baseRad);
    const depth = (Math.sin(angle) + 1) / 2;
    out.push({
      index: i,
      angle,
      left: center.cx + center.radius * Math.cos(angle) - RING.spineWidthPx / 2,
      top: center.cy + center.radius * Math.sin(angle) - spineLength / 2,
      rotationDeg: (angle * 180) / Math.PI + 90,
      depth,
      scale: RING.scaleFar + (1 - RING.scaleFar) * depth,
      opacity: RING.opacityFar + (1 - RING.opacityFar) * depth,
      zIndex: Math.round(depth * 1000),
      fontSize: RING.fontSizeFar + (RING.fontSizeNear - RING.fontSizeFar) * depth,
      visible: isVisible(angle, focusRad),
    });
  }
  return out;
}

/// 焦点书：角度最接近「正前方向」（+90°）的那本。
export function focusIndex(layouts: SpineLayout[], focusRad: number): number {
  let best = 0;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const layout of layouts) {
    const diff = Math.abs(normalizeAngle(layout.angle - focusRad));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = layout.index;
    }
  }
  return best;
}

/// 可见书脊上限（13 §5 的可验收门槛）。
export function maxMountedSpines(total: number): number {
  return Math.ceil((RING.visibleArcDeg / 360) * Math.max(total, 1)) + 2;
}

/// 初始 base 角度：让第 0 本正对观察者。
export function initialBaseRad(total: number): number {
  const slots = Math.max(total, RING.minSlots);
  return Math.PI / 2 - (2 * Math.PI) / slots;
}
