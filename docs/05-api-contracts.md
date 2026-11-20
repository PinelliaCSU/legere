# 05 · API 契约

> 冻结契约。依据 master_plan §5.5、§7.2。**所有模块必须严格按本文档实现命名、参数、返回值与错误码**；M02 负责把这些定义落成可编译的 Rust 结构与 TS 类型。

## 1. 错误模型

Rust：

```rust
#[derive(Debug, Clone, Serialize)]
pub struct ApiError {
    pub code: ApiErrorCode,      // 稳定枚举，前端按此分支
    pub message: String,         // 面向用户的中文短句（可由前端覆盖文案）
    pub detail: Option<String>,  // 技术细节，仅日志/调试展示
    pub retriable: bool,         // 是否值得重试（决定 UI 是否给「重试」按钮）
}

#[derive(Debug, Clone, Copy, Serialize)]
pub enum ApiErrorCode {
    E_INVALID_ARG, E_NOT_FOUND, E_DB, E_IO, E_PERMISSION,
    E_PDF_CORRUPT, E_PDF_ENCRYPTED, E_PDF_NO_TEXT,
    E_BUSY, E_UNSUPPORTED, E_CANCELED, E_INTERNAL,
}
```

TypeScript：

```ts
export type ApiErrorCode =
  | "E_INVALID_ARG" | "E_NOT_FOUND" | "E_DB" | "E_IO" | "E_PERMISSION"
  | "E_PDF_CORRUPT" | "E_PDF_ENCRYPTED" | "E_PDF_NO_TEXT"
  | "E_BUSY" | "E_UNSUPPORTED" | "E_CANCELED" | "E_INTERNAL";

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  detail?: string;
  retriable: boolean;
}
```

错误码语义表：

| code | 何时使用 | retriable |
|---|---|---|
| `E_INVALID_ARG` | 参数缺失/越界/类型不符 | false |
| `E_NOT_FOUND` | 文档 id / 库根 id 不存在，或文件已消失 | false |
| `E_DB` | SQLite 执行失败、迁移失败 | false |
| `E_IO` | 文件读写失败（非权限原因） | true |
| `E_PERMISSION` | 目录/文件访问被拒绝 | false |
| `E_PDF_CORRUPT` | PDF 结构损坏、无法解析 | false |
| `E_PDF_ENCRYPTED` | 需要密码 | false |
| `E_PDF_NO_TEXT` | 可打开但无可提取文本（扫描件） | false |
| `E_BUSY` | 同类任务已在进行（如已在扫描） | true |
| `E_UNSUPPORTED` | 当前 SQLite/平台能力不支持（如无 FTS5） | false |
| `E_CANCELED` | 调用方主动取消 | false |
| `E_INTERNAL` | 兜底，不应出现 | true |

规则：内部用 `thiserror` 定义领域错误，Command 层统一转换；**禁止**把 `anyhow`/`Box<dyn Error>` 的字符串直接暴露。

## 2. 通用 DTO

```ts
export interface PageDto<T> { items: T[]; total: number; offset: number; limit: number }
export type MetaState = "pending" | "ok" | "failed";
export type TextState = "pending" | "indexing" | "indexed" | "no_text" | "failed";
export type ReadMode  = "continuous" | "single";

export interface LibraryRootDto {
  id: number; path: string; displayName: string;
  enabled: boolean; createdAt: string; lastScannedAt: string | null;
}

export interface DocumentDto {
  id: number; libraryRootId: number;
  fileName: string; relPath: string;
  sizeBytes: number; mtimeMs: number;
  pageCount: number | null;
  pdfTitle: string | null; pdfAuthor: string | null;
  metaState: MetaState; textState: TextState;
  lastOpenedAt: string | null;
  hasProgress: boolean;                 // 便宜的一列，列表/筛选用
  progressPage: number | null;          // R20：LEFT JOIN reading_progress.page_no，供主页转盘/列表直接显示「读到第几页」
}

export interface DocumentDetailDto extends DocumentDto {
  absPath: string;
  pdfSubject: string | null; pdfKeywords: string | null;
  pdfProducer: string | null; pdfCreator: string | null; pdfCreationDate: string | null;
  indexErrorCode: ApiErrorCode | null; indexErrorMsg: string | null;
  bookmarks: BookmarkDto[];
  progress: ProgressDto | null;
}

export interface DocumentQuery {
  text?: string;                 // 文件名/标题模糊匹配
  rootIds?: number[];
  textStates?: TextState[];
  sort: "name" | "recent" | "added" | "size";
  order: "asc" | "desc";
  offset: number; limit: number; // limit 上限 200
}

export interface DocumentSourceDto { url: string; pageCount: number | null; fileName: string }

export interface ProgressDto {
  documentId: number; pageNo: number;
  scrollRatio: number; zoom: number; mode: ReadMode; updatedAt: string;
}

export interface BookmarkDto {
  id: number; documentId: number; pageNo: number;
  title: string; note: string | null; color: string | null;
  createdAt: string; updatedAt: string;
}

export interface IndexStatusDto {
  paused: boolean; workers: number;
  queued: number; running: number;
  documentsIndexed: number; documentsPending: number;
  documentsFailed: number; documentsNoText: number;
  current: { documentId: number; pageNo: number; totalPages: number } | null;
}

export type SearchMode = "phrase" | "terms";
export interface GlobalSearchParams {
  query: string;
  mode: SearchMode;
  rootIds?: number[];
  hitsPerDocument: number;   // 上限 5，默认 3
  documentOffset: number; documentLimit: number; // 上限 50
}

export interface GlobalSearchHitDto {
  pageNo: number;
  snippet: string;              // 原始文本上下文（含省略号）
  ranges: [number, number][];   // snippet 内的命中区间（字符索引，左闭右开）
}

export interface GlobalSearchResultDto {
  document: DocumentDto;
  hitCount: number;   // = 命中**页数**（不是命中次数）；与 hits.length 的关系：hitCount 可为全量页数，hits 最多 hitsPerDocument 条
}

export interface GlobalSearchPageDto {
  items: GlobalSearchResultDto[]; totalDocuments: number;
  offset: number; limit: number; tookMs: number;
}

export interface AppInfoDto {
  version: string; dataDir: string; dbPath: string;
  ftsEnabled: boolean; contentlessDelete: boolean;
  textEngine: string;              // 实际生效的文本提取实现名，如 "pdfium" | "pdf-extract"
}

export type SettingsMapDto = Record<string, string>; // value 为 JSON 字符串
```

