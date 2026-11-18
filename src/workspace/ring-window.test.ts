import { describe, expect, it } from "vitest";

import {
  RING,
  RING_SLOTS,
  layoutRing,
  maxMountedSpines,
  mountedSlots,
  ringCenter,
  ringDelta,
} from "./ring";

const FOCUS = Math.PI / 2;

describe("转盘窗口（13 §2 绝对约束 / §5 性能上限）", () => {
  it("N=0 的环是空的：没有任何槽位", () => {
    expect(mountedSlots(0)).toEqual([]);
    expect(layoutRing(0, ringCenter(1280, 800), FOCUS)).toEqual([]);
  });

  it("N=1 只有一本，居中直立不旋转（13 §4.3）", () => {
    const center = ringCenter(1280, 800);
    const spines = layoutRing(1, center, FOCUS);
    expect(spines).toHaveLength(1);
    const spine = spines[0]!;
    expect(spine.rotationDeg).toBe(0);
    expect(spine.left).toBeCloseTo(center.cx - RING.spineWidthPx / 2, 6);
    expect(spine.top).toBeCloseTo(center.cy - (RING.spineHeightRatio * center.radius) / 2, 6);
    expect(spine.opacity).toBe(1);
  });

  it("N=2 两本对称分列在正前两侧（13 §4.3）", () => {
    const center = ringCenter(1280, 800);
    const spines = layoutRing(2, center, FOCUS);
    expect(spines).toHaveLength(2);
    const [left, right] = [...spines].sort((a, b) => a.slotOffset - b.slotOffset);
    expect(left!.slotOffset).toBeCloseTo(-0.5, 6);
    expect(right!.slotOffset).toBeCloseTo(0.5, 6);
    // 两本到正前方的角距离相等
    expect(Math.abs(left!.angle - FOCUS)).toBeCloseTo(Math.abs(right!.angle - FOCUS), 9);
    // 两者都挂载且都是不同的书（bookOffset 0 与 1）
    expect([left!.bookOffset, right!.bookOffset].sort()).toEqual([0, 1]);
  });

  it("N=16/60/98 的槽位角距一致，不会因为书多而挤在一起", () => {
    const delta16 = ringDelta(16);
    for (const total of [16, 60, 98]) {
      expect(ringDelta(total)).toBeCloseTo(delta16, 12);
      const slots = mountedSlots(total);
      // 相邻槽位角距 = delta，与总书数无关
      for (let i = 1; i < slots.length; i += 1) {
        expect(slots[i]! - slots[i - 1]!).toBeCloseTo(1, 9);
      }
    }
  });

  it("挂载数量同时满足槽位上限与 13 §5 的 DOM 上限", () => {
    for (const total of [1, 2, 12, 16, 60, 98, 1000]) {
      const slots = mountedSlots(total);
      expect(slots.length).toBeLessThanOrEqual(Math.min(total, RING_SLOTS));
      expect(slots.length).toBeLessThanOrEqual(maxMountedSpines(total));
      // 隐藏弧内的槽位一律不返回（不是 opactiy:0，而是压根不存在）
      for (const slot of slots) {
        expect(Math.abs(slot) * ringDelta(total)).toBeLessThanOrEqual((RING.visibleArcDeg * Math.PI) / 360 + 1e-9);
      }
    }
  });

  it("焦点书恒在正前方向，且书脊中心落在环上", () => {
    const center = ringCenter(1440, 900);
    for (const total of [3, 12, 16, 60, 98]) {
      const spines = layoutRing(total, center, FOCUS);
      const focused = spines.find((s) => s.bookOffset === 0);
      expect(focused).toBeDefined();
      expect(focused!.angle).toBeCloseTo(FOCUS, 9);
      for (const spine of spines) {
        const cx = spine.left + RING.spineWidthPx / 2;
        const cy = spine.top + (RING.spineHeightRatio * center.radius) / 2;
        expect(Math.hypot(cx - center.cx, cy - center.cy)).toBeCloseTo(center.radius, 6);
      }
    }
  });

  it("书脊竖排书名始终保持「从上往下读」的字序（下半环与右侧端都要翻转）", () => {
    const center = ringCenter(1280, 800);
    for (const total of [3, 12, 16, 60, 98]) {
      for (const spine of layoutRing(total, center, FOCUS)) {
        // 字序方向：未翻转是 -u，翻转后是 +u，u 为径向外向。
        const sign = spine.flipText ? 1 : -1;
        const dy = sign * Math.sin(spine.angle);
        const dx = sign * Math.cos(spine.angle);
        // 优先「向下读」；纯水平时优先「从左往右读」。
        // 容差必须用在 dy 上：sin(π) 在 JS 里是 1.2e-16，直接比较会放过被镜像的左端书脊。
        expect(dy > 1e-9 || (Math.abs(dy) <= 1e-9 && dx > 0)).toBe(true);
      }
    }
  });

  it("布局是纯函数：同一输入重复调用结果完全相同（不会累积漂移）", () => {
    const center = ringCenter(1280, 800);
    const a = layoutRing(98, center, FOCUS);
    const b = layoutRing(98, center, FOCUS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("窗口按窗口宽度收缩：小窗口半径变小但仍居中", () => {
    const small = ringCenter(900, 620);
    const large = ringCenter(1920, 1080);
    expect(small.radius).toBeCloseTo(0.34 * 620, 6);
    expect(large.radius).toBeCloseTo(0.34 * 1080, 6);
    expect(small.cx).toBe(450);
    expect(large.cx).toBe(960);
  });
});
