// M05 · PDF.js Display API 适配层。
//
// 硬约束：
// 1. 全项目只有本目录可以 import "pdfjs-dist"（docs/02 §2）。
// 2. 只用 Display API；不引入 Viewer 组件、不用 renderTextLayer（V-01 实测已移除）。
// 3. 对上层暴露的是 docs/05 §7 的 DocumentHandle/PageHandle，pdfjs 类型不外泄。

import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
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
import { PdfEngineError, toPdfEngineError, type PdfErrorStage } from "./error-map";
import { buildPdfResourceUrls, currentDocumentBaseUri, type PdfResourceUrls } from "./resources";
import { describeSourcePath, logPdfInfo, reportPdfFailure } from "./diagnostics";
import { buildTextContent, toTextItem } from "./text-content";

export { PdfEngineError } from "./error-map";

/// 打开序号：同一 docId 又发起打开时，旧的那次结果必须丢弃。
const openSequenceByDocId = new Map<number, number>();
let openSequence = 0;

async function destroyQuietly(task: PDFDocumentLoadingTask | null): Promise<void> {
  if (task === null) return;
  try {
    await task.destroy();
  } catch (err) {
    logPdfInfo("destroy loadingTask 失败", { detail: err instanceof Error ? err.message : String(err) });
  }
}

/// 单页几何：失败要抛带 code 的错（局部损坏），不能静默给出 0x0。
function readGeometry(page: PDFPageProxy): PageGeometry {
  try {
    const viewport = page.getViewport({ scale: 1 });
    const rotation = ((page.rotate % 360) + 360) % 360;
    return {
      widthPt: viewport.width,
      heightPt: viewport.height,
      rotation: rotation === 90 || rotation === 180 || rotation === 270 ? rotation : 0,
    };
  } catch (err) {
    throw toPdfEngineError(err, { stage: "page" });
  }
}

class PageHandleImpl implements PageHandle {
  readonly pageNo: number;
  readonly geometry: PageGeometry;

  constructor(private readonly page: PDFPageProxy) {
    this.pageNo = page.pageNumber;
    this.geometry = readGeometry(page);
  }

  async getTextContent(): Promise<TextContentHandle> {
    let content: Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;
    try {
      content = await this.page.getTextContent();
    } catch (err) {
      // 文本取不到必须报错：静默返回空数组会让上层以为「这页本来就没字」。
      throw toPdfEngineError(err, { stage: "text" });
    }
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
    const handle = buildTextContent(items, hasEol);
    if (handle.items.length === 0) {
      logPdfInfo("页面没有可提取文本（可能是扫描页）", { pageNo: this.pageNo });
    }
    return handle;
  }

  render(req: RenderRequest): RenderTaskHandle {
    const canvas = document.createElement("canvas");
    const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    const scale = req.scale * dpr;
    const viewport = this.page.getViewport({ scale, rotation: this.geometry.rotation });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.width = viewport.width / dpr + "px";
    canvas.style.height = viewport.height / dpr + "px";

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
      // 取消是正常流程（契约 R5/05 §7），不应作为错误冒泡到 UI；
      // toPdfEngineError 已经把 AbortException / RenderingCancelledException 归为 E_CANCELED。
      (err: unknown) => {
        throw toPdfEngineError(err, { stage: "render" });
      },
    );

    return { promise, cancel: () => task.cancel() };
  }

  dispose(): void {
    try {
      this.page.cleanup();
    } catch (err) {
      logPdfInfo("page.cleanup 失败", { pageNo: this.pageNo, detail: err instanceof Error ? err.message : String(err) });
    }
  }
}

class DocumentHandleImpl implements DocumentHandle {
  readonly docId: number;
  readonly pageCount: number;
  private disposed = false;
  private readonly pageCache = new Map<number, Promise<PageHandleImpl>>();

  constructor(
    private readonly doc: PDFDocumentProxy,
    private readonly loadingTask: PDFDocumentLoadingTask,
    docId: number,
  ) {
    this.docId = docId;
    this.pageCount = doc.numPages;
  }