Rust 侧与上表一一对应的结构（`serde`）：

- 命名：`#[serde(rename_all = "camelCase")]`，与 TS 字段名**完全一致**。
- 可选字段：`Option<T>` ↔ `T | null`（不是 `undefined`）。
- 枚举以字符串序列化（`#[serde(rename_all = "snake_case")]` 仅用于 `TextState`/`MetaState`/`ReadMode`/`SearchMode`，其余按定义）。

DTO ↔ 表映射（不暴露给前端，仅内部参考）：

| DTO | 来源 |
|---|---|
| `DocumentDto` | `documents` 子集 + `EXISTS(reading_progress)` → `hasProgress` |
| `DocumentDetailDto` | `documents` 全列 + `bookmarks` + `reading_progress` |
| `IndexStatusDto` | 内存调度器快照 + `documents` 聚合计数 |
| `GlobalSearchResultDto` | `page_fts` 命中 → `page_text.raw_text` 取上下文 → `documents` 取展示字段 |

## 3. Command 注册表

命名规范：`snake_case`，`<域>_<动作>`。全部为**异步** Command（`async fn`），单次调用延迟目标 < 50ms（除扫描/重建这类立即返回的启动型命令）。

| # | Command | 入参 | 返回 | 错误码 | 归属 |
|---|---|---|---|---|---|
| 1 | `ping` | — | `{ ok: true, version: string }` | `E_INTERNAL` | M01 |
| 2 | `app_info` | — | `AppInfoDto { version, dataDir, dbPath, ftsEnabled, contentlessDelete, textEngine }` | `E_INTERNAL` | M01/M03/M09 |
| 3 | `library_root_list` | — | `LibraryRootDto[]` | `E_DB` | M04 |
| 4 | `library_root_add` | `{ path: string }` | `LibraryRootDto` | `E_INVALID_ARG`, `E_IO`, `E_PERMISSION`, `E_DB` | M04 |
| 5 | `library_root_remove` | `{ id: number, purge: boolean }` | `void` | `E_NOT_FOUND`, `E_DB` | M04 |
| 6 | `library_scan_start` | `{ rootId?: number }` | `{ started: boolean, reason?: string }` | `E_BUSY` | M04 |
| 7 | `document_list` | `{ query: DocumentQuery }` | `PageDto<DocumentDto>` | `E_INVALID_ARG`, `E_DB` | M04 |
| 8 | `document_get` | `{ id: number }` | `DocumentDetailDto` | `E_NOT_FOUND` | M04 |
| 9 | `document_url` | `{ id: number }` | `DocumentSourceDto` | `E_NOT_FOUND`, `E_IO` | M04 |
| 10 | `document_recent` | `{ limit: number }` | `DocumentDto[]` | `E_DB` | M04 |
| 11 | `document_touch_opened` | `{ id: number }` | `void` | `E_NOT_FOUND` | M04 |
| 12 | `document_record_delete` | `{ id: number }` | `void` | `E_NOT_FOUND`, `E_DB` | M04 |
| 29 | `library_root_update` | `{ id: number, displayName: string }` | `LibraryRootDto` | `E_NOT_FOUND`, `E_INVALID_ARG`, `E_DB` | M04 |
| 30 | `library_root_replace` | `{ id: number, path: string }` | `LibraryRootDto` | `E_NOT_FOUND`, `E_INVALID_ARG`, `E_IO`, `E_DB` | M04 |
| 31 | `library_scan_now` | `{ rootId?: number }` | `ScanOutcomeDto { scanned, added, updated, revived, removed }` | `E_DB` | M04 |
| 32 | `library_pick_folder` | — | `string \| null`（null = 用户取消） | `E_UNSUPPORTED`, `E_INTERNAL` | M04 |

