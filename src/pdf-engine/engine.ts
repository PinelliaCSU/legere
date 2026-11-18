// M05 · PDF.js Display API 适配层。
//
// 硬约束：
// 1. 全项目只有本目录可以 import "pdfjs-dist"（docs/02 §2）。
// 2. 只用 Display API；不引入 Viewer 组件、不用 renderTextLayer（V-01 实测已移除）。
// 3. 对上层暴露的是 docs/05 §7 的 DocumentHandle/PageHandle，pdfjs 类型不外泄。

import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type PDFDocumentLoadingTask,
} from "pdfjs-dist";
// pdfjs 6 必须显式给 worker：否则打包后会去找不存在的 pdf.worker.mjs，
// getDocument 直接 reject（真实原因会被误判成「PDF 损坏」——本 bug 就是这样暴露的）。
// Vite 的 ?url 会把 worker 作为资源产出并返回最终 URL。
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

import type {
  DocumentHandle,
  OutlineNode,
  PageGeometry,
  PageHandle,
  PdfEngine,
  PdfMetadata,
  RenderRequest,
  RenderTaskHandle,
  TextContentHandle,
} from "./types";
import { buildTextContent, toTextItem } from "./text-content";

export class PdfEngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PdfEngineError";
    this.code = code;
  }
}

function normalizeError(err: unknown): PdfEngineError {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (lower.includes("password")) {
    return new PdfEngineError("E_PDF_ENCRYPTED", "这个 PDF 有密码保护，暂不支持打开");
  }
  if (lower.includes("invalid") || lower.includes("corrupt") || lower.includes("format")) {
    return new PdfEngineError("E_PDF_CORRUPT", "这个 PDF 已损坏，无法打开");
  }
  // worker / 网络 / 加载失败不属「PDF 损坏」：误判会掩盖真实原因（曾经踩过）。
  if (lower.includes("worker") || lower.includes("fetch") || lower.includes("network")) {
    return new PdfEngineError("E_INTERNAL", "PDF 引擎初始化失败");
  }
  return new PdfEngineError("E_INTERNAL", "PDF 引擎失败");
}

class PageHandleImpl implements PageHandle {
  readonly pageNo: number;
  readonly geometry: PageGeometry;

  constructor(private readonly page: PDFPageProxy) {
    this.pageNo = page.pageNumber;
    const viewport = page.getViewport({ scale: 1 });
    const rotation = ((page.rotate % 360) + 360) % 360;
    this.geometry = {
      widthPt: viewport.width,
      heightPt: viewport.height,
      rotation: (rotation === 90 || rotation === 180 || rotation === 270 ? rotation : 0) as 0 | 90 | 180 | 270,
    };
  }

  async getTextContent(): Promise<TextContentHandle> {
    const content = await this.page.getTextContent();
    // pdfjs 的 items 是 TextItem | TextMarkedContent 的联合；标记项没有 str，直接过滤掉。
    const raw = content.items as Array<{
      str?: unknown;
      transform?: number[];
      width?: number;
      height?: number;
      hasEOL?: boolean;
    }>;
    const textItems = raw.filter((item) => typeof item.str === "string");
    const hasEol = textItems.map((item) => item.hasEOL === true);
    const items = textItems.map((item) =>
      toTextItem({
        str: item.str as string,
        transform: item.transform ?? [],
        width: item.width ?? 0,
        height: item.height ?? 0,
        hasEOL: item.hasEOL,
      }),
    );
    return buildTextContent(items, hasEol);
  }

  render(req: RenderRequest): RenderTaskHandle {
    const canvas = document.createElement("canvas");
    const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    const scale = req.scale * dpr;
    const viewport = this.page.getViewport({ scale, rotation: this.geometry.rotation });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.width = `${viewport.width / dpr}px`;
    canvas.style.height = `${viewport.height / dpr}px`;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new PdfEngineError("E_INTERNAL", "无法创建 2D 画布上下文");
    }

    const task = this.page.render({
      canvasContext: context,
      viewport,
      canvas,
      ...(req.backgroundColor ? { background: req.backgroundColor } : {}),
    });

    const promise = task.promise.then(
      () => canvas,
      (err: unknown) => {
        // 取消是正常流程（契约 R5/05 §7），不应作为错误冒泡到 UI。
        const name = (err as { name?: string }).name ?? "";
        if (name.includes("RenderingCancelled") || name === "AbortException") {
          throw new PdfEngineError("E_CANCELED", "已取消");
        }
        throw normalizeError(err);
      },
    );

    return { promise, cancel: () => task.cancel() };
  }

  dispose(): void {
    this.page.cleanup();
  }
}

class DocumentHandleImpl implements DocumentHandle {
  readonly docId: number;
  readonly pageCount: number;
  private disposed = false;
  private readonly pageCache = new Map<number, Promise<PageHandle>>();

  constructor(
    private readonly doc: PDFDocumentProxy,
    private readonly loadingTask: PDFDocumentLoadingTask,
    docId: number,
  ) {
    this.docId = docId;
    this.pageCount = doc.numPages;
  }

  async getPage(pageNo: number): Promise<PageHandle> {
    if (pageNo < 1 || pageNo > this.pageCount) {
      throw new PdfEngineError("E_INVALID_ARG", `页码越界: ${pageNo}`);
    }
    const cached = this.pageCache.get(pageNo);
    if (cached) return cached;
    const promise = this.doc.getPage(pageNo).then((page) => new PageHandleImpl(page));
    this.pageCache.set(pageNo, promise);
    return promise;
  }

  async getOutline(): Promise<OutlineNode[]> {
    try {
      const outline = await this.doc.getOutline();
      if (!outline) return [];
      const map = async (nodes: typeof outline): Promise<OutlineNode[]> =>
        Promise.all(
          nodes.map(async (node) => ({
            title: node.title,
            pageNo: await this.resolveDestPage(node.dest),
            children: await map(node.items ?? []),
          })),
        );
      return await map(outline);
    } catch (err) {
      // Outline 是可选信息：失败返回空数组，不打断阅读（M05 Prompt 第 26 条）。
      console.warn("读取 PDF 目录失败", err);
      return [];
    }
  }

  private async resolveDestPage(dest: unknown): Promise<number | null> {
    try {
      const explicit = typeof dest === "string" ? await this.doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || explicit.length === 0) return null;
      const index = await this.doc.getPageIndex(explicit[0]);
      return index + 1;
    } catch {
      return null;
    }
  }

  async getMetadata(): Promise<PdfMetadata> {
    try {
      const { info } = await this.doc.getMetadata();
      const pick = (key: string): string | null => {
        const value = (info as Record<string, unknown>)[key];
        return typeof value === "string" && value.length > 0 ? value : null;
      };
      return {
        title: pick("Title"),
        author: pick("Author"),
        subject: pick("Subject"),
        keywords: pick("Keywords"),
        producer: pick("Producer"),
        creator: pick("Creator"),
        creationDate: pick("CreationDate"),
      };
    } catch {
      return { title: null, author: null, subject: null, keywords: null, producer: null, creator: null, creationDate: null };
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.pageCache.clear();
    await this.loadingTask.destroy();
  }
}

export const pdfEngine: PdfEngine = {
  async openDocument({ url, docId }) {
    try {
      const loadingTask = getDocument({ url });
      const doc = await loadingTask.promise;
      return new DocumentHandleImpl(doc, loadingTask, docId);
    } catch (err) {
      throw normalizeError(err);
    }
  },
};