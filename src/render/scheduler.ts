// M06 · 渲染调度器实现（docs/08）。
//
// 关键约束：
// 1. canvas 与文本缓存的所有权在本类，React 只订阅状态并挂载位图（D08）。
// 2. 只渲染可见页 + 预取页；窗口外的进行中任务必须取消（缩放/快滚）。
// 3. 换文档 / dispose 必须释放全部资源（契约 R4：setDocument 语义即释放旧文档）。

import type { DocumentHandle, PageHandle, RenderTaskHandle, TextContentHandle } from "../pdf-engine/types";
import { BoundedLru } from "./lru";
import {
  canvasBytes,
  computePageBoxes,
  computeVisibleRange,
  expandForPrefetch,
  pagePriority,
  type PageBox,
} from "./layout";
import { DEFAULT_BUDGET, type PageRenderState, type RenderBudget, type RenderScheduler, type ViewportState } from "./types";

const DPR = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

export class RenderSchedulerImpl implements RenderScheduler {
  private doc: DocumentHandle | null = null;
  private viewport: ViewportState | null = null;
  private budget: RenderBudget = DEFAULT_BUDGET;
  private disposed = false;

  private readonly states = new Map<number, PageRenderState>();
  private readonly listeners = new Set<(states: ReadonlyMap<number, PageRenderState>) => void>();
  private readonly running = new Map<number, RenderTaskHandle>();
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
    this.states.clear();
    this.retryable.clear();
    this.doc = handle;
    if (handle !== null) {
      this.boxes = computePageBoxes(this.viewport?.pageGeometries ?? [], this.viewport?.scale ?? 1);
    } else {
      this.boxes = [];
    }
    this.emit();
  }

  setViewport(v: ViewportState): void {
    if (this.disposed) return;
    this.viewport = v;
    this.boxes = computePageBoxes(v.pageGeometries, v.scale);
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
    this.states.clear();
    this.listeners.clear();
    this.doc = null;
  }

  /// 取消某页进行中的渲染（例如该页已滚出窗口）。
  cancelPage(pageNo: number): void {
    const task = this.running.get(pageNo);
    if (task !== undefined) {
      task.cancel();
      this.running.delete(pageNo);
    }
  }

  private cancelAll(): void {
    for (const task of this.running.values()) task.cancel();
    this.running.clear();
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
    return created;
  }

  private patch(pageNo: number, patch: Partial<PageRenderState>): void {
    const current = this.ensureState(pageNo);
    this.states.set(pageNo, { ...current, ...patch });
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.states);
  }

  /// 调度一次：算可见区间 -> 取消窗口外任务 -> 按优先级补渲染。
  private pump(): void {
    const doc = this.doc;
    const viewport = this.viewport;
    if (this.disposed || doc === null || viewport === null) return;

    const range = computeVisibleRange(this.boxes, viewport.scrollTop, viewport.viewportHeight);
    const prefetch = expandForPrefetch(range, doc.pageCount, this.budget.prefetchPages);
    const visible = new Set<number>();
    for (let p = range.first; p <= range.last; p += 1) visible.add(p);

    // 1) 取消可见窗口外的进行中任务
    for (const pageNo of [...this.running.keys()]) {
      if (pageNo < prefetch.first || pageNo > prefetch.last) this.cancelPage(pageNo);
    }

    // 2) 按优先级排序候选页
    const candidates: { pageNo: number; priority: number }[] = [];
    for (let p = prefetch.first; p <= prefetch.last; p += 1) {
      const state = this.states.get(p);
      if (state?.state === "ready" && state.scale === viewport.scale) continue;
      if (state?.state === "error" && !this.retryable.has(p)) continue;
      if (this.running.has(p)) continue;
      candidates.push({ pageNo: p, priority: pagePriority(p, range, range.first) });
    }
    candidates.sort((a, b) => a.priority - b.priority);

    // 3) 在并发上限内启动渲染
    for (const candidate of candidates) {
      if (this.running.size >= this.budget.maxConcurrent) break;
      void this.startRender(candidate.pageNo, viewport.scale, visible.has(candidate.pageNo));
    }

    this.evictAndEmit();
  }

  private async startRender(pageNo: number, scale: number, isVisible: boolean): Promise<void> {
    const doc = this.doc;
    if (doc === null) return;

    this.patch(pageNo, { state: "queued" });
    this.emit();

    try {
      const page: PageHandle = await doc.getPage(pageNo);

      // 文本内容优先（文本层可先于位图出现，选择与搜索不受渲染影响）。
      const text = this.textCache.get(pageNo) ?? (await page.getTextContent());
      this.textCache.set(pageNo, text, text.text.length * 2);
      this.patch(pageNo, { textContent: text });

      const cached = this.canvasCache.get(pageNo);
      if (cached !== undefined && cached.scale === scale) {
        this.patch(pageNo, { state: "ready", canvas: cached.canvas, scale });
        this.emit();
        return;
      }

      const task = page.render({ scale });
      this.running.set(pageNo, task);
      this.patch(pageNo, { state: "rendering" });
      this.emit();

      const canvas = await task.promise;
      this.running.delete(pageNo);

      const bytes = canvasBytes(page.geometry.widthPt, page.geometry.heightPt, scale, DPR);
      this.canvasCache.set(pageNo, { canvas, scale }, bytes);
      this.retryable.delete(pageNo);
      this.patch(pageNo, { state: "ready", canvas, scale, error: null });
      this.emit();

      // 渲染完成后若视口已变化，继续按新视口调度。
      this.pump();
    } catch (err) {
      this.running.delete(pageNo);
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

  private evictAndEmit(): void {
    const protect = new Set<number>();
    const viewport = this.viewport;
    if (viewport !== null) {
      const range = computeVisibleRange(this.boxes, viewport.scrollTop, viewport.viewportHeight);
      for (let p = range.first; p <= range.last; p += 1) protect.add(p);
    }
    for (const pageNo of this.running.keys()) protect.add(pageNo);
    for (const evictedKey of this.canvasCache.evict(protect)) {
      this.patch(evictedKey, { canvas: null, state: "idle" });
    }
    this.emit();
  }
}

export function createRenderScheduler(): RenderScheduler {
  return new RenderSchedulerImpl();
}
