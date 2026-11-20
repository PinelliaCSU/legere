// DTO 与 docs/05-api-contracts.md §2 逐字对应（字段名 camelCase，可选字段用 null 而非 undefined）。
// 本文件由 M02 维护；改字段名会同时破坏 Rust 侧 dto.rs，scripts/check-contracts.mjs 会拦截。

export type MetaState = "pending" | "ok" | "failed";
export type TextState = "pending" | "indexing" | "indexed" | "no_text" | "failed";
export type ReadMode = "continuous" | "single";
export type SearchMode = "phrase" | "terms";

export interface PageDto<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface PingDto {
  ok: true;
  version: string;
}

export interface AppInfoDto {
  version: string;
  dataDir: string;
  dbPath: string;
  ftsEnabled: boolean;
  contentlessDelete: boolean;
  textEngine: string;
}

export interface LibraryRootDto {
  id: number;
  path: string;
  displayName: string;
  enabled: boolean;
  createdAt: string;
  lastScannedAt: string | null;
}

export interface DocumentDto {
  id: number;
  libraryRootId: number;
  fileName: string;
  relPath: string;
  sizeBytes: number;
  mtimeMs: number;
  pageCount: number | null;
  pdfTitle: string | null;
  pdfAuthor: string | null;
  metaState: MetaState;
  textState: TextState;
  lastOpenedAt: string | null;
  hasProgress: boolean;
  progressPage: number | null;
}

export interface DocumentDetailDto extends DocumentDto {
  absPath: string;
  pdfSubject: string | null;
  pdfKeywords: string | null;
  pdfProducer: string | null;
  pdfCreator: string | null;
  pdfCreationDate: string | null;
  indexErrorCode: string | null;
  indexErrorMsg: string | null;
  bookmarks: BookmarkDto[];
  progress: ProgressDto | null;
}

export interface DocumentQuery {
  text?: string;
  rootIds?: number[];
  textStates?: TextState[];
  sort: "name" | "recent" | "added" | "size";
  order: "asc" | "desc";
  offset: number;
  limit: number;
}

export interface DocumentSourceDto {
  url: string;
  pageCount: number | null;
  fileName: string;
}

export interface ProgressDto {
  documentId: number;
  pageNo: number;
  scrollRatio: number;
  zoom: number;
  mode: ReadMode;
  updatedAt: string;
}

export interface BookmarkDto {
  id: number;
  documentId: number;
  pageNo: number;
  title: string;
  note: string | null;
  color: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IndexStatusDto {
  paused: boolean;
  workers: number;
  queued: number;
  running: number;
  documentsIndexed: number;
  documentsPending: number;
  documentsFailed: number;
  documentsNoText: number;
  current: { documentId: number; pageNo: number; totalPages: number } | null;
}

export interface GlobalSearchParams {
  query: string;
  mode: SearchMode;
  rootIds?: number[];
  hitsPerDocument: number;
  documentOffset: number;
  documentLimit: number;
}

export interface GlobalSearchHitDto {
  pageNo: number;
  snippet: string;
  ranges: [number, number][];
}

export interface GlobalSearchResultDto {
  document: DocumentDto;
  hitCount: number;
  hits: GlobalSearchHitDto[];
}

export interface GlobalSearchPageDto {
  items: GlobalSearchResultDto[];
  totalDocuments: number;
  offset: number;
  limit: number;
  tookMs: number;
}

export type SettingsMapDto = Record<string, string>;

export interface SearchCountDto {
  documents: number;
  pages: number;
}

export interface IntegrityReportDto {
  ftsRows: number;
  pageTextRows: number;
  orphanPages: number;
  mislabeledDocuments: number[];
}

export interface ScanStartedDto {
  started: boolean;
  reason?: string;
}

/// 同步扫描（library_scan_now）的计数结果，字段与 Rust 的 ScanOutcomeDto 一一对应。
export interface ScanOutcomeDto {
  scanned: number;
  added: number;
  updated: number;
  revived: number;
  removed: number;
}
