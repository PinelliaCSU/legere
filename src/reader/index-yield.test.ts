import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createIndexYield } from "./index-yield";

describe("阅读让位（P2-2）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("连续交互超过 150ms 才暂停，空闲 1.5s 后恢复", async () => {
    const calls: boolean[] = [];
    const yieldTo = createIndexYield({
      setPaused: async (paused) => {
        calls.push(paused);
      },
    });
    yieldTo.notifyInteraction();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([]); // 还没到 150ms：不打断索引
    await vi.advanceTimersByTimeAsync(60);
    expect(calls).toEqual([true]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toEqual([true, false]);
    yieldTo.dispose();
  });

  it("持续交互不会反复暂停/恢复（只在 150ms 后停一次）", async () => {
    const calls: boolean[] = [];
    const yieldTo = createIndexYield({
      setPaused: async (paused) => {
        calls.push(paused);
      },
    });
    for (let i = 0; i < 10; i += 1) {
      yieldTo.notifyInteraction();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(calls).toEqual([true]);
    yieldTo.dispose();
  });

  it("dispose 时若仍处于暂停，必须恢复索引", async () => {
    const calls: boolean[] = [];
    const yieldTo = createIndexYield({
      setPaused: async (paused) => {
        calls.push(paused);
      },
    });
    yieldTo.notifyInteraction();
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toEqual([true]);
    yieldTo.dispose();
    expect(calls).toEqual([true, false]);
  });

  it("命令失败时回滚标记，不影响后续交互", async () => {
    let fail = true;
    const calls: boolean[] = [];
    const yieldTo = createIndexYield({
      setPaused: async (paused) => {
        calls.push(paused);
        if (fail) throw new Error("db down");
      },
    });
    yieldTo.notifyInteraction();
    await vi.advanceTimersByTimeAsync(200);
    fail = false;
    yieldTo.notifyInteraction();
    await vi.advanceTimersByTimeAsync(200);
    expect(calls.filter((c) => c === true)).toHaveLength(2);
    yieldTo.dispose();
  });
});
