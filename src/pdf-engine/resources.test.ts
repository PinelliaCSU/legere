import { describe, expect, it } from "vitest";

import {
  FALLBACK_BASE_URI,
  buildPdfResourceUrls,
  currentDocumentBaseUri,
  toAbsoluteResourceUrl,
} from "./resources";

const KEYS = ["cMapUrl", "standardFontDataUrl", "wasmUrl", "iccUrl"] as const;

describe("资源 URL 必须绝对且以 / 结尾（pdfjs 只校验尾斜杠）", () => {
  const bases = [
    "http://127.0.0.1:5273/",
    "http://127.0.0.1:5273/app/index.html",
    "http://localhost/app/?x=1#hash",
    "https://example.com",
    "tauri://localhost/",
    "http://tauri.localhost/index.html",
    "http://localhost/deep/nested/dir/",
  ];

  it("任意 baseURI 下都应产出可解析的绝对 URL", () => {
    for (const base of bases) {
      const urls = buildPdfResourceUrls(base);
      for (const key of KEYS) {
        const value = urls[key];
        expect(value.endsWith("/")).toBe(true);
        // 绝对 URL 能被独立解析（相对串在这里会抛），且不再是相对前缀。
        const parsed = new URL(value);
        expect(parsed.href).toBe(value);
        // 绝对 URL：带协议与 authority（http: / https: / tauri: 都算）。
        expect(/^[a-z][a-z0-9+.-]*:\/\//.test(value)).toBe(true);
      }
    }
  });

  it("baseURI 末尾是否带 / 不影响结果", () => {
    expect(buildPdfResourceUrls("http://localhost").cMapUrl).toBe("http://localhost/pdfjs/cmaps/");
    expect(buildPdfResourceUrls("http://localhost/").cMapUrl).toBe("http://localhost/pdfjs/cmaps/");
  });

  it("带目录的 baseURI 会解析到同一目录下（<base> / SPA 子路径都要对）", () => {
    const urls = buildPdfResourceUrls("http://127.0.0.1:5273/app/index.html");
    expect(urls.cMapUrl).toBe("http://127.0.0.1:5273/app/pdfjs/cmaps/");
    expect(urls.standardFontDataUrl).toBe("http://127.0.0.1:5273/app/pdfjs/standard_fonts/");
    expect(urls.wasmUrl).toBe("http://127.0.0.1:5273/app/pdfjs/wasm/");
    expect(urls.iccUrl).toBe("http://127.0.0.1:5273/app/pdfjs/iccs/");
  });

  it("query 与 hash 不会混进资源目录", () => {
    const urls = buildPdfResourceUrls("http://localhost/app/?x=1#hash");
    for (const key of KEYS) {
      expect(urls[key].includes("?")).toBe(false);
      expect(urls[key].includes("#")).toBe(false);
    }
  });

  it("Tauri 自定义协议同样要保持绝对", () => {
    expect(buildPdfResourceUrls("tauri://localhost/").wasmUrl).toBe("tauri://localhost/pdfjs/wasm/");
  });

  it("尾斜杠由函数补齐，调用方漏写也能修好", () => {
    expect(toAbsoluteResourceUrl("pdfjs/wasm", "http://localhost/app/")).toBe(
      "http://localhost/app/pdfjs/wasm/",
    );
    expect(toAbsoluteResourceUrl("pdfjs/wasm/", "http://localhost/app/")).toBe(
      "http://localhost/app/pdfjs/wasm/",
    );
  });

  it("空 baseURI 直接报错，而不是悄悄产出相对串", () => {
    expect(() => toAbsoluteResourceUrl("pdfjs/cmaps/", "")).toThrow();
  });

  it("无 DOM 环境退回占位基址，仍是绝对 URL", () => {
    expect(currentDocumentBaseUri()).toBe(FALLBACK_BASE_URI);
    const urls = buildPdfResourceUrls(currentDocumentBaseUri());
    expect(urls.cMapUrl).toBe("http://localhost/pdfjs/cmaps/");
  });
});