> #29 / #30 为后加的两条（R22 / R23），#31 / #32 为 R24 新增，一律追加在表尾而不改动既有 1–28 的编号。
| 13 | `index_enqueue` | `{ documentId: number, priority?: number }` | `{ jobId: number }` | `E_NOT_FOUND` | M10 |
| 14 | `index_cancel` | `{ jobId: number }` | `void` | `E_NOT_FOUND` | M10 |
| 15 | `index_status` | — | `IndexStatusDto` | `E_DB` | M10 |
| 16 | `index_pause` | `{ paused: boolean }` | `void` | — | M10 |
| 17 | `index_rebuild_all` | `{ rootId?: number }` | `{ started: boolean }` | `E_BUSY`, `E_DB` | M10 |
| 18 | `search_global` | `{ params: GlobalSearchParams }` | `GlobalSearchPageDto` | `E_INVALID_ARG`, `E_UNSUPPORTED`, `E_DB` | M11 |
| 19 | `search_global_count` | `{ params: GlobalSearchParams }` | `{ documents: number, pages: number }` | `E_INVALID_ARG` | M11 |
| 20 | `bookmark_list` | `{ documentId: number }` | `BookmarkDto[]` | `E_DB` | M12 |
| 21 | `bookmark_create` | `{ documentId, pageNo, title, note?, color? }` | `BookmarkDto` | `E_INVALID_ARG`, `E_DB` | M12 |
| 22 | `bookmark_update` | `{ id, title?, note?, color? }` | `BookmarkDto` | `E_NOT_FOUND`, `E_INVALID_ARG` | M12 |
| 23 | `bookmark_delete` | `{ id: number }` | `void` | `E_NOT_FOUND` | M12 |
| 24 | `progress_get` | `{ documentId: number }` | `ProgressDto \| null` | `E_DB` | M12 |
| 25 | `progress_save` | `{ progress: ProgressDto }` | `void` | `E_INVALID_ARG`, `E_DB` | M12 |
| 26 | `settings_get_all` | — | `SettingsMapDto` | `E_DB` | M13 |
| 27 | `settings_set` | `{ key: string, value: string }` | `void` | `E_INVALID_ARG`, `E_DB` | M13 |
| 28 | `db_integrity_check` | — | `{ ftsRows, pageTextRows, orphanPages, mislabeledDocuments: number[] }` | `E_DB` | M03 |

约束：

1. 入参一律为**单对象**（`{...}`），便于演进而非破坏调用方。
2. 需要「立即返回、后台继续」的操作（扫描、重建）返回 `started`，进度走事件。
3. 列表类必须分页，`limit` 有服务端上限（`document_list` 200 / `search_global` 50）。
4. 不允许在 Command 里解析 PDF 或做超过 50ms 的 CPU 工作（扫描/索引一律走任务系统）。
5. `library_root_remove { id, purge }` 的 `purge` 语义（R16 冻结）：`false` = 删除库根并级联清理 `documents`/`page_text`/FTS/书签/进度/任务；`true` = 在 `false` 基础上额外 `VACUUM` 以回收磁盘。**两种取值都不删除、不移动用户磁盘上的任何 PDF 文件**。
6. `bookmark_list` 对不存在的 `documentId` 返回**空数组**（不报错）；`progress_save` 对不存在的 `documentId` 返回 `E_NOT_FOUND`（先做存在性检查，不要让它变成外键错误 `E_DB`）。见 R19。
7. `db_reset` 为 debug-only 内部命令（R13）：`#[cfg(debug_assertions)]`，**不进** `CMD` 注册表与 `COMMAND_NAMES` 比对集合。

## 4. 事件注册表

命名规范：`<域>://<事件>`。前端 `listen` 后用 `EVT` 常量引用，禁止硬编码字符串。

| 事件 | payload | 发送方 | 节流 |
|---|---|---|---|
| `app://ready` | `{ version: string }` | M01 | 一次 |
| `library://scan-progress` | `{ rootId: number \| null, phase: "walking" \| "finalizing" \| "done", scanned: number, added: number, updated: number, removed: number, error: ApiError \| null }` | M04 | 200ms |
| `library://changed` | `{ kinds: ("added" \| "updated" \| "removed")[], documentIds: number[], rootId: number \| null }` | M04 | 300ms（聚合） |
| `index://progress` | `IndexStatusDto` | M10 | 250ms（≤4 次/秒） |
| `index://job-finished` | `{ jobId: number, documentId: number, state: "done" \| "failed" \| "canceled", error: ApiError \| null }` | M10 | 每任务一次 |

