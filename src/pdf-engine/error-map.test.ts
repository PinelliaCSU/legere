import { describe, expect, it } from "vitest";

import {
  PdfEngineError,
  RESOURCE_FAILURE_MESSAGE,
  isPdfEngineError,
  statusToCode,
  toPdfEngineError,
} from "./error-map";

/// 复刻 pdfjs BaseException 的形状：name 来自构造函数名，status 来自 HTTP 层。
function pdfjsError(name: string, message: string, extra: Record<string, unknown> = {}): Error {
  const err = new Error(message);
  Object.defineProperty(err, "name", { value: name, writable: true });
  return Object.assign(err, extra);
}

describe("错误分类按 err.name / err.status，不看 message 子串", () => {
  it("PasswordException -> E_PDF_ENCRYPTED", () => {
    const out = toPdfEngineError(pdfjsError("PasswordException", "No password given", { code: 1 }));
    expect(out.code).toBe("E_PDF_ENCRYPTED");
    expect(out.pdfjsName).toBe("PasswordException");
  });

  it("InvalidPDFException -> E_PDF_CORRUPT", () => {
    const out = toPdfEngineError(pdfjsError("InvalidPDFException", "Invalid PDF structure."));
    expect(out.code).toBe("E_PDF_CORRUPT");
  });

  it("MissingPDFException -> E_NOT_FOUND（不是「损坏」）", () => {
    const out = toPdfEngineError(pdfjsError("MissingPDFException", "Missing PDF file."));
    expect(out.code).toBe("E_NOT_FOUND");
  });

  it("UnexpectedResponseException 按 status 分派", () => {
    const cases: Array<[number, string]> = [
      [403, "E_PERMISSION"],
      [404, "E_NOT_FOUND"],
      [410, "E_NOT_FOUND"],
      [423, "E_IO"],
      [500, "E_IO"],
      [503, "E_IO"],
    ];
    for (const [status, code] of cases) {
      const out = toPdfEngineError(
        pdfjsError("UnexpectedResponseException", "Unexpected server response (" + status + ")", { status }),
      );
      expect(out.code).toBe(code);
      expect(out.pdfjsStatus).toBe(status);
    }
  });

  it("AbortException -> E_CANCELED", () => {
    expect(toPdfEngineError(pdfjsError("AbortException", "worker was destroyed")).code).toBe("E_CANCELED");
  });

  it("UnknownErrorException -> E_INTERNAL", () => {
    expect(toPdfEngineError(pdfjsError("UnknownErrorException", "Unknown error")).code).toBe("E_INTERNAL");
  });

  it("cMap/wasm/字体 资源取不到 -> E_INTERNAL「引擎资源初始化失败」，而不是「PDF 损坏」", () => {
    const cmap = toPdfEngineError(
      pdfjsError("UnknownErrorException", "Unable to load CMap data at: http://127.0.0.1/pdfjs/cmaps/UniGB-UCS2-H.bcmap"),
    );
    expect(cmap.code).toBe("E_INTERNAL");
    expect(cmap.message).toBe(RESOURCE_FAILURE_MESSAGE);
    expect(cmap.message.includes("损坏")).toBe(false);

    const wasm = toPdfEngineError(pdfjsError("Error", "Failed to fetch wasm openjpeg.wasm"));
    expect(wasm.code).toBe("E_INTERNAL");
    expect(wasm.message).toBe(RESOURCE_FAILURE_MESSAGE);
  });

  it("真损坏即使 message 里带 cmap 字样也不能被当成资源失败", () => {
    const out = toPdfEngineError(pdfjsError("InvalidPDFException", "Invalid PDF structure near cmap"));
    expect(out.code).toBe("E_PDF_CORRUPT");
  });

  it("保留原始 name / status / stack 摘要", () => {
    const source = pdfjsError("UnexpectedResponseException", "Unexpected server response (404)", { status: 404 });
    const out = toPdfEngineError(source);
    expect(out.pdfjsName).toBe("UnexpectedResponseException");
    expect(out.pdfjsStatus).toBe(404);
    expect(out.detail).toContain("Unexpected server response (404)");
  });

  it("已经是 PdfEngineError 时不重复包装（幂等）", () => {
    const original = new PdfEngineError("E_PDF_CORRUPT");
    expect(toPdfEngineError(original)).toBe(original);
    expect(isPdfEngineError(original)).toBe(true);
    expect(isPdfEngineError(new Error("x"))).toBe(false);
  });

  it("单页几何/文本阶段失败 -> E_PDF_CORRUPT（供上层给重试入口）", () => {
    expect(toPdfEngineError(new Error("bad page dict"), { stage: "page" }).code).toBe("E_PDF_CORRUPT");
    expect(toPdfEngineError(new Error("bad text"), { stage: "text" }).code).toBe("E_PDF_CORRUPT");
  });

  it("node fs 的错误码同样能归类", () => {
    expect(toPdfEngineError(Object.assign(new Error("not found"), { code: "ENOENT" })).code).toBe("E_NOT_FOUND");
    expect(toPdfEngineError(Object.assign(new Error("denied"), { code: "EACCES" })).code).toBe("E_PERMISSION");
  });

  it("statusToCode 是纯函数表", () => {
    expect(statusToCode(403)).toBe("E_PERMISSION");
    expect(statusToCode(404)).toBe("E_NOT_FOUND");
    expect(statusToCode(410)).toBe("E_NOT_FOUND");
    expect(statusToCode(423)).toBe("E_IO");
    expect(statusToCode(500)).toBe("E_IO");
  });
});
