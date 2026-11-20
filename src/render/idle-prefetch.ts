// 空闲文本预取（P2-1，docs/08 §6 / docs/20 §2）。**默认关闭**，独立预算，只预取文本。
//
// 为什么先做文本、不做位图：
//   · 一页文本 ≈ 183 KB（docs/08 §6 第 143 行），同样 scale 的位图 ≈ 17.2 MiB（§5 第 115 行）；
//     位图预取会直接吃掉 cacheBytes 的 14 页里的一部分，把「可见页被逐出」的风险推高。
//   · 文本与缩放无关，命中后搜索/高亮都受益；位图与缩放强耦合，缩放一次就全废。
// 为什么默认关闭：requestIdleCallback 只保证「浏览器自认为空闲」，而 page.render 是不可
// 分片的原子任务（单页 12–40ms，docs/08 §4）。收益取决于滚动节奏，属必须实测项
// （docs/20 §3 的打点数据尚未收集），所以这里只提供能力，由设置项打开。

import type { RenderScheduler } from "./types";

type IdleCallback = (deadline: { timeRemaining: () => number }) => void;

export interface IdleTextPrefetchOptions {
  /// 向前预取多少页；0 = 关闭（默认）。
  windowPages: number;
  /// 每次空闲回调最多处理几页（独立预算，与 RenderBudget.cacheBytes 无关）。
  pagesPerIdle?: number;
  /// 空闲回调兜底超时（ms）：浏览器迟迟不空闲时也给它一次机会。
  timeoutMs?: number;
  /// 注入空闲调度实现（单测与降级用）。
  requestIdle?: (cb: IdleCallback, opts?: { timeout?: number }) => number;
  cancelIdle?: (handle: number) => void;
}

export interface IdleTextPrefetcher {
  /// 告诉预取器「现在停在第 currentPage 页」，它会在空闲时向前补文本。
  schedule(currentPage: number, pageCount: number): void;
  /// 取消排队中的空闲任务（用户又开始滚动、切文档时调用）。
  cancel(): void;
  dispose(): void;
}

const DEFAULT_PAGES_PER_IDLE = 2;
const DEFAULT_TIMEOUT_MS = 2000;
/// 空闲时间不足这个值就不再贪心（单位 ms）。
const MIN_IDLE_MS = 4;

function defaultRequestIdle(): (cb: IdleCallback, opts?: { timeout?: number }) => number {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    const ric = window.requestIdleCallback.bind(window);
    return (cb, opts) => ric(cb as IdleRequestCallback, opts);
  }
  // 降级：没有 requestIdleCallback 时退化成一次短定时器，语义等价但机会少。
  return (cb) => setTimeout(() => cb({ timeRemaining: () => MIN_IDLE_MS * 2 }), 120) as unknown as number;
}

function defaultCancelIdle(): (handle: number) => void {
  if (typeof window !== "undefined" && typeof window.cancelIdleCallback === "function") {
    return (handle) => window.cancelIdleCallback(handle);
  }
  return (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

export function createIdleTextPrefetcher(
  scheduler: RenderScheduler,
  opts: IdleTextPrefetchOptions,
): IdleTextPrefetcher {
  const windowPages = Math.max(0, Math.floor(opts.windowPages));
  const pagesPerIdle = Math.max(1, Math.floor(opts.pagesPerIdle ?? DEFAULT_PAGES_PER_IDLE));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestIdle = opts.requestIdle ?? defaultRequestIdle();
  const cancelIdle = opts.cancelIdle ?? defaultCancelIdle();

  let handle: number | null = null;
  let disposed = false;
  let queue: number[] = [];
  let cursor = 0;

  const stop = (): void => {
    if (handle !== null) {
      cancelIdle(handle);
      handle = null;
    }
  };

  const onIdle = (deadline: { timeRemaining: () => number }): void => {
    handle = null;
    if (disposed) return;
    const remaining = typeof deadline.timeRemaining === "function" ? deadline.timeRemaining() : 0;
    const batch: number[] = [];
    while (cursor < queue.length && batch.length < pagesPerIdle) {
      // 空闲时间已经不够一页就收手，把机会留给下一轮。
      if (batch.length > 0 && remaining > 0 && remaining < MIN_IDLE_MS) break;
      const pageNo = queue[cursor];
      cursor += 1;
      if (pageNo !== undefined) batch.push(pageNo);
    }
    if (batch.length > 0) void scheduler.prefetchText(batch, { concurrency: 1 });
    if (cursor < queue.length) handle = requestIdle(onIdle, { timeout: timeoutMs });
  };

  return {
    schedule(currentPage: number, pageCount: number): void {
      if (disposed || windowPages === 0) return;
      const next: number[] = [];
      const last = Math.min(pageCount, currentPage + windowPages);
      for (let p = currentPage + 1; p <= last; p += 1) next.push(p);
      queue = next;
      cursor = 0;
      if (handle !== null) return; // 已有一轮在排队，它跑完会自己续上
      if (queue.length > 0) handle = requestIdle(onIdle, { timeout: timeoutMs });
    },
    cancel(): void {
      stop();
      queue = [];
      cursor = 0;
    },
    dispose(): void {
      disposed = true;
      stop();
      queue = [];
      cursor = 0;
    },
  };
}
