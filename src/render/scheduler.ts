// M06 · 渲染调度器实现（docs/08）。
//
// 关键约束：
// 1. canvas 与文本缓存的所有权在本类，React 只订阅状态并挂载位图（D08）。
// 2. 只渲染可见页 + 预取页；窗口外的进行中任务必须取消（缩放/快滚）。
// 3. 换文档 / dispose 必须释放全部资源（契约 R4：setDocument 语义即释放旧文档）。
<<<<<<< HEAD
// 4. 准入与去重按「占位 + 调度代号」实现（v0.13 修复）：并发上限必须覆盖 getPage/取文本
=======
// 4. 准入与去重按「占位 + 调度代号」实现（v0.2 修复）：并发上限必须覆盖 getPage/取文本
>>>>>>> fd010f8aa2c88c31f8dd15affbb12730a8b0aa12
//    阶段；同一页在任一时刻最多只有一个调度在跑，否则两个 RenderTask 会互相覆盖句柄，
//    先启动的那个再也无法取消。
// 5. 文本提取只有一条路径（getTextContent）：渲染、文本层挂载、文内搜索共用同一份
//    字节预算 LRU，谁先到谁填充，其余命中缓存。

import type { DocumentHandle, PageGeometry, PageHandle, RenderTaskHandle, TextContentHandle } from "../pdf-engine/types";
import { BoundedLru } from "./lru";
import {
  canvasBytes,
  computePageBoxes,
  computeVisibleRange,
  currentPageAt,
  expandForPrefetch,
  pageScore,
  shouldSkipPrefetch,
  type PageBox,
  type PriorityContext,
} from "./layout";
import { DEFAULT_BUDGET, type PageRenderState, type RenderBudget, type RenderScheduler, type ViewportState } from "./types";

const DPR = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
/// 文本预取的默认并发：提取在 pdf.js worker 里跑，2 路足够且不至于压住位图渲染。
const TEXT_PREFETCH_CONCURRENCY = 2;

function engineClosed(): Error {
  return Object.assign(new Error("文档未打开或已关闭"), { code: "E_CANCELED" });
}

export class RenderSchedulerImpl implements RenderScheduler {
  private doc: DocumentHandle | null = null;
  private viewport: ViewportState | null = null;
  private budget: RenderBudget = DEFAULT_BUDGET;
  private disposed = false;

  private readonly states = new Map<number, PageRenderState>();
  private readonly listeners = new Set<(states: ReadonlyMap<number, PageRenderState>) => void>();
  /// 占位表：从「开始准备（getPage + 取文本）」到「渲染结束或放弃」都算占用并发额度。
  /// 值是该页当前的 RenderTask（还没进到 render 阶段时为 null），取消时据此调 cancel()。
  private readonly inFlight = new Map<number, RenderTaskHandle | null>();
  /// 每页调度代号：取消或重新调度都自增；落在 await 后面的任务发现代号变了就自行放弃。
  private readonly scheduleVersion = new Map<number, number>();
  /// 文本在途表：并发索要同一页文本时共享同一个解析 Promise，不重复提取。
  private readonly textPending = new Map<number, Promise<TextContentHandle>>();
  /// 位图盒子缓存：只有「页几何数组身份或缩放」变化才重算。滚动路径上是 O(1)。
  private boxesCache: { geoms: PageGeometry[]; scale: number; boxes: PageBox[] } | null = null;
  /// 本轮状态是否真的变了：pump() 每帧都会跑，没变就不必让 React 重建整张 Map。
  private dirty = false;
  private lastScrollTop = 0;
  private scrollSign: -1 | 0 | 1 = 0;
  /// 文档代号：切文档时自增。在途的文本提取只有在代号未变时才允许写缓存，
  /// 否则「切书瞬间」旧书的文本会写进新书的 textCache（同一 pageNo 串页）。
  private docGeneration = 0;

