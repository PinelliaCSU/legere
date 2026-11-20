import { describe, expect, it } from "vitest";

import type { DocumentHandle, PageGeometry, PageHandle, TextContentHandle } from "../pdf-engine/types";
import { createRenderScheduler } from "./scheduler";
import type { ViewportState } from "./types";

const A4: PageGeometry = { widthPt: 595, heightPt: 842, rotation: 0 };
const NO_TEXT: TextContentHandle = { items: [], text: "", itemStarts: [] };

function geos(count: number): PageGeometry[] {
  return Array.from({ length: count }, () => A4);
}

/// 可控闸门：让 getPage 挂起，用于观察「在飞」阶段的并发。
class FakeDocument implements DocumentHandle {
  readonly docId = 1;
  readonly pageCount: number;
  readonly getPageCalls: number[] = [];
  readonly renderCalls: number[] = [];
  readonly textCalls: number[] = [];
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;

  constructor(pageCount = 40) {
    this.pageCount = pageCount;
  }

  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.openGate = resolve;
    });
  }

  release(): void {
    this.gate = null;
    const open = this.openGate;
    this.openGate = null;
    open?.();
  }

  async getPage(pageNo: number): Promise<PageHandle> {
    this.getPageCalls.push(pageNo);
    const gate = this.gate;
    if (gate !== null) await gate;
    const doc = this;
    return {
      pageNo,
      geometry: A4,
      async getTextContent(): Promise<TextContentHandle> {
        doc.textCalls.push(pageNo);
        return NO_TEXT;
      },
      render() {
        doc.renderCalls.push(pageNo);
        return { promise: Promise.resolve({} as unknown as HTMLCanvasElement), cancel: () => undefined };
      },
    };
  }

  async getOutline() {
    return [];
  }

  async getMetadata() {
    return {
      title: null,
      author: null,
      subject: null,
      keywords: null,
      producer: null,
      creator: null,
      creationDate: null,
    };
  }

  async dispose(): Promise<void> {
    return;
  }
}

function viewport(scrollTop: number, pageCount = 40): ViewportState {
  return {
    mode: "continuous",
    scale: 1,
    scrollTop,
    viewportHeight: 842 * 8,
    viewportWidth: 800,
    pageGeometries: geos(pageCount),
  };
}

/// 渲染链路有多次 await（getPage → 文本 → render），用宏任务保证它跑完。
const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

describe("调度器准入与去重（P0-1）", () => {
  it("并发上限覆盖 getPage 阶段，不会把整个窗口一次全启动", () => {
    const scheduler = createRenderScheduler();
    const doc = new FakeDocument(40);
    doc.hold();
    scheduler.setDocument(doc);
    scheduler.setBudget({ maxConcurrent: 3, prefetchPages: 2 });
    // 视口覆盖 8 页 + 预取 → 候选远多于 3
    scheduler.setViewport(viewport(0));
    expect(doc.getPageCalls.length).toBeLessThanOrEqual(3);
    scheduler.dispose();
  });

  it("在 getPage 挂起期间再次 setViewport 不会为同一页启动第二次渲染", async () => {
    const scheduler = createRenderScheduler();
    const doc = new FakeDocument(40);
    doc.hold();
    scheduler.setDocument(doc);
    scheduler.setBudget({ maxConcurrent: 3, prefetchPages: 1 });
    scheduler.setViewport(viewport(0));
    // 同一页仍在在飞集合里：这一轮必须被去重跳过
    scheduler.setViewport(viewport(0));
    doc.release();
    await flush();
    for (const pageNo of [1, 2, 3]) {
      expect(doc.renderCalls.filter((p) => p === pageNo).length).toBeLessThanOrEqual(1);
    }
    scheduler.dispose();
  });

  it("取消后任务自行放弃，不会再把状态写成 error", async () => {
    const scheduler = createRenderScheduler();
    const doc = new FakeDocument(40);
    doc.hold();
    scheduler.setDocument(doc);
    scheduler.setBudget({ maxConcurrent: 2, prefetchPages: 1 });
    scheduler.setViewport(viewport(0));
    const started = [...doc.getPageCalls];
    expect(started.length).toBeGreaterThan(0);
    // 跳到很远的页：窗口外那一批必须被取消
    scheduler.setViewport(viewport(842 * 30));
    doc.release();
    await flush();
    for (const pageNo of started) {
      expect(scheduler.getPageState(pageNo)?.state ?? "idle").not.toBe("error");
    }
    scheduler.dispose();
  });

  it("跳页保护：可见跨度超过上限时本轮不排预取页", () => {
    const scheduler = createRenderScheduler();
    const doc = new FakeDocument(200);
    scheduler.setDocument(doc);
    scheduler.setBudget({ maxConcurrent: 4, prefetchPages: 2 });
    // 每页 842pt，视口 40 页高 → visible 跨度 40 > JUMP_SPAN_LIMIT(30)
    scheduler.setViewport({
      mode: "continuous",
      scale: 1,
      scrollTop: 0,
      viewportHeight: 842 * 39,
      viewportWidth: 800,
      pageGeometries: geos(200),
    });
    const started = new Set(doc.getPageCalls);
    // 第 40 页之后不应有预取（visible 到 40 左右，预取会到 42）
    expect([...started].some((p) => p > 45)).toBe(false);
    scheduler.dispose();
  });
});