规则：

1. 事件 payload 必须是 DTO，不得发送裸字符串。
2. 事件是**通知**而非**状态源**：前端收到事件后应重新拉取必要数据（或按 payload 做增量更新），不得仅靠事件推算全量状态。
3. 前端卸载时取消所有 `listen` 句柄；重复订阅必须在 `ipc.ts` 层去重。

## 5. IPC 客户端（M02 交付）

```ts
// src/core/ipc.ts
export async function call<K extends keyof CommandMap>(
  name: K, args: CommandMap[K]["args"], opts?: { timeoutMs?: number }
): Promise<CommandMap[K]["result"]>;

export async function subscribe<E extends keyof EventMap>(
  event: E, handler: (payload: EventMap[E]) => void
): Promise<() => void>;
```

要求：`call` 捕获 Tauri 抛出的错误对象并归一化为 `ApiError`；未知错误一律 `E_INTERNAL` 且保留原始字符串到 `detail`；`timeoutMs` 默认 15000（`search_global` 建议 20000）。

## 6. `pdf://` 协议契约

- URL（**R21 修订**）：前端必须使用**平台映射形态**，不要直连 scheme。
  - Windows：http://pdf.localhost/doc/{documentId}?v={mtime_ms}
  - macOS / Linux：按 Tauri 在该平台的实际映射调整（通常为 pdf://localhost/doc/{id}）
  - 后端 handler 同时接受 pdf://doc/{id}、pdf://localhost/doc/{id}、http://pdf.localhost/doc/{id} 三种形态并解析出同一 id；**document_url 命令必须返回当前平台可用的形态**。
  - 实测依据（2026-11-18，release + 生产目录 + 真实页面）：前端用 pdf://doc/1 直接 fetch 得到 TypeError: Failed to fetch；用 http://pdf.localhost/doc/1 得到 200 / 带 Range 得到 206 + bytes 0-9/599。
- **CORS（R21 新增，必需）**：页面源是 tauri://localhost，协议源不同，属跨源请求。响应必须带
  Access-Control-Allow-Origin、Access-Control-Allow-Methods: GET, HEAD, OPTIONS、
  Access-Control-Allow-Headers: range, if-range, accept, content-type、
  Access-Control-Expose-Headers: content-range, accept-ranges, content-length, content-type；
  并必须应答 OPTIONS 预检（Range 不在 CORS 安全列表内，会触发预检）。缺任一项，前端都是 Failed to fetch（请求能到后端，但 JS 读不到响应）。
- 支持方法：`GET`、`HEAD`；必须处理 `Range: bytes=start-[end]`，返回 `206 Partial Content` + `Content-Range`；不支持 Range 时返回 `200` + 完整流（PDF.js 可退化为一次性加载）。
- 响应头：`Content-Type: application/pdf`、`Accept-Ranges: bytes`、`Content-Length`。
- 错误：文档不存在 → `404`；无权限 → `403`；路径逃逸（`..`）→ `400`（必须校验 id 而非拼接路径）；Range 越界或格式非法 → `416` + `Content-Range: bytes */{size}`。
- `?v={mtime_ms}` 只作缓存击穿用，**不参与校验**（不匹配也不报错，仍按 document_id 提供当前内容）。
- Range 判定顺序（终裁，R15）：语法非法 → `400`；`start >= size` → `416` + `Content-Range: bytes */{size}`；`end >= size` → 夹取到 `size-1` 并返回 `206`（标准语义，不是错误）；跨度 > `RANGE_MAX_BYTES = 8 MiB` → 截断 `end` 并返回 `206`。
- 为什么 `start` 越界必须是 `416` 而不是夹取：夹取会让 PDF.js 拿着错位的字节当成目标区间解析，比明确失败更难诊断；`end` 越界夹取则是服务端标准行为。
- 安全：只允许通过 `document_id` 查库获取真实路径，**永不**接受路径参数。

## 7. PDF Engine 与 Render Scheduler 接口（L2/L3 内部契约）

