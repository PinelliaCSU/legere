// Bitmap jobs and text extraction have independent lifetimes. Requests for the
// same page text share both the in-flight promise and a bounded document cache.
import type { DocumentHandle, PageGeometry, RenderTaskHandle, TextContentHandle } from "../pdf-engine/types";
import { BoundedLru } from "./lru";
import { computePageBoxes, type PageBox } from "./layout";
import { intersects, planTiles, type TileBitmap, type TileSpec } from "./tiles";
import { DEFAULT_BUDGET, type PageRenderState, type RenderBudget, type RenderScheduler, type ViewportState } from "./types";

const TEXT_PREFETCH_CONCURRENCY = 2;

function engineClosed(): Error {
  return Object.assign(new Error("文档未打开或已关闭"), { code: "E_CANCELED" });
}

export class RenderSchedulerImpl implements RenderScheduler {
  private doc: DocumentHandle | null = null;
  private viewport: ViewportState | null = null;
  private budget = { ...DEFAULT_BUDGET };
  private disposed = false;
  private readonly states = new Map<number, PageRenderState>();
  private readonly listeners = new Set<(states: ReadonlyMap<number, PageRenderState>) => void>();
  private readonly inFlight = new Map<string, { cancel?: () => void }>();
  private readonly bitmaps = new BoundedLru<TileBitmap, string>(DEFAULT_BUDGET.cacheBytes);
  private wanted: TileSpec[] = [];
  private readonly finishedPrefetch = new Set<string>();
  private readonly errors = new Map<number, NonNullable<PageRenderState["error"]>>();
  private readonly textPending = new Map<number, Promise<TextContentHandle>>();
  private readonly textCache = new BoundedLru<TextContentHandle>(64 * 1024 * 1024);
  private boxesCache: { geoms: PageGeometry[]; scale: number; boxes: PageBox[] } | null = null;
  private direction: -1 | 0 | 1 = 0;
  private docGeneration = 0;

  setDocument(doc: DocumentHandle | null): void {
    this.docGeneration++;
    for (const job of this.inFlight.values()) job.cancel?.();
    this.inFlight.clear();
    this.bitmaps.clear();
    this.textCache.clear();
    this.textPending.clear();
    this.states.clear();
    this.errors.clear();
    this.finishedPrefetch.clear();
    this.boxesCache = null;
    this.viewport = null;
    this.wanted = [];
    this.doc = doc;
    for (const cb of this.listeners) cb(this.states);
  }

  setViewport(v: ViewportState): void {
    const last = this.viewport;
    if (!last || last.scale !== v.scale) this.direction = 0;
    else if (v.scrollTop !== last.scrollTop) this.direction = v.scrollTop > last.scrollTop ? 1 : -1;
    this.viewport = v;
    const boxes = this.ensureBoxes(v);
    this.wanted = planTiles(boxes, v, this.budget.prefetchPages, this.direction,
      pageNo => this.states.get(pageNo)?.tiles.at(-1)?.scale ?? null);
    const keys = new Set(this.wanted.map(t => t.key));
    const visible = new Set(this.wanted.filter(t => t.visible).map(t => t.key));
    const needsVisible = this.wanted.some(t => t.visible && !this.bitmaps.peek(t.key) && !this.inFlight.has(t.key) && !this.errors.has(t.pageNo));
    for (const [key, job] of this.inFlight) {
      if (!keys.has(key) || (needsVisible && !visible.has(key))) {
        this.inFlight.delete(key);
        job.cancel?.();
      }
    }
    for (const key of this.finishedPrefetch) if (!keys.has(key)) this.finishedPrefetch.delete(key);
    for (const key of keys) this.bitmaps.get(key);
    this.pump();
  }

  setBudget(b: Partial<RenderBudget>): void {
    this.budget = { ...this.budget, ...b };
    this.bitmaps.budgetBytes = this.budget.cacheBytes;
    if (this.viewport) this.setViewport(this.viewport);
  }

  getPageState(pageNo: number) { return this.states.get(pageNo); }

  retry(pageNo: number): void {
    this.errors.delete(pageNo);
    this.pump();
  }