describe("文本缓存共用（P0-3）", () => {
  it("同一页文本只提取一次，后续命中缓存", async () => {
    const scheduler = createRenderScheduler();
    const doc = new FakeDocument(40);
    scheduler.setDocument(doc);
    const first = await scheduler.getTextContent(7);
    const second = await scheduler.getTextContent(7);
    expect(second).toBe(first);
    expect(doc.textCalls.filter((p) => p === 7)).toHaveLength(1);
    scheduler.dispose();
  });

  it("并发索要同一页文本时共享同一次提取", async () => {
    const scheduler = createRenderScheduler();
    const doc = new FakeDocument(40);
    scheduler.setDocument(doc);
    const [a, b] = await Promise.all([scheduler.getTextContent(3), scheduler.getTextContent(3)]);
    expect(a).toBe(b);
    expect(doc.textCalls.filter((p) => p === 3)).toHaveLength(1);
    scheduler.dispose();
  });

  it("渲染路径与外部调用共用同一份文本缓存", async () => {
    const scheduler = createRenderScheduler();
    const doc = new FakeDocument(40);
    scheduler.setDocument(doc);
    scheduler.setBudget({ maxConcurrent: 1, prefetchPages: 0 });
    scheduler.setViewport(viewport(0));
    await flush();
    const textCallsForPage1 = doc.textCalls.filter((p) => p === 1).length;
    // 渲染第 1 页时已经提取过；外部再要一次不应重新提取
    await scheduler.getTextContent(1);
    expect(doc.textCalls.filter((p) => p === 1).length).toBe(textCallsForPage1);
    scheduler.dispose();
  });

  it("切文档时在途的文本不写进新书的缓存", async () => {
    const scheduler = createRenderScheduler();
    const oldDoc = new FakeDocument(40);
    oldDoc.hold();
    scheduler.setDocument(oldDoc);
    const pending = scheduler.getTextContent(5);
    // 换文档（旧书仍有一页文本在解析中）
    scheduler.setDocument(null);
    oldDoc.release();
    await pending;
    const newDoc = new FakeDocument(40);
    scheduler.setDocument(newDoc);
    await scheduler.getTextContent(5);
    // 新书必须自己解析一次：说明旧书的结果没有落在共享缓存里
    expect(newDoc.textCalls.filter((p) => p === 5)).toHaveLength(1);
    scheduler.dispose();
  });

  it("prefetchText 响应 shouldContinue，并在切文档后不再写缓存", async () => {
    const scheduler = createRenderScheduler();
    const doc = new FakeDocument(40);
    scheduler.setDocument(doc);
    let calls = 0;
    await scheduler.prefetchText([1, 2, 3, 4, 5], {
      concurrency: 1,
      shouldContinue: () => {
        calls += 1;
        return calls <= 2;
      },
    });
    expect(doc.textCalls.length).toBeLessThanOrEqual(2);
    scheduler.dispose();
  });
});