  /// 位图缓存必须**连同渲染时的 scale 一起存**：旧实现只按 pageNo 取，
  /// 命中后把当前 scale 盖到状态上，pump() 的「scale 一致就跳过」判断就永远为真，
  /// 页面槽变宽而位图不重渲染 —— 表现出来就是「放大只是页面变宽，字没变大」。
  private canvasCache = new BoundedLru<{ canvas: HTMLCanvasElement; scale: number }>(DEFAULT_BUDGET.cacheBytes);
  private textCache = new BoundedLru<TextContentHandle>(64 * 1024 * 1024);
  private boxes: PageBox[] = [];
  /// 用户点了「重试」的页：只有这些页允许在 error 状态下再次入队，
  /// 否则任何滚动/缩放都会把失败页重新排队（重试风暴）。
  private readonly retryable = new Set<number>();

  setDocument(handle: DocumentHandle | null): void {
    // 契约 R4：换文档即以新文档替换旧文档，先释放旧资源。
    this.cancelAll();
    this.canvasCache.clear();
    this.textCache.clear();
    this.textPending.clear();
    this.states.clear();
    this.retryable.clear();
    this.scheduleVersion.clear();
    this.boxesCache = null;
    this.docGeneration += 1;
    this.doc = handle;
    this.boxes = handle === null ? [] : this.ensureBoxes(this.viewport);
    this.dirty = true;
    this.emit();
  }

  setViewport(v: ViewportState): void {
    if (this.disposed) return;
    const previous = this.viewport;
    if (previous !== null && previous.scale !== v.scale) {
      // 缩放/换文档时「滚动方向」没有意义，归零免得把旧方向当成用户意图。
      this.scrollSign = 0;
    } else if (previous !== null && v.scrollTop !== this.lastScrollTop) {
      this.scrollSign = v.scrollTop > this.lastScrollTop ? 1 : -1;
    }
    this.lastScrollTop = v.scrollTop;
    this.viewport = v;
    this.boxes = this.ensureBoxes(v);
    this.pump();
  }

  setBudget(b: Partial<RenderBudget>): void {
    this.budget = { ...this.budget, ...b };
    if (b.cacheBytes !== undefined) {
      this.canvasCache = new BoundedLru<{ canvas: HTMLCanvasElement; scale: number }>(b.cacheBytes);
    }
    this.pump();
  }

  getPageState(pageNo: number): PageRenderState | undefined {
    return this.states.get(pageNo);
  }

  /// 单页失败后的显式重试入口（阅读器占位区里的「重试」按钮）。
  retry(pageNo: number): void {
    if (this.disposed) return;
    this.retryable.add(pageNo);
    this.states.delete(pageNo);
    this.dirty = true;
    this.pump();
  }

  subscribe(cb: (states: ReadonlyMap<number, PageRenderState>) => void): () => void {
    this.listeners.add(cb);
    cb(this.states);
    return () => this.listeners.delete(cb);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAll();
    this.canvasCache.clear();
    this.textCache.clear();
    this.textPending.clear();
    this.states.clear();
    this.listeners.clear();
    this.boxesCache = null;
    this.doc = null;
  }

  /// 取消某页进行中的渲染（例如该页已滚出窗口）。
  cancelPage(pageNo: number): void {
    // 先让在途的调度失效，再取消它的任务：否则任务失败后回到 catch 会把状态又改一次。
    this.scheduleVersion.set(pageNo, (this.scheduleVersion.get(pageNo) ?? 0) + 1);
    const task = this.inFlight.get(pageNo);
    if (task !== undefined && task !== null) task.cancel();
    this.inFlight.delete(pageNo);
    const state = this.states.get(pageNo);
    if (state !== undefined && (state.state === "queued" || state.state === "rendering")) {
      this.patch(pageNo, { state: "idle" });
    }
  }

  private cancelAll(): void {
    for (const pageNo of [...this.inFlight.keys()]) this.cancelPage(pageNo);
    this.inFlight.clear();
  }

  /// 取某页文本：缓存优先，在途优先，都没有才真的解析。渲染、文本层、搜索共用这一条路径。
  getTextContent(pageNo: number): Promise<TextContentHandle> {
    const cached = this.textCache.get(pageNo);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = this.textPending.get(pageNo);
    if (pending !== undefined) return pending;
    const doc = this.doc;
    if (doc === null || this.disposed) return Promise.reject(engineClosed());

    const generation = this.docGeneration;
    let task: Promise<TextContentHandle>;
    task = (async () => {
      const page = await doc.getPage(pageNo);
      const text = await page.getTextContent();
      // 切文档期间解析出来的旧书文本只返回给当时的调用方，不污染新书的缓存。
      if (this.docGeneration === generation) this.textCache.set(pageNo, text, text.text.length * 2);
      return text;
    })();
    this.textPending.set(pageNo, task);
    const settle = (): void => {
      if (this.textPending.get(pageNo) === task) this.textPending.delete(pageNo);
    };
    void task.then(settle, settle);
    return task;
  }