  subscribe(cb: (states: ReadonlyMap<number, PageRenderState>) => void): () => void {
    this.listeners.add(cb);
    cb(this.states);
    return () => this.listeners.delete(cb);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.setDocument(null);
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
      if (this.docGeneration === generation && !this.disposed) {
        // Account for joined text, item strings, coordinates and the offset array.
        const bytes = 256 + text.text.length * 2 + text.items.reduce((sum, item) => sum + 72 + item.str.length * 2, 0);
        if (bytes <= this.textCache.budgetBytes) {
          this.textCache.set(pageNo, text, bytes);
          this.textCache.evict();
        }
      }
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

  private pump(): void {
    if (!this.doc || this.disposed) return;
    for (const tile of this.wanted) {
      if (this.inFlight.size >= this.budget.maxConcurrent) break;
      if (this.bitmaps.peek(tile.key) || this.inFlight.has(tile.key) || this.errors.has(tile.pageNo)) continue;
      if (!tile.visible && this.finishedPrefetch.has(tile.key)) continue;
      void this.render(this.doc, tile);
    }
    this.publish();
  }

  private async render(doc: DocumentHandle, tile: TileSpec): Promise<void> {
    const job: { cancel?: RenderTaskHandle["cancel"] } = {};
    this.inFlight.set(tile.key, job);
    const current = () => this.inFlight.get(tile.key) === job;
    try {
      const page = await doc.getPage(tile.pageNo);
      if (!current()) return;
      const task = page.render({ scale: tile.scale, pixelRatio: tile.pixelRatio, clipBox: tile.clip });
      job.cancel = () => task.cancel();
      const canvas = await task.promise;
      if (!current()) return;
      const width = tile.clip?.w ?? Math.ceil(page.geometry.widthPt * tile.scale * tile.pixelRatio);
      const height = tile.clip?.h ?? Math.ceil(page.geometry.heightPt * tile.scale * tile.pixelRatio);
      this.bitmaps.set(tile.key, { ...tile, canvas }, width * height * 4);
      this.finishedPrefetch.add(tile.key);
    } catch (err) {
      if (current()) {
        const code = (err as { code?: string }).code ?? "E_INTERNAL";
        this.errors.set(tile.pageNo, { code, message: String(err) });
      }
    } finally {
      if (current()) {
        this.inFlight.delete(tile.key);
        this.pump();
      }
    }
  }

  private publish(): void {
    const plans = new Map<number, TileSpec[]>();
    for (const tile of this.wanted) {
      const group = plans.get(tile.pageNo);
      if (group) group.push(tile);
      else plans.set(tile.pageNo, [tile]);
    }
    const protectedKeys = new Set<string>();
    const next = new Map<number, PageRenderState>();
    for (const [pageNo, group] of plans) {
      const old = this.states.get(pageNo);
      const fresh: TileBitmap[] = [];
      const missing: TileSpec[] = [];
      for (const spec of group) {
        const bitmap = this.bitmaps.peek(spec.key);
        if (bitmap) {
          fresh.push(bitmap);
          if (spec.visible) protectedKeys.add(spec.key);
        } else if (spec.visible) missing.push(spec);
      }
      // A visible region is kept at its previous resolution until its new tiles arrive.
      const fallback = old?.tiles.filter(t =>
        (t.scale !== group[0]!.scale || t.pixelRatio !== group[0]!.pixelRatio) &&
        missing.some(m => intersects(t.bounds, m.bounds))) ?? [];
      for (const t of fallback) protectedKeys.add(t.key);
      const tiles = [...fallback, ...fresh];
      const error = this.errors.get(pageNo) ?? null;
      const state = error ? "error" : missing.length || !tiles.length ? "rendering" : "ready";
      next.set(pageNo, { pageNo, error, state, tiles, scale: group[0]!.scale,
        canvas: tiles.length === 1 && !tiles[0]!.clip ? tiles[0]!.canvas : null });
    }

    const evicted = new Set(this.bitmaps.evict(protectedKeys));
    let changed = false;
    for (const [pageNo, state] of next) {
      if (evicted.size) {
        state.tiles = state.tiles.filter(t => !evicted.has(t.key));
        if (!state.tiles.length) {
          state.canvas = null;
          if (!state.error) state.state = "idle";
        }
      }
      const old = this.states.get(pageNo);
      if (old && state.state === old.state && state.scale === old.scale && state.error === old.error &&
          state.tiles.length === old.tiles.length && state.tiles.every((t, i) => t === old.tiles[i])) continue;
      this.states.set(pageNo, state);
      changed = true;
    }
    for (const pageNo of this.states.keys()) {
      if (!next.has(pageNo)) {
        this.states.delete(pageNo);
        changed = true;
      }
    }
    if (changed) for (const cb of this.listeners) cb(this.states);
  }
}

export function createRenderScheduler(): RenderScheduler {
  return new RenderSchedulerImpl();
}