```ts
// 类型归属（R18）：下面这个代码块是**类型契约**，落地文件按模块拆分，禁止两个模块各定义一份同义类型。
//   src/pdf-engine/types.ts  → PdfEngine / DocumentHandle / PageHandle / PageGeometry / RenderRequest /
//                              RenderTaskHandle / TextContentHandle / TextItem / OutlineNode / PdfMetadata
//   src/render/types.ts      → PageState / PageRenderState / ViewportState / RenderBudget / RenderScheduler
// M05 与 M06 各自只写自己那份；跨模块一律 import，缺类型时报告契约缺口，不得自建。
export interface PdfEngine {
  openDocument(src: { url: string; docId: number }): Promise<DocumentHandle>;
}

export interface DocumentHandle {
  readonly docId: number;
  readonly pageCount: number;
  getPage(pageNo: number): Promise<PageHandle>;      // pageNo 1-based，内部缓存 PageProxy
  getOutline(): Promise<OutlineNode[]>;              // 失败返回 []
  getMetadata(): Promise<PdfMetadata>;               // 字段缺失返回 null
  dispose(): Promise<void>;                          // 幂等
}

export interface PageHandle {
  readonly pageNo: number;
  readonly geometry: PageGeometry;                   // 以 PDF point 为单位
  getTextContent(): Promise<TextContentHandle>;      // 惰性，LRU 缓存
  render(req: RenderRequest): RenderTaskHandle;      // 必须可取消
}

export interface PageGeometry { widthPt: number; heightPt: number; rotation: 0 | 90 | 180 | 270 }

export interface RenderRequest {
  scale: number;                // 与 devicePixelRatio 相乘在 engine 内部完成
  backgroundColor?: string;
  clipBox?: { x: number; y: number; w: number; h: number };
}

export interface RenderTaskHandle {
  readonly promise: Promise<HTMLCanvasElement>;
  cancel(): void;
}

export interface TextContentHandle {
  items: TextItem[];
  text: string;                 // items[i].str 依阅读顺序拼接；item 之间**不插入分隔符**，行间插入 '\n'
  itemStarts: number[];         // 与 items 等长；text.slice(itemStarts[i], itemStarts[i]+items[i].str.length) === items[i].str
}

// 单位：scale = 1 的页面 CSS 像素（等价于 PDF point）。使用方自行乘当前 scale；
// 因此文本缓存可跨缩放复用，不得在缓存里存已乘 scale 的坐标。
export interface TextItem { str: string; x: number; y: number; width: number; height: number; fontSize: number }

export interface OutlineNode { title: string; pageNo: number | null; children: OutlineNode[] }
export interface PdfMetadata { title: string | null; author: string | null; subject: string | null;
  keywords: string | null; producer: string | null; creator: string | null; creationDate: string | null }

export type PageState = "idle" | "queued" | "rendering" | "ready" | "error";
export interface PageRenderState {
  pageNo: number; state: PageState;
  canvas: HTMLCanvasElement | null;
  textContent: TextContentHandle | null;
  // canvas 位图实际渲染所用的 scale；**允许**与当前 ViewportState.scale 不同，
  // 此时视为 LOD 预览（旧 scale 位图先顶上，清晰图随后替换）。消费方不得据此判定"渲染失败"。
  scale: number | null;
  error: ApiError | null;
}

export interface ViewportState {
  mode: ReadMode; scale: number;
  scrollTop: number; viewportHeight: number; viewportWidth: number;
  pageGeometries: PageGeometry[];   // index 0 = page 1
}

// 默认值（契约值，可被 setBudget 覆盖）：maxConcurrent 2、cacheBytes 268435456(256 MiB)、prefetchPages 2
export interface RenderBudget { maxConcurrent: number; cacheBytes: number; prefetchPages: number }

export interface RenderScheduler {
  // 语义：调用即以新文档替换旧文档 —— 必须先取消旧文档全部任务、清空两级缓存、
  // 并对旧 DocumentHandle 调用 dispose()（或按调用方约定交回所有权）。传 null 表示纯释放。
  setDocument(handle: DocumentHandle | null): void;
  setViewport(v: ViewportState): void;
  setBudget(b: Partial<RenderBudget>): void;
  getPageState(pageNo: number): PageRenderState | undefined;
  retry(pageNo: number): void;      // 单页失败后的显式重试（失败页默认不再自动入队）
  subscribe(cb: (states: ReadonlyMap<number, PageRenderState>) => void): () => void;
  // v0.13 增补（R25）：文本提取的唯一入口。渲染、文本层与文内搜索共用同一份
  // 字节预算 LRU 与在途去重；调用方不得再自己 getPage + getTextContent。
  getTextContent(pageNo: number): Promise<TextContentHandle>;
  // v0.13 增补（R25）：批量预热文本（搜索扫描、空闲预取），并发夹取到 [1,4]，
  // 单页失败不抛出（错误留给该页渲染或搜索自己上报）。
  prefetchText(pageNos: number[], opts?: { concurrency?: number; shouldContinue?: () => boolean }): Promise<void>;
  dispose(): void;                  // 幂等：取消任务、释放 canvas、清空缓存
}
```

Reader 交互层公开的 hook：

```ts
export interface ReaderApi {
  mode: ReadMode; scale: number; currentPage: number; pageCount: number;
  setMode(m: ReadMode): void;
  setScale(s: number, anchor?: { pageNo: number; ratioX: number; ratioY: number }): void;
  goToPage(pageNo: number, opts?: { highlightRanges?: [number, number][] }): void;
  getSelectionText(): string;
}
```

## 8. 分页、体积与性能约定