  async getPage(pageNo: number): Promise<PageHandle> {
    if (this.disposed) {
      throw new PdfEngineError("E_CANCELED", "文档已关闭");
    }
    if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > this.pageCount) {
      throw new PdfEngineError("E_INVALID_ARG", "页码越界: " + String(pageNo));
    }
    const cached = this.pageCache.get(pageNo);
    if (cached !== undefined) return cached;

    const promise = this.doc.getPage(pageNo).then(
      (page) => new PageHandleImpl(page),
      (err: unknown) => {
        throw toPdfEngineError(err, { stage: "page" });
      },
    );
    // 失败不得永久缓存：否则这一页此后再也重试不出来。
    void promise.catch(() => {
      this.pageCache.delete(pageNo);
    });
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
    const pending = [...this.pageCache.values()];
    this.pageCache.clear();
    // 只 clear 缓存会把 pdfjs 的页面资源（字体、图片位图）留在 worker 里，必须逐页 cleanup。
    for (const entry of pending) {
      try {
        (await entry).dispose();
      } catch {
        // 打开就失败的页没有资源要清。
      }
    }
    await destroyQuietly(this.loadingTask);
  }
}

export const pdfEngine: PdfEngine = {
  async openDocument({ url, docId }) {
    const startedAt = Date.now();
    const sequence = ++openSequence;
    openSequenceByDocId.set(docId, sequence);

    // 资源 URL 一律绝对化：pdfjs 会把字符串原样交给 worker 拼接 fetch。
    const baseUri = currentDocumentBaseUri();
    const resources: PdfResourceUrls = buildPdfResourceUrls(baseUri);
    logPdfInfo("openDocument 开始", { documentId: docId, url, baseUri, resources });

    let loadingTask: PDFDocumentLoadingTask | null = null;
    let destroyed = false;
    const destroyOnce = async (): Promise<void> => {
      if (destroyed) return;
      destroyed = true;
      await destroyQuietly(loadingTask);
    };

    try {
      loadingTask = getDocument({
        url,
        // 中文/日文/韩文 PDF 的 CID 字体必须靠 cMap 才能解码，否则整页没有文字；
        // 非内嵌标准字体（Helvetica 等）需要 standardFontData；JPX/JBIG2 图片与 ICC
        // 颜色空间需要 wasm/icc —— 缺任何一个都只会表现为「打开成功但整页空白」。
        cMapUrl: resources.cMapUrl,
        cMapPacked: true,
        standardFontDataUrl: resources.standardFontDataUrl,
        wasmUrl: resources.wasmUrl,
        iccUrl: resources.iccUrl,
      });
      const doc = await loadingTask.promise;
      if (openSequenceByDocId.get(docId) !== sequence) {
        // 期间同 docId 又发起了一次打开：这份结果已作废，必须销毁而不是返回。
        await destroyOnce();
        throw new PdfEngineError("E_CANCELED", "文档已切换，本次打开被取消");
      }
      openSequenceByDocId.delete(docId);
      logPdfInfo("openDocument 成功", { documentId: docId, pageCount: doc.numPages, elapsedMs: Date.now() - startedAt });
      return new DocumentHandleImpl(doc, loadingTask, docId);
    } catch (err) {
      const stage: PdfErrorStage = "open";
      const error = toPdfEngineError(err, { stage });
      await destroyOnce();
      if (error.code === "E_CANCELED") {
        logPdfInfo("openDocument 被取消", { documentId: docId, elapsedMs: Date.now() - startedAt });
      } else {
        void reportPdfFailure({
          stage,
          documentId: docId,
          sourcePath: describeSourcePath(url),
          url,
          resources,
          workerSrc: String(GlobalWorkerOptions.workerSrc),
          error,
          elapsedMs: Date.now() - startedAt,
        });
      }
      throw error;
    }
  },
};
