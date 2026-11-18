// 主页空间转盘几何（docs/13-ui-home-concept.md，D01–D04 已冻结）。
// 纯函数：不碰 DOM，便于按 13 §8 的验收条件做单测。
//
// 2026-11 修订：新增 layoutRing —— 只返回「要挂载的书脊」（隐藏弧内的书不生成 DOM，
// 13 §2 绝对约束 1）。旧 layoutSpines 保留为全环等分的几何原语（既有测试与积分用途），
// 两者共用 spineGeometry 的同一套计算，避免环线与书脊位置分叉。

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

/// 环上同时参与布局的槽位上限：书再多，相邻书脊的角距也固定，不会挤成一团。
export const RING_SLOTS = 16;

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

const SPINE_LENGTH_RATIO = RING.spineHeightRatio;

/// 单个书脊的几何：位置、径向旋转、纵深映射。环线与书脊共用这里，避免两套算法分叉。
function spineGeometry(index: number, angle: number, center: RingCenter, focusRad: number): SpineLayout {
  const spineLength = SPINE_LENGTH_RATIO * center.radius;
  const depth = (Math.sin(angle) + 1) / 2;
  return {
    index,
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
  };
}

/// 计算所有书脊的布局；不可见的也返回（visible=false），由调用方决定不挂载。
export function layoutSpines(
  total: number,
  baseRad: number,
  focusRad: number,
  center: RingCenter,
): SpineLayout[] {
  const out: SpineLayout[] = [];
  for (let i = 0; i < total; i += 1) {
    out.push(spineGeometry(i, angleFor(i, total, baseRad), center, focusRad));
  }
  return out;
}

/// 相邻书脊的角距：按「窗口内槽位数」而非书目总数算，所以 98 本和 16 本角距一致。
export function ringDelta(total: number): number {
  const slots = Math.min(Math.max(total, 0), RING_SLOTS);
  return (2 * Math.PI) / Math.max(slots, RING.minSlots);
}

/// 要挂载的槽位偏移（相对焦点书，单位：格）。对称、必然包含 0（N=2 例外见下）。
///
/// N=1 -> [0]（单本居中直立，13 §4.3）
/// N=2 -> [-0.5, +0.5]（两本对称分列，13 §4.3）
/// N>=3 -> [-k..k]，k 同时受槽位上限与可见弧限制
export function mountedSlots(total: number): number[] {
  if (total <= 0) return [];
  const slots = Math.min(total, RING_SLOTS);
  if (slots === 1) return [0];
  if (slots === 2) return [-0.5, 0.5];
  const halfArc = (RING.visibleArcDeg * Math.PI) / 360;
  const perSide = Math.min(Math.floor((slots - 1) / 2), Math.floor(halfArc / ringDelta(total)));
  const out: number[] = [];
  for (let s = -perSide; s <= perSide; s += 1) out.push(s);
  return out;
}

const FLIP_EPS = 1e-9;

/// 竖排书名是否需要再翻转 180°（下半环与右端需要，上半环与左端不需要）。
export function spineFlipsText(angle: number): boolean {
  const sin = Math.sin(angle);
  if (sin > FLIP_EPS) return true;
  if (sin < -FLIP_EPS) return false;
  return Math.cos(angle) > 0;
}

export interface RingSpine extends SpineLayout {
  /// 书目偏移（整数，相对焦点书；负数表示窗口前一本）
  bookOffset: number;
  /// 几何槽位偏移（可能是半格，仅 N=2）
  slotOffset: number;
  /// 竖排书名是否需要再翻转 180°：下半环 rot 已接近 180°，不翻会倒着显示
  flipText: boolean;
}

/// 当前窗口里真正需要挂载的书脊。
///
/// 硬约束：书脊中心落在环上（与环线同一套 center/radius），只输出可见弧内的槽位，
/// 焦点书恒在 +90°（屏幕正下方）。N=1 单独处理成环心直立单本。
export function layoutRing(total: number, center: RingCenter, focusRad: number = Math.PI / 2): RingSpine[] {
  if (total <= 0) return [];
  const spineLength = SPINE_LENGTH_RATIO * center.radius;

  if (total === 1) {
    // 13 §4.3：单本居中、「不旋转」——直接立在环心，竖向阅读。
    return [
      {
        index: 0,
        angle: focusRad,
        left: center.cx - RING.spineWidthPx / 2,
        top: center.cy - spineLength / 2,
        rotationDeg: 0,
        depth: 1,
        scale: 1,
        opacity: 1,
        zIndex: 1000,
        fontSize: RING.fontSizeNear,
        visible: true,
        bookOffset: 0,
        slotOffset: 0,
        flipText: false,
      },
    ];
  }

  const delta = ringDelta(total);
  return mountedSlots(total).map((slotOffset) => {
    const angle = focusRad + slotOffset * delta;
    // N=2 的两个槽位是半格：焦点书占右半边、下一本占左半边（旋转一格两者换边）。
    const bookOffset = total === 2 ? (slotOffset < 0 ? 0 : 1) : Math.round(slotOffset);
    return {
      ...spineGeometry(bookOffset, angle, center, focusRad),
      bookOffset,
      slotOffset,
      // 竖排书名要「从上往下读」。未翻转时字序方向 d = -u（u 为径向外向），翻转后 d = u：
      //   sin(θ)>0 -> 未翻转时 d 朝上（下半环会倒着读），翻转；
      //   sin(θ)<0 -> 未翻转时 d 朝下，保持；
      //   sin(θ)=0（两根水平书脊）-> 取 d 朝右的那一种：θ=0 要翻转，θ=180 不翻转。
      // 注意 sin(π) 在 JS 里是 1.2e-16 而不是 0，必须用容差判断，否则左端会被误翻转成镜像。
      flipText: spineFlipsText(angle),
    };
  });
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