| 约定 | 值 |
|---|---|
| 列表默认页大小 | 50（上限 200） |
| 搜索结果默认每文档命中页 | 3（上限 5） |
| 搜索一次返回的文档数上限 | 50 |
| 单次 IPC payload 上限（设计目标） | < 1MB；超出即改为分页或流式 |
| 禁止经 IPC 传输 | PDF 字节、canvas 图像、完整页面文本（除单页上下文片段） |

## 9. 命名与文件规范（全项目）

| 对象 | 规范 |
|---|---|
| Tauri Command | `snake_case`（前端调用同名） |
| 事件 | `域://事件` |
| Rust 模块/文件 | `snake_case.rs`，一个文件一个关注点，单文件 > 600 行需拆分 |
| Rust 类型 | `PascalCase`；DTO 以 `Dto` 结尾；内部行类型以 `Row` 结尾 |
| TS 文件 | 组件 `PascalCase.tsx`，逻辑 `kebab-case.ts` |
| TS 类型 | `PascalCase`，与 Rust DTO 同名 |
| React hook | `useXxx` |
| 常量对象 | `CMD`、`EVT`（`as const`） |
| 测试文件 | `*.test.ts` / `#[cfg(test)]` 或 `tests/*.rs` |

## 10. 契约一致性检查（M02 必须提供）

1. `scripts/check-contracts.mjs`：读取 `src/contracts/*.ts` 与 `src-tauri/src/contracts/*.rs` 中 DTO 字段名，输出差集；非空即失败。
2. Command 注册表覆盖测试：`CMD` 常量集合 == Rust 侧 `#[tauri::command]` 注册集合（用生成的清单文件比对）。
3. 错误码完整性测试：Rust 枚举每个变体在 TS 中都有对应值。

## 11. Repository Trait 清单（权威）

数据库访问**只允许**经由下列 8 个 trait；业务模块（M04/M09/M10/M11/M12/M13）不得写裸 SQL。完整方法签名由 M03 在 `module-prompts/03-database.md §8` 中给出，**自本节起视为冻结契约**（改签名 = 架构变更）。

| trait | 负责表 | 关键职责（方法名以 03-database §8 为准） |
|---|---|---|
| `LibraryRootRepo` | `library_roots` | list / get / add / remove(purge) / set_enabled / set_last_scanned_at |
| `DocumentRepo` | `documents` | list(分页) / get_detail / recent / touch_opened / facts_by_root / find_by_abs_path / find_by_rel_path / insert_found / update_facts / revive / move_to_root / merge_into / soft_delete / set_states / set_page_count_and_meta / reset_indexing_to_pending |
| `PageTextRepo` | `page_text` | page_ids / raw_text / count_for_document / count_all（**只读**：写入统一走 `FtsRepo`） |
| `FtsRepo` | `page_fts` + `page_text` 复合 | insert_page_with_fts（返回 `page_text.id`，保证与 rowid 相等）/ delete_document_index（先 FTS 后 page_text）/ clear_all / count |
| `JobRepo` | `indexing_jobs` | enqueue / get / mark_running / mark_finished / bump_attempts / cancel / requeue_running / counts |
| `BookmarkRepo` | `bookmarks` | list / get / create / update / delete |
| `ProgressRepo` | `reading_progress` | get / upsert / clamp_page / had_progress |
| `SettingsRepo` | `app_settings` | get_all / get / set / delete |

硬约束：

1. 全部方法返回 `Result<_, ApiError>`；读方法收 `&Connection`，写方法收 `&Transaction<'_>`。
2. **trait 实现自己不开事务**——事务边界归调用方（保证「删 FTS + 删 page_text + 删 documents」在同一事务）。
3. 行类型（`DocFact` / `NewDocument` / `JobRow` / `JobCounts` / `IntegrityReport`）仅内部使用，不出现在 DTO 里。

## 12. 内部缝合接口（已批准，非契约级）

模块间少量必要的窄接口，实现放在**提供方**目录内，消费方只依赖 trait，不改契约：

| 接口 | 提供方 | 消费方 | 用途 |
|---|---|---|---|
| `IndexJobSink` | M10（`jobs/`） | M04 | 扫描/监控发现变更后投递 `meta`/`text` 任务，避免 M04 直接依赖 M10 内部结构 |
| `DocumentPathResolver` | M01（`protocol/`） | M04 | `pdf://` 协议需要把 `document_id` 解析成真实路径，避免协议层直接依赖 Repository |
| `ProgressPort` | M12（实现） / M14（装配注入） | M07 | M07 只做「节流 1s + flush」并调用注入的端口，**禁止直接 `invoke("progress_save")`**；这样阅读器可单测且不依赖 IPC |
| `getItemRanges(items)` | M05 | M08 | `itemStarts`（契约字段）的便捷封装；两者不一致时以 `itemStarts` 为准。**不是契约字段**，可省 |

约束：这两个接口不属于 `CMD`/`EVT` 注册表，不暴露给前端；若它们需要扩展，仍走「接口需求 → Lead 批准」流程。

## 13. 修订记录（Lead 裁决）