  /// 批量预热文本（空闲预取、搜索扫描用）。并发受限，失败静默：
  /// 真正的错误留给该页渲染或搜索自己去报，预取不该打断阅读。
  async prefetchText(
    pageNos: number[],
    opts?: { concurrency?: number; shouldContinue?: () => boolean },
  ): Promise<void> {
    const queue = [...pageNos];
    const concurrency = Math.max(1, Math.min(opts?.concurrency ?? TEXT_PREFETCH_CONCURRENCY, 4));
    const shouldContinue = opts?.shouldContinue;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (shouldContinue !== undefined && !shouldContinue()) return;
        const pageNo = queue.shift();
        if (pageNo === undefined) return;
        try {
          await this.getTextContent(pageNo);
        } catch {
          // 预取失败不影响阅读。
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  private ensureBoxes(v: ViewportState | null): PageBox[] {
    if (v === null) return [];
    const cache = this.boxesCache;
    if (cache !== null && cache.geoms === v.pageGeometries && cache.scale === v.scale) return cache.boxes;
    const boxes = computePageBoxes(v.pageGeometries, v.scale);
    this.boxesCache = { geoms: v.pageGeometries, scale: v.scale, boxes };
    return boxes;
  }

  private ensureState(pageNo: number): PageRenderState {
    const existing = this.states.get(pageNo);
    if (existing !== undefined) return existing;
    const created: PageRenderState = {
      pageNo,
      state: "idle",
      canvas: null,
      textContent: null,
      scale: null,
      error: null,
    };
    this.states.set(pageNo, created);
    this.dirty = true;
    return created;
  }

  private patch(pageNo: number, patch: Partial<PageRenderState>): void {
    const current = this.ensureState(pageNo);
    this.states.set(pageNo, { ...current, ...patch });
    this.dirty = true;
  }

  private emit(): void {
    if (!this.dirty) return;
    this.dirty = false;
    for (const listener of this.listeners) listener(this.states);
  }

  /// 调度一次：算可见区间 -> 取消窗口外任务 -> 按优先级补渲染。
  private pump(): void {
    const doc = this.doc;
    const viewport = this.viewport;
    if (this.disposed || doc === null || viewport === null) return;

    const range = computeVisibleRange(this.boxes, viewport.scrollTop, viewport.viewportHeight);
    // 跳页保护：一轮跨度过大时本轮只排队可见页（docs/08 §2）。
    const prefetch = shouldSkipPrefetch(range)
      ? range
      : expandForPrefetch(range, doc.pageCount, this.budget.prefetchPages);
    const visible = new Set<number>();
    for (let p = range.first; p <= range.last; p += 1) visible.add(p);

    // 1) 取消可见窗口外的进行中任务
    for (const pageNo of [...this.inFlight.keys()]) {
      if (pageNo < prefetch.first || pageNo > prefetch.last) this.cancelPage(pageNo);
    }

    // 2) 打分并排序候选页（可见页永远排在预取页之前，见 layout.PREFETCH_TIER）
    const ctx: PriorityContext = {
      range,
      scrollTop: viewport.scrollTop,
      viewportHeight: viewport.viewportHeight,
      currentPage: currentPageAt(this.boxes, viewport.scrollTop, viewport.viewportHeight),
      scrollSign: this.scrollSign,
      scale: viewport.scale,
      cachedScaleOf: (pageNo) => this.canvasCache.peek(pageNo)?.scale ?? null,
    };
    const candidates: { pageNo: number; priority: number }[] = [];
    for (let p = prefetch.first; p <= prefetch.last; p += 1) {
      const state = this.states.get(p);
      if (state?.state === "ready" && state.scale === viewport.scale) continue;
      if (state?.state === "error" && !this.retryable.has(p)) continue;
      if (this.inFlight.has(p)) continue;
      const box = this.boxes[p - 1];
      if (box === undefined) continue;
      candidates.push({ pageNo: p, priority: pageScore(box, ctx) });
    }
    candidates.sort((a, b) => a.priority - b.priority);

    // 3) 在并发上限内启动渲染（占位在 startRender 第一行完成，故上限覆盖 getPage 阶段）
    for (const candidate of candidates) {
      if (this.inFlight.size >= this.budget.maxConcurrent) break;
      void this.startRender(candidate.pageNo, viewport.scale, visible.has(candidate.pageNo));
    }

    this.evictAndEmit();
  }

  private async startRender(pageNo: number, scale: number, isVisible: boolean): Promise<void> {
    const doc = this.doc;
    if (doc === null) return;

    const version = (this.scheduleVersion.get(pageNo) ?? 0) + 1;
    this.scheduleVersion.set(pageNo, version);
    this.inFlight.set(pageNo, null);
    this.patch(pageNo, { state: "queued" });
    this.emit();

    try {
      const page: PageHandle = await doc.getPage(pageNo);
      if (!this.isCurrent(pageNo, version)) return;

      // 文本内容优先（文本层可先于位图出现，选择与搜索不受渲染影响）。
      const text = await this.getTextContent(pageNo);
      if (!this.isCurrent(pageNo, version)) return;
      this.patch(pageNo, { textContent: text });

      const cached = this.canvasCache.get(pageNo);
      if (cached !== undefined && cached.scale === scale) {
        this.releaseSlot(pageNo, version);
        this.patch(pageNo, { state: "ready", canvas: cached.canvas, scale });
        this.emit();
        return;
      }

      const task = page.render({ scale });
      this.inFlight.set(pageNo, task);
      this.patch(pageNo, { state: "rendering" });
      this.emit();

      const canvas = await task.promise;
      this.releaseSlot(pageNo, version);

      const bytes = canvasBytes(page.geometry.widthPt, page.geometry.heightPt, scale, DPR);
      this.canvasCache.set(pageNo, { canvas, scale }, bytes);
      this.retryable.delete(pageNo);
      this.patch(pageNo, { state: "ready", canvas, scale, error: null });
      this.emit();

      // 渲染完成后若视口已变化，继续按新视口调度。
      this.pump();
    } catch (err) {
      const stillCurrent = this.isCurrent(pageNo, version);
      this.releaseSlot(pageNo, version);
      // 已被取消或已被新的调度接管：状态由新的那一次负责，这里不能再写。
      if (!stillCurrent) return;
      const code = (err as { code?: string }).code ?? "E_INTERNAL";
      if (code === "E_CANCELED") {
        // 取消不是失败：回到 idle，等待重新调度。
        this.patch(pageNo, { state: "idle" });
      } else {
        this.patch(pageNo, {
          state: "error",
          error: { code, message: (err as Error).message },
        });
      }
      this.emit();
      if (isVisible) console.warn(`页面 ${pageNo} 渲染失败`, err);
    }
  }

  private isCurrent(pageNo: number, version: number): boolean {
    return this.scheduleVersion.get(pageNo) === version;
  }

  /// 归还占位：只有当前这次调度才有权清理，免得把后来者的占位删掉。
  private releaseSlot(pageNo: number, version: number): void {
    if (!this.isCurrent(pageNo, version)) return;
    this.inFlight.delete(pageNo);
  }

  private evictAndEmit(): void {
    const protect = new Set<number>();
    const viewport = this.viewport;
    if (viewport !== null) {
      const range = computeVisibleRange(this.boxes, viewport.scrollTop, viewport.viewportHeight);
      for (let p = range.first; p <= range.last; p += 1) protect.add(p);
    }
    for (const pageNo of this.inFlight.keys()) protect.add(pageNo);
    for (const evictedKey of this.canvasCache.evict(protect)) {
      this.patch(evictedKey, { canvas: null, state: "idle" });
    }
    this.emit();
  }
}

export function createRenderScheduler(): RenderScheduler {
  return new RenderSchedulerImpl();
}
