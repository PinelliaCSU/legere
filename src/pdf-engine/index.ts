// L3/L4 唯一允许的 import 入口：只导出契约类型与引擎工厂。
// 任何 pdfjs-dist 的具体类型都不得从本文件泄漏出去（docs/02 §2）。

export { pdfEngine, PdfEngineError } from "./engine";
export { buildTextContent, getItemRanges, itemsInRange, toTextItem } from "./text-content";
export type {
  DocumentHandle,
  OutlineNode,
  PageGeometry,
  PageHandle,
  PdfEngine,
  PdfMetadata,
  RenderRequest,
  RenderTaskHandle,
  TextContentHandle,
  TextItem,
} from "./types";