以下修订由 Lead 在模块文档编写期间裁决，均为**向后兼容的澄清或字段新增**，未删除任何既有字段。实现方以本表为最新口径。

| 修订 | 内容 | 原缺口 | 影响 |
|---|---|---|---|
| R1 | `TextContentHandle` 新增 `itemStarts: number[]`；`text` 的拼接规则冻结为「item 之间不插分隔符，行间插 `'\n'`」 | 06 §11.4-1 | M05 产出该字段，M08 依它把字符区间映射回 TextItem，保证高亮可逆 |
| R2 | `TextItem` 坐标单位冻结为 **scale=1 的页面 CSS 像素（= PDF point）**，使用方自行乘 scale | 06 §11.4-2 | M05 缓存跨缩放复用；M08 显示时乘 scale |
| R3 | `RenderBudget` 默认值冻结：`maxConcurrent = 2`、`cacheBytes = 268435456`(256 MiB)、`prefetchPages = 2` | 08 §12-1 | M06 以此为初始预算，M07 不得私传不同值 |
| R4 | `setDocument(handle)` 语义冻结：换文档即「取消旧任务 → 清两级缓存 → 释放旧 DocumentHandle」；传 `null` 表示纯释放。**不新增方法** | 08 §12-2 | M06 依此实现销毁顺序；不构成架构变更 |
| R5 | `PageRenderState.scale` 允许不等于 `ViewportState.scale`，此时为 LOD 预览；消费方不得据此判定渲染失败 | 08 §12-3 | M06 产出、M07 消费 |
| R6 | 修正 02 §5 时序图中的笔误 `document_open_url` → `document_url`（以 §3 第 9 行为准） | 10 §0-6 | 无（仅文档一致性） |
| R7 | 新增 §11 Repository Trait 清单（8 个 trait），并修正 03 §2 M03 的错误指针（原文让读者去 05 §3 找 trait，实为 Command 表） | 03 §2 / M03 §8 | M03 直接依此实现；M04/M09/M11/M12/M13 只能依赖这些 trait |
| R8 | `AppInfoDto` 定名并冻结，新增 `textEngine` 字段（原 `app_info` 只给字段没给类型，且无法暴露实际文本提取引擎） | 05 §3 #2 / M09 §8 | M01 产出、M09 填充、M14 展示诊断信息 |
| R9 | `GlobalSearchResultDto.hitCount` 语义冻结为**命中页数**（非命中次数） | 05 §2 / M11 §9 | M11 产出、M14 消费 |
| R10 | `pdf://` 补充：Range 越界/非法 → `416` + `Content-Range: bytes */{size}`；`?v=` 不参与校验；单次跨度上限 32 MiB | 05 §6 / M01 | M01 实现、M05 依赖 |
| R11 | 修正 03 §2 M10 的 `index_pause/resume` → 仅 `index_pause { paused }`（恢复 = `paused:false`）；修正 03 §2 M04 的 `document_delete_record` → `document_record_delete` | M10 §8 / M04 §8 | 无（对齐 05 §3） |
| R12 | 明确"只为实际存在的文件排任务"：`C3`（文件消失/软删除）只清理索引，不排 `meta`/`text` 任务 | 02 §8 / M04 §8 | M04 依此实现，M10 队列不被幽灵文档占满 |
| R13 | `db_reset` 定为 **debug-only 内部命令**：`#[cfg(debug_assertions)]`，**不进入** `CMD` 注册表与 `COMMAND_NAMES` 比对集合 | 04 §5 / M02 §8 | 避免契约一致性检查误判 |
| R14 | 批准两个内部缝合接口 `IndexJobSink`（M10 提供/M04 消费）与 `DocumentPathResolver`（M01 提供/M04 消费），见 §12 | M04 §8 / M01 §8 | 不暴露前端，非契约级 |
| R15 | `pdf://` Range 判定顺序终裁：语法非法→`400`；`start >= size`→`416` + `Content-Range: bytes */{size}`；`end >= size`→夹取 `size-1` 返 `206`；跨度上限 `RANGE_MAX_BYTES = 8 MiB`→截断返 `206` | 09 §3.2（原文主张"不使用 416"，已改） | M01 实现；PDF.js 侧按标准 416 处理 |
| R16 | `library_root_remove.purge` 语义冻结：`false`=级联清记录，`true`=额外 `VACUUM`；**两种取值都不删用户磁盘文件**。并冻结 `db_reset` 为 debug-only、不进 `CMD` | 09 §6 / M04 §8 | M04 依此实现，M02 不把 `db_reset` 纳入比对集合 |
| R17 | 路径唯一性改由 `*_key` 列承担：`documents` 增加 `abs_path_key`(UNIQUE) / `rel_path_key`，`UNIQUE(library_root_id, rel_path_key)`；`abs_path`/`rel_path` 仅用于展示与打开文件。Repository 的 `find_by_abs_path`/`find_by_rel_path` 更名为 `..._key` | 09 §8（Windows 大小写不敏感击穿 UNIQUE） | M03 迁移与 trait、M04 查重/JOIN 全部走 key 列 |
| R19 | `bookmark_list` 未知 documentId 返回空数组；`progress_save` 未知 documentId 返回 `E_NOT_FOUND`（不做成外键 `E_DB`） | M12 §8 / 12 §4 | M12 依此实现，M14 不必为「文档已删」单独兜错 |
| R21 | pdf:// 契约修订：① 前端必须用平台映射形态（Windows：http://pdf.localhost/doc/{id}）；② 响应必须带完整 CORS 头并应答 OPTIONS 预检；③ document_url 返回当前平台可用形态 | 08 §6 / M01 实测 | M01 协议实现、M04 的 document_url、M05 的 PDF.js 加载 |
| R20 | `DocumentDto` 新增 `progressPage`（LEFT JOIN `reading_progress.page_no`）；主页转盘的 `HomeBook.progress` 收敛为 `{ pageNo }`，取消「60 次 `progress_get`」的数据源方案 | 13 §4 / M14 §9 | M04 的 `document_list/recent` 查询各加一列；M14 直接消费 |
| R22 | 新增 `library_root_update { id, displayName }` → `LibraryRootDto`：**只改显示名**（trim 后不得为空，最长 120 字）。路径变更不走这里——换文件夹等于换内容，必须走 R23，否则旧路径下的文档记录会留在库里，正是「改了文献库但旧文献还在」的成因。成功后发 `library://changed { kinds:[updated], rootId }` | 03/05 只有 add/remove，没有任何「改」的路径 | M04 命令 + `LibraryRootRepo::rename`；M14 文献库列表行操作 |
| R23 | 新增 `library_root_replace { id, path }` → `LibraryRootDto`：把库根指向另一个文件夹，并在**同一事务内硬删除**该库根下全部文档记录（逐条走 `delete_record`，先清 contentless 的 `page_fts` 再删行，级联清 `page_text/bookmarks/reading_progress/indexing_jobs`），随后 `UPDATE library_roots SET path, last_scanned_at = NULL`，发 `library://changed { kinds:[removed], rootId }`，由前端再发起 `library_scan_start`。**为什么硬删除而不是软删除**：`documents` 上有 `UNIQUE (library_root_id, rel_path_key)`，软删除的行仍占着该键，换文件夹后同名文件会插入失败。路径与其它库根冲突时前置判为 `E_INVALID_ARG`，不把 `E_DB` 抛给前端。磁盘上的旧文件一个都不动（沿用 R16 的约定） | 没有任何「换库」的路径；用户只能移除再用添加，且旧记录会占着唯一键 | M04 命令 + `LibraryRootRepo::replace_path` / `DocumentRepo::purge_documents_of_root`；M03 无 schema 变更；M14 文献库列表行操作 |
| R24 | 新增 `library_scan_now { rootId? }` → `ScanOutcomeDto { scanned, added, updated, revived, removed }`：**同步**扫描，扫完才返回计数（单库根失败只记日志并继续，不让整次刷新失败），期间照常发 `library://scan-progress`，并按实际变化发 `library://changed { kinds }`。**为什么必须新增**：`library_scan_start` 立即返回，前端无法知道「扫描完成」这一刻，于是「刷新」只能重读旧库（新增/删除的文本要重选路径才可见）。同时新增 `library_pick_folder` → `string \| null`（null = 用户取消），用系统文件管理器窗口代替手输绝对路径；Windows 侧走 `IFileOpenDialog + FOS_PICKFOLDERS`（复用 tauri 已缓存的 `windows` crate，不新增下载），其它平台返回 `E_UNSUPPORTED` | 没有任何可等待的扫描完成信号；添加/替换库根只能靠 `setTimeout(2000)` 猜 | M04 命令 + `library/dialog.rs`；M14 文献库工具栏「刷新」与添加/替换对话框 |
| R25 | M06 新增两个方法 `getTextContent` / `prefetchText`（并把已实现但漏记的 `retry` 补进契约）。**为什么必须新增**：文本提取此前散落在四处（scheduler、M07 的几何循环、PageSlot 文本层、文内搜索），同一页可能被解析 2–3 次，搜索还完全绕开 `textCache`。新增后「谁解析文本」只有一个答案，M07 不再直接调用引擎 | 05 §7 缺文本入口，导致 08 §6 的文本 LRU 事实上没人共用 | M06 提供；M07 的文内搜索与文本层改为消费它（行为不变，仅去重） |
| R18 | 引擎类型与调度类型分文件归属：`src/pdf-engine/types.ts`（M05）与 `src/render/types.ts`（M06），禁止双写同义类型 | 05 §7 原注释把两类都指向 pdf-engine | M05/M06 各自只写自己那份 |

后续如需新增表格类字段，同样在本表登记 R7、R8…，不要在代码里悄悄改契约。
