// Render Scheduler 类型（docs/05-api-contracts.md §7 的后半部分）。
// 与引擎类型分文件归属（契约 R18）：src/pdf-engine/types.ts 归 M05，本文件归 M06。

import type { DocumentHandle, PageGeometry, TextContentHandle } from "../pdf-engine/types";

export type PageState = "idle" | "queued" | "rendering" | "ready" | "error";

export interface PageRenderState {
  pageNo: number;
  state: PageState;
  canvas: HTMLCanvasElement | null;
  textContent: TextContentHandle | null;
  scale: number | null;
  error: { code: string; message: string } | null;
}

export type ReadMode = "continuous" | "single";

export interface ViewportState {
  mode: ReadMode;
  scale: number;
  scrollTop: number;
  viewportHeight: number;
  viewportWidth: number;
  pageGeometries: PageGeometry[];
}

export interface RenderBudget {
  maxConcurrent: number;
  cacheBytes: number;
  prefetchPages: number;
}

/// 契约默认值（R3）：并发 2、缓存 256 MiB、预取 2。
// 实测调整：并发 3 让首屏两页几乎同时到位；预存取 1，避免大文档一次抢占过多解析带宽。
export const DEFAULT_BUDGET: RenderBudget = {
  maxConcurrent: 3,
  cacheBytes: 268_435_456,
  prefetchPages: 1,
};

export interface RenderScheduler {
  setDocument(handle: DocumentHandle | null): void;
  setViewport(v: ViewportState): void;
  setBudget(b: Partial<RenderBudget>): void;
  getPageState(pageNo: number): PageRenderState | undefined;
  subscribe(cb: (states: ReadonlyMap<number, PageRenderState>) => void): () => void;
  dispose(): void;
}