// PDF.js 运行时资源 URL 的构造（纯函数，可单测、不碰 DOM）。
//
// 为什么必须是绝对 URL：pdfjs 6 的 getFactoryUrlProp 只校验「以 / 结尾」，
// 并把字符串原样保留；当 cMapUrl / standardFontDataUrl / wasmUrl 三者齐备时
// useWorkerFetch 默认为 true，此时 worker 内用 baseUrl + filename 直接 fetch，
// 相对串会被解析到 worker 脚本自身的位置（/assets/pdf.worker.min-*.mjs 旁边）→ 404。
// 所以这里统一用 document.baseURI 绝对化，且保证尾斜杠。

export interface PdfResourceUrls {
  readonly cMapUrl: string;
  readonly standardFontDataUrl: string;
  readonly wasmUrl: string;
  readonly iccUrl: string;
}

/// 无 DOM 环境（node / 单测）时的占位基址：只用来构造合法绝对 URL，不会真的被请求。
export const FALLBACK_BASE_URI = "http://localhost/";

/// 相对目录 -> 绝对 URL，并保证以 "/" 结尾（pdfjs 的唯一硬校验）。
export function toAbsoluteResourceUrl(relativeDir: string, baseUri: string): string {
  if (typeof baseUri !== "string" || baseUri.length === 0) {
    throw new Error("构造 PDF 资源 URL 需要非空的 base URI");
  }
  const resolved = new URL(relativeDir, baseUri).href;
  return resolved.endsWith("/") ? resolved : resolved + "/";
}

/// 四个资源目录一次性构造：漏传任何一个都会让 pdfjs 静默降级。
export function buildPdfResourceUrls(baseUri: string): PdfResourceUrls {
  return {
    cMapUrl: toAbsoluteResourceUrl("pdfjs/cmaps/", baseUri),
    standardFontDataUrl: toAbsoluteResourceUrl("pdfjs/standard_fonts/", baseUri),
    wasmUrl: toAbsoluteResourceUrl("pdfjs/wasm/", baseUri),
    iccUrl: toAbsoluteResourceUrl("pdfjs/iccs/", baseUri),
  };
}

/// 当前文档基址。document.baseURI 已经考虑了 <base>、hash 与 query。
export function currentDocumentBaseUri(): string {
  if (typeof document !== "undefined" && typeof document.baseURI === "string" && document.baseURI.length > 0) {
    return document.baseURI;
  }
  return FALLBACK_BASE_URI;
}
