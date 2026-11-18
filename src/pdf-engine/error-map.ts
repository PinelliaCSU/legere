// pdfjs 异常 -> 契约 12 个错误码（docs/06 §7 / docs/05 第 19-23 行）。
//
// 判据必须是 err.name / err.status，不能靠 message 子串猜：
// 旧实现把 MissingPDFException、UnexpectedResponseException(403/404)、
// PasswordException 全都混成 E_PDF_CORRUPT 或 E_INTERNAL，上层于是给出
// 「PDF 已损坏」这种误导性提示。

export type PdfErrorCode =
  | "E_INVALID_ARG"
  | "E_NOT_FOUND"
  | "E_DB"
  | "E_IO"
  | "E_PERMISSION"
  | "E_PDF_CORRUPT"
  | "E_PDF_ENCRYPTED"
  | "E_PDF_NO_TEXT"
  | "E_BUSY"
  | "E_UNSUPPORTED"
  | "E_CANCELED"
  | "E_INTERNAL";

export type PdfErrorStage = "open" | "page" | "text" | "render" | "resource";

export interface PdfErrorContext {
  readonly stage?: PdfErrorStage;
  /// 已知是哪个引擎资源出的问题时，直接归类为资源初始化失败。
  readonly resource?: "worker" | "cmap" | "standard_font" | "wasm" | "icc";
}

const MESSAGES: Record<PdfErrorCode, string> = {
  E_INVALID_ARG: "参数不合法",
  E_NOT_FOUND: "PDF 文件不存在或已被移动",
  E_DB: "本地数据库出错",
  E_IO: "读取 PDF 文件失败，可以重试",
  E_PERMISSION: "没有权限读取这个 PDF 文件",
  E_PDF_CORRUPT: "这个 PDF 已损坏，无法打开",
  E_PDF_ENCRYPTED: "这个 PDF 有密码保护，暂不支持打开",
  E_PDF_NO_TEXT: "这个 PDF 没有可提取的文字",
  E_BUSY: "同类任务正在进行中",
  E_UNSUPPORTED: "当前环境不支持该操作",
  E_CANCELED: "已取消",
  E_INTERNAL: "PDF 引擎内部错误",
};

export const RESOURCE_FAILURE_MESSAGE = "PDF 引擎资源初始化失败";

const STACK_LIMIT = 800;

export class PdfEngineError extends Error {
  readonly code: PdfErrorCode;
  /// pdfjs 原始异常名（如 MissingPDFException / PasswordException），无则 null。
  readonly pdfjsName: string | null;
  /// UnexpectedResponseException 的 HTTP 状态码。
  readonly pdfjsStatus: number | null;
  /// 原始 message + stack 摘要，只用于日志与排查。
  readonly detail: string | null;

  constructor(
    code: PdfErrorCode,
    message?: string,
    original?: { name?: string | null; status?: number | null; detail?: string | null },
  ) {
    super(message ?? MESSAGES[code]);
    this.name = "PdfEngineError";
    this.code = code;
    this.pdfjsName = original?.name ?? null;
    this.pdfjsStatus = original?.status ?? null;
    this.detail = original?.detail ?? null;
  }
}

export function isPdfEngineError(value: unknown): value is PdfEngineError {
  return value instanceof PdfEngineError;
}

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  code?: unknown;
  stack?: unknown;
}

function asErrorLike(err: unknown): ErrorLike {
  if (typeof err === "object" && err !== null) return err as ErrorLike;
  return { message: String(err) };
}

function errorName(err: unknown): string | null {
  const like = asErrorLike(err);
  return typeof like.name === "string" && like.name.length > 0 ? like.name : null;
}

function errorStatus(err: unknown): number | null {
  const like = asErrorLike(err);
  if (typeof like.status === "number") return like.status;
  return null;
}

/// HTTP 状态码 -> 错误码（字节流协议返回的 403/404/410/423/500）。
export function statusToCode(status: number): PdfErrorCode {
  if (status === 403) return "E_PERMISSION";
  if (status === 404 || status === 410) return "E_NOT_FOUND";
  if (status === 423) return "E_IO";
  if (status >= 400) return "E_IO";
  return "E_INTERNAL";
}

const RESOURCE_HINTS = ["cmap", "standardfontdata", "standard font", "wasm", "icc", "worker", "fetchbinarydata"];

function looksLikeResourceFailure(message: string, name: string | null): boolean {
  if (name === "InvalidPDFException" || name === "PasswordException") return false;
  const lower = message.toLowerCase();
  return RESOURCE_HINTS.some((hint) => lower.includes(hint));
}

function buildDetail(err: unknown): string | null {
  const like = asErrorLike(err);
  const message = typeof like.message === "string" ? like.message : "";
  const stack = typeof like.stack === "string" ? like.stack : "";
  const combined = stack.length > 0 ? message + "\n" + stack : message;
  if (combined.length === 0) return null;
  return combined.length > STACK_LIMIT ? combined.slice(0, STACK_LIMIT) + "…" : combined;
}

/// 把 pdfjs（或任何下层）抛出的东西归一成 PdfEngineError。
export function toPdfEngineError(err: unknown, context: PdfErrorContext = {}): PdfEngineError {
  if (isPdfEngineError(err)) return err;

  const name = errorName(err);
  const status = errorStatus(err);
  const like = asErrorLike(err);
  const message = typeof like.message === "string" ? like.message : String(err ?? "");
  const original = { name, status, detail: buildDetail(err) };

  if (name === "AbortException" || name === "RenderingCancelledException") {
    return new PdfEngineError("E_CANCELED", undefined, original);
  }
  if (name === "PasswordException") {
    return new PdfEngineError("E_PDF_ENCRYPTED", undefined, original);
  }
  if (name === "InvalidPDFException") {
    return new PdfEngineError("E_PDF_CORRUPT", undefined, original);
  }
  if (name === "MissingPDFException") {
    return new PdfEngineError("E_NOT_FOUND", undefined, original);
  }
  if (name === "UnexpectedResponseException") {
    return new PdfEngineError(status === null ? "E_IO" : statusToCode(status), undefined, original);
  }
  // node fs 侧：ENOENT = 文件已消失；EACCES/EPERM = 权限。
  if (like.code === "ENOENT") {
    return new PdfEngineError("E_NOT_FOUND", undefined, original);
  }
  if (like.code === "EACCES" || like.code === "EPERM") {
    return new PdfEngineError("E_PERMISSION", undefined, original);
  }

  // worker / cMap / standard font / wasm / icc 取不到：这是引擎环境问题，
  // 不是「PDF 损坏」，所以 message 必须说清楚。
  if (context.resource !== undefined || looksLikeResourceFailure(message, name)) {
    return new PdfEngineError("E_INTERNAL", RESOURCE_FAILURE_MESSAGE, original);
  }
  if (context.stage === "page" || context.stage === "text" || context.stage === "render") {
    // 单页几何/内容失败：局部损坏，抛带 code 的错让上层给重试入口。
    return new PdfEngineError("E_PDF_CORRUPT", undefined, original);
  }
  return new PdfEngineError("E_INTERNAL", undefined, original);
}
