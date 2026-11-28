// PDF Engine 类型契约（docs/05-api-contracts.md §7）。L3/L4 只能 import 这些类型。

export interface PageGeometry {
  widthPt: number;
  heightPt: number;
  rotation: 0 | 90 | 180 | 270;
}

export interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

export interface TextContentHandle {
  items: TextItem[];
  text: string;
  itemStarts: number[];
}

export interface OutlineNode {
  title: string;
  pageNo: number | null;
  children: OutlineNode[];
}

export interface PdfMetadata {
  title: string | null;
  author: string | null;
  subject: string | null;
  keywords: string | null;
  producer: string | null;
  creator: string | null;
  creationDate: string | null;
}

export interface RenderRequest {
  scale: number;
  backgroundColor?: string;
  pixelRatio?: number;
  /// Rectangle in device pixels, relative to the top-left of the rotated viewport.
  clipBox?: { x: number; y: number; w: number; h: number };
}

export interface RenderTaskHandle {
  promise: Promise<HTMLCanvasElement>;
  cancel(): void;
}

export interface PageHandle {
  readonly pageNo: number;
  readonly geometry: PageGeometry;
  getTextContent(): Promise<TextContentHandle>;
  render(req: RenderRequest): RenderTaskHandle;
}

export interface DocumentHandle {
  readonly docId: number;
  readonly pageCount: number;
  getPage(pageNo: number): Promise<PageHandle>;
  getOutline(): Promise<OutlineNode[]>;
  getMetadata(): Promise<PdfMetadata>;
  dispose(): Promise<void>;
}

export interface PdfEngine {
  openDocument(src: { url: string; docId: number }): Promise<DocumentHandle>;
}
