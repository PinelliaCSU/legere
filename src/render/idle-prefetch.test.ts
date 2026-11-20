import { describe, expect, it, vi } from "vitest";

import { createIdleTextPrefetcher } from "./idle-prefetch";
import type { RenderScheduler } from "./types";

function fakeScheduler(): RenderScheduler & { prefetched: number[][] } {
  const prefetched: number[][] = [];
  const scheduler = {
    prefetched,
    setDocument: () => undefined,
    setViewport: () => undefined,
    setBudget: () => undefined,
    getPageState: () => undefined,
    retry: () => undefined,
    subscribe: () => () => undefined,
    dispose: () => undefined,
    getTextContent: async () => ({ items: [], text: "", itemStarts: [] }),
    prefetchText: async (pageNos: number[]) => {
      prefetched.push([...pageNos]);
    },
  } as unknown as RenderScheduler & { prefetched: number[][] };
  return scheduler;
}

describe("空闲文本预取（P2-1）", () => {
  it("默认（windowPages=0）不排任何空闲任务", () => {
    const requestIdle = vi.fn(() => 1);
    const scheduler = fakeScheduler();
    const prefetcher = createIdleTextPrefetcher(scheduler, { windowPages: 0, requestIdle });
    prefetcher.schedule(3, 300);
    expect(requestIdle).not.toHaveBeenCalled();
    expect(scheduler.prefetched).toHaveLength(0);
    prefetcher.dispose();
  });

  it("开启后只向前预取当前页之后的窗口，并按每次空闲的预算分批", () => {
    const callbacks: ((d: { timeRemaining: () => number }) => void)[] = [];
    const requestIdle = (cb: (d: { timeRemaining: () => number }) => void): number => {
      callbacks.push(cb);
      return callbacks.length;
    };
    const scheduler = fakeScheduler();
    const prefetcher = createIdleTextPrefetcher(scheduler, { windowPages: 5, pagesPerIdle: 2, requestIdle });
    prefetcher.schedule(10, 300);
    expect(callbacks).toHaveLength(1);
    callbacks[0]?.({ timeRemaining: () => 20 });
    expect(scheduler.prefetched[0]).toEqual([11, 12]);
    // 还有剩余页：应当自己续上一轮
    expect(callbacks).toHaveLength(2);
    callbacks[1]?.({ timeRemaining: () => 20 });
    expect(scheduler.prefetched[1]).toEqual([13, 14]);
    callbacks[2]?.({ timeRemaining: () => 20 });
    expect(scheduler.prefetched[2]).toEqual([15]);
    // 队列空了就不再续
    expect(callbacks).toHaveLength(3);
    prefetcher.dispose();
  });

  it("空闲时间不足时收手，不硬塞满预算", () => {
    const callbacks: ((d: { timeRemaining: () => number }) => void)[] = [];
    const scheduler = fakeScheduler();
    const prefetcher = createIdleTextPrefetcher(scheduler, {
      windowPages: 4,
      pagesPerIdle: 4,
      requestIdle: (cb) => {
        callbacks.push(cb);
        return callbacks.length;
      },
    });
    prefetcher.schedule(1, 100);
    callbacks[0]?.({ timeRemaining: () => 1 });
    expect(scheduler.prefetched[0]).toEqual([2]);
    prefetcher.dispose();
  });

  it("到文档末尾时不越界", () => {
    const callbacks: ((d: { timeRemaining: () => number }) => void)[] = [];
    const scheduler = fakeScheduler();
    const prefetcher = createIdleTextPrefetcher(scheduler, {
      windowPages: 5,
      pagesPerIdle: 5,
      requestIdle: (cb) => {
        callbacks.push(cb);
        return callbacks.length;
      },
    });
    prefetcher.schedule(298, 300);
    callbacks[0]?.({ timeRemaining: () => 50 });
    expect(scheduler.prefetched[0]).toEqual([299, 300]);
    prefetcher.dispose();
  });

  it("cancel 后不再续跑", () => {
    const callbacks: ((d: { timeRemaining: () => number }) => void)[] = [];
    const scheduler = fakeScheduler();
    const prefetcher = createIdleTextPrefetcher(scheduler, {
      windowPages: 4,
      pagesPerIdle: 1,
      requestIdle: (cb) => {
        callbacks.push(cb);
        return callbacks.length;
      },
      cancelIdle: () => undefined,
    });
    prefetcher.schedule(1, 100);
    callbacks[0]?.({ timeRemaining: () => 20 });
    expect(scheduler.prefetched).toHaveLength(1);
    prefetcher.cancel();
    const scheduledBeforeCancel = callbacks.length;
    // 已经被排进队列的那个回调即使被调用，也不得再预取、不得再续排
    callbacks[scheduledBeforeCancel - 1]?.({ timeRemaining: () => 20 });
    expect(scheduler.prefetched).toHaveLength(1);
    expect(callbacks).toHaveLength(scheduledBeforeCancel);
    prefetcher.dispose();
  });
});
