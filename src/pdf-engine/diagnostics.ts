// 可开关的诊断日志：console + 结构化对象，不落盘、不引入依赖。
//
// 开关（任一命中即开）：
//   globalThis.__LEGERE_PDF_DIAGNOSTICS__ = true
//   localStorage["legere:pdf:diagnostics"] = "1"
//
// 默认安静：只有失败才输出一条 warn（并附带 URL / 状态 / 字节头等事实）。
// 打开开关后才会额外做网络探测（Range 取前 8 字节）+ 逐步 info。

import type { PdfEngineError, PdfErrorStage } from "./error-map";
import type { PdfResourceUrls } from "./resources";

export const DIAGNOSTICS_STORAGE_KEY = "legere:pdf:diagnostics";

const PROBE_TIMEOUT_MS = 1500;
const RANGE_FIRST_BYTES = "bytes=0-7";

export function isPdfDiagnosticsEnabled(): boolean {
  try {
    const globalFlag = (globalThis as { __LEGERE_PDF_DIAGNOSTICS__?: unknown }).__LEGERE_PDF_DIAGNOSTICS__;
    if (globalFlag === true) return true;
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(DIAGNOSTICS_STORAGE_KEY) === "1";
    }
  } catch {
    // localStorage 在受限上下文会抛（隐私模式/权限），诊断开关不能反过来打断阅读。
  }
  return false;
}

export function logPdfInfo(message: string, data?: Record<string, unknown>): void {
  if (!isPdfDiagnosticsEnabled()) return;
  console.info("[pdf] " + message, data ?? {});
}

export function logPdfWarning(message: string, data?: Record<string, unknown>): void {
  console.warn("[pdf] " + message, data ?? {});
}

export interface ProbeResult {
  readonly url: string;
  /// "http-200" / "unavailable" / "error:TimeoutError" 这类短状态串。
  readonly status: string;
  readonly contentLength: number | null;
  readonly first8Hex: string | null;
  readonly isPdfMagic: boolean | null;
  readonly error: string | null;
}

const EMPTY_PROBE = (url: string, status: string, error: string | null): ProbeResult => ({
  url,
  status,
  contentLength: null,
  first8Hex: null,
  isPdfMagic: null,
  error,
});

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  if (typeof fetch !== "function") {
    throw new Error("fetch 不可用");
  }
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer =
    controller === null
      ? null
      : setTimeout(() => {
          controller.abort();
        }, PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, controller === null ? init : { ...init, signal: controller.signal });
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/// 只读探测：请求 URL、Range、HTTP 状态、内容长度、前 8 字节是否 %PDF-。
export async function probePdfSource(url: string, range: string = RANGE_FIRST_BYTES): Promise<ProbeResult> {
  if (typeof url !== "string" || url.length === 0) return EMPTY_PROBE(url, "unavailable", "url 为空");
  try {
    const response = await fetchWithTimeout(url, { method: "GET", headers: { Range: range } });
    const contentLengthHeader = response.headers.get("content-length");
    const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
    let first8Hex: string | null = null;
    let isPdfMagic: boolean | null = null;
    try {
      const buffer = new Uint8Array(await response.arrayBuffer());
      const head = buffer.subarray(0, 8);
      first8Hex = Array.from(head, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
      isPdfMagic = new TextDecoder().decode(head).startsWith("%PDF-");
    } catch (err) {
      return {
        url,
        status: "http-" + response.status,
        contentLength: Number.isFinite(contentLength) ? contentLength : null,
        first8Hex,
        isPdfMagic,
        error: err instanceof Error ? err.name + ": " + err.message : String(err),
      };
    }
    return {
      url,
      status: "http-" + response.status,
      contentLength: Number.isFinite(contentLength) ? contentLength : null,
      first8Hex,
      isPdfMagic,
      error: response.ok ? null : "HTTP " + response.status,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return EMPTY_PROBE(url, "unavailable", name + ": " + (err instanceof Error ? err.message : String(err)));
  }
}

/// 资源目录探测：只看 status，确认 public/pdfjs/** 真的被打进包里。
export async function probePdfResources(urls: PdfResourceUrls): Promise<Record<string, ProbeResult>> {
  const entries: Array<[string, string]> = [
    ["worker", ""],
    ["cmap", urls.cMapUrl + "UniGB-UCS2-H.bcmap"],
    ["standardFont", urls.standardFontDataUrl + "LiberationSans-Regular.ttf"],
    ["wasm", urls.wasmUrl + "openjpeg.wasm"],
    ["icc", urls.iccUrl + "CGATS001Compat-v2-micro.icc"],
  ];
  const result: Record<string, ProbeResult> = {};
  for (const [key, url] of entries) {
    if (url.length === 0) {
      result[key] = EMPTY_PROBE(key, "worker-url-unresolved", null);
      continue;
    }
    try {
      const response = await fetchWithTimeout(url, { method: "HEAD" });
      result[key] = { ...EMPTY_PROBE(url, "http-" + response.status, response.ok ? null : "HTTP " + response.status) };
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error";
      result[key] = EMPTY_PROBE(url, "unavailable", name);
    }
  }
  return result;
}

export interface PdfFailureReport {
  readonly stage: PdfErrorStage;
  readonly documentId: number;
  /// 上层只给 url；能反推出真实路径就记路径，否则记 "unknown"。
  readonly sourcePath: string;
  readonly url: string;
  readonly resources: PdfResourceUrls;
  readonly workerSrc: string;
  readonly error: PdfEngineError;
  readonly elapsedMs: number;
}

/// 失败时必须调用：一条 warn，带满排查需要的字段。
export async function reportPdfFailure(report: PdfFailureReport): Promise<void> {
  const enabled = isPdfDiagnosticsEnabled();
  const payload: Record<string, unknown> = {
    stage: report.stage,
    documentId: report.documentId,
    path: report.sourcePath,
    url: report.url,
    elapsedMs: report.elapsedMs,
    workerSrc: report.workerSrc,
    resources: {
      cMapUrl: report.resources.cMapUrl,
      standardFontDataUrl: report.resources.standardFontDataUrl,
      wasmUrl: report.resources.wasmUrl,
      iccUrl: report.resources.iccUrl,
    },
    error: {
      code: report.error.code,
      name: report.error.pdfjsName,
      status: report.error.pdfjsStatus,
      message: report.error.message,
      stack: report.error.detail,
    },
  };
  if (enabled) {
    payload.source = await probePdfSource(report.url);
    payload.resourceProbes = await probePdfResources(report.resources);
  }
  logPdfWarning(report.error.code === "E_CANCELED" ? "打开被取消" : "打开失败", payload);
}

/// url -> 真实路径（file: URL 可还原；其余记为 unknown）。
export function describeSourcePath(url: string): string {
  if (typeof url !== "string") return "unknown";
  if (url.startsWith("file:")) {
    try {
      return decodeURIComponent(new URL(url).pathname);
    } catch {
      return "unknown";
    }
  }
  return "unknown";
}
