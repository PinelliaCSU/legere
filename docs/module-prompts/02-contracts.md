# 模块 M02：contracts

> 依赖前置：M01 foundation（工程骨架、`ApiError` 基类型、`src/core/` 与 `src-tauri/src/contracts/` 目录的所有权转移）。
> 被依赖方：M03 database、M05 pdf-engine、M07–M15 全部模块——**本模块冻结后，其余模块才允许写业务代码**（03 §3）。
> 归属层：全栈（Rust `contracts/` + TS `src/contracts/` + `src/core/ipc.ts`）；并行组：串行主链第二环，无并行伙伴。

## 1. 模块身份

M02 是「契约落地层」：把 `docs/04` 的表结构与 `docs/05` 的 DTO/错误码/Command/事件，一次性翻译成**可编译的 Rust 结构与 TS 类型**，并提供二者字段一致的机器检查。它不产生任何业务行为，但决定了 13 个模块的接口面。

数据流上它是唯一的「命名权威」：Rust Command 的返回值与 TS 端 `call<T>()` 的泛型都取自本模块；前端**不得**出现 SQL 或表名（02 §2 规则 3），只能经由这里的 DTO。

它的产物一旦冻结，字段改名即为架构变更（02 §12 第 3、4 项，04 §9 D09）。

## 2. 项目背景

## A. 项目背景

你在开发 **Legere**：一款**个人使用**的本地 PDF 文献库阅读器桌面应用（Tauri 2 + Rust 后端 + React/TS 前端）。它不是一个"PDF 查看器"，而是「文献库管理 + 全文检索 + 自定义阅读体验」三者的结合体。

Local-first 硬约束：

- PDF 文件永远在本地，不上传、不联网同步。
- 索引、书签、进度、设置全部存本地 SQLite。
- 不依赖任何云服务；离线可用是核心能力。

产品形态要点（来自用户本人）：

- **阅读界面完全自定义**，不使用 PDF.js 默认 Viewer 的 UI。PDF.js 只作为底层能力（加载、渲染、文本提取、Outline）。
- 应用有**用户亲自设计的入口主页**：书脊沿圆周排布的空间转盘，可见弧渲染书脊并可交互，隐藏弧**完全不渲染**任何书籍信息。详见 `docs/13-ui-home-concept.md`。
- 不做 OCR；扫描版 PDF 允许索引失败，但应用不得崩溃、不得伪装成功。

## B. 技术栈（已冻结，不得替换）

Tauri 2 · Rust（edition 2021）· React + TypeScript + Vite · pdfjs-dist（**仅 Display API**）· SQLite（`rusqlite` bundled）· FTS5 · `jieba-rs` · Tokio · `notify` · Zustand · Tailwind CSS · serde。

若要替换任何一项：先停止实现，在交付报告中写「技术选择异议」并说明（1）问题（2）影响（3）现有栈内能否解决（4）是否必须替换（5）替换成本。**不得**自行更换。

## C. 必须阅读的冻结契约（本次实现的唯一事实来源）

| 文件 | 提供什么 |
|---|---|
| `docs/02-system-architecture.md` | 分层、依赖方向、数据流、6 张架构图、决策记录 D01–D12、待验证项 V-01–V-07 |
| `docs/03-module-boundaries.md` | 15 个模块的职责/不负责/输入输出/文件归属矩阵/并行组 |
| `docs/04-database-design.md` | 完整 DDL、字段语义、迁移、一致性、FTS5 细节 |
| `docs/05-api-contracts.md` | ApiError、DTO、28 个 Command、5 个事件、`pdf://` 协议、PDF Engine 接口 |
| `docs/13-ui-home-concept.md` | 主页空间转盘的唯一设计说明 |

规则：**契约优先于直觉**。契约没写的细节你可以自行决定并记录；契约写了的，不许改；契约有矛盾或缺失，报告「契约问题」，不要自作主张。

## D. 分层与依赖方向（硬约束）

```text
L4 Workspace（文献库/主页/全局搜索/设置）
L3 Reader Interaction（模式/缩放/导航/选择）
L2 PDF Engine（Document/PageProxy/RenderScheduler）
L1 IPC Client（invoke 封装/事件/错误映射）
L0 Rust Core（db/library/index/search/fs）
```

- 依赖只能自上而下；L2 不得 import L3/L4；L3/L4 不得 import `pdfjs-dist`；前端不得出现 SQL 或表名。

## E. 通用工程规范

1. TypeScript `strict: true`；禁止 `any`（必须时用 `unknown` + 收窄），禁止 `@ts-ignore`。
2. Rust 禁止 `unwrap()`/`expect()`（测试代码与启动期常量除外）；禁止把 `anyhow` 字符串直接抛给前端。
3. 单文件超 600 行先拆分；单函数超 80 行先拆函数。
4. 错误必须显式处理：要么转换为 `ApiError`，要么 `warn!`/`console.warn` 并带上下文。静默吞错误视为缺陷。
5. 不写"自我描述"注释（`// 这里是循环`）；只写"为什么"（`// rowid 复用会串号，所以同事务删除`）。
6. 命名遵循 `docs/05-api-contracts.md` §9。
7. 不引入新的大型依赖（新增 runtime 依赖需在报告中说明理由与体积影响）。

## 3. 模块目标

交付一套「字段名双向为空、命令集合双向相等、错误码双向完整」的类型契约层，使其余模块不需猜任何字段名即可编码。

1. 15 个 DTO/查询/枚举类型在 Rust 与 TS 两侧同名、同字段、同可空性（05 §2 L64–L148）。
2. `ApiError` 与 `ApiErrorCode` 的 12 个变体双向完整（05 §1 L29–L32）。
3. `CMD`（28 条）与 `EVT`（5 条）常量表逐条对齐 05 §3 / §4。
4. `call<T>()` / `subscribe<E>()` 可用且有错误归一化与超时（05 §5）。
5. `scripts/check-contracts.mjs` 能输出「三处」字段差集，非空即失败（05 §10 第 1 条）。
6. 集合一致性可判定：`CMD` 值集合 == `COMMAND_NAMES` == `lib.rs` 中 `generate_handler!` 列表（05 §10 第 2 条）。

## 4. 功能范围（必须完成）

F-01 Rust DTO：`src-tauri/src/contracts/` 下按主题分文件（`paging.rs`、`document.rs`、`search.rs`、`aux.rs`、`error.rs`、`app_info.rs`（M01 已有）），落 05 §2 全部类型：`PageDto<T>`、`MetaState`、`TextState`、`ReadMode`、`LibraryRootDto`、`DocumentDto`、`DocumentDetailDto`、`DocumentQuery`、`DocumentSourceDto`、`ProgressDto`、`BookmarkDto`、`IndexStatusDto`、`SearchMode`、`GlobalSearchParams`、`GlobalSearchHitDto`、`GlobalSearchResultDto`、`GlobalSearchPageDto`、`SettingsMapDto`。**字段名与顺序以 05 §2 代码块为准**（行号见 §9 引用列）。数值类型：库内 `i64` 计数/时间戳、`f64` 比例与缩放、时间字段一律 `String`（UTC ISO-8601，04 §1 第 2 条）。

F-02 TS DTO：`src/contracts/` 下镜像同名接口，字段逐一对应；`Option<T>` 写作 `T | null`（不是 `?`，见 §9 规则 2）。禁止出现 `any`。

F-03 错误层：`ApiErrorCode` 12 变体（05 §1 L19–L23）在两侧齐备；Rust 侧提供 `impl ApiError { pub fn new(code, message) -> Self }` 与 `From<…>` 收口点（M01 已落 `From<FoundationError>`，本模块只补 DTO 层通用构造，不改 M01 文件语义）。

F-04 命令表：`src-tauri/src/contracts/manifest.rs` 中的 `pub const COMMAND_NAMES: &[&str]` 按 05 §3 表**行序**列 28 条：`ping, app_info, library_root_list, library_root_add, library_root_remove, library_scan_start, document_list, document_get, document_url, document_recent, document_touch_opened, document_record_delete, index_enqueue, index_cancel, index_status, index_pause, index_rebuild_all, search_global, search_global_count, bookmark_list, bookmark_create, bookmark_update, bookmark_delete, progress_get, progress_save, settings_get_all, settings_set, db_integrity_check`。

F-05 TS 常量表：`src/contracts/commands.ts` 的 `export const CMD = { … } as const`（28 条，键名 = 命令名常量，值 = 契约原名，05 §9 L357）；`src/contracts/events.ts` 的 `export const EVT = { … } as const`（5 条：`app://ready`、`library://scan-progress`、`library://changed`、`index://progress`、`index://job-finished`，05 §4 L214–L218）。

F-06 类型映射：`src/contracts/map.ts` 定义 `CommandMap`（28 个键，键名 = 05 §3 命令名，每项 `{ args: …; result: … }`）与 `EventMap`（5 个键 = 事件名，值为 payload 类型）。无入参命令的 `args` 写 `void`。

F-07 IPC 客户端：`src/core/ipc.ts` 实现 05 §5 的 `call` / `subscribe`；`call` 捕获 `invoke` 抛出的任意值与 `ApiError` 形状做判别，归一化为 `ApiError`，未知错误一律 `E_INTERNAL` 且原始字符串进 `detail`；默认 `timeoutMs = 15000`；`subscribe` 返回取消函数并在内部按事件名去重（05 §4 规则 3）。

F-08 一致性脚本：`scripts/check-contracts.mjs`（Node ESM，零依赖）三件事——(A) 抽 `src-tauri/src/contracts/*.rs` 中 `pub struct \w+(Dto|Query|Params|Hit)` 的 `pub (\w+):` 字段名，camelCase 化后与 `src/contracts/*.ts` 中 `export interface` 的字段名做**双向**差集；(B) 抽 `CMD` 的值集合与 `COMMAND_NAMES` 的字面量比对；(C) 抽 `lib.rs` 中 `tauri::generate_handler![ … ]` 的标识符集合与 `COMMAND_NAMES` 比对。任一差集非空 → 打印文件名+字段名并 `exit 1`。

F-09 错误码完整性测试：Rust 侧 `#[test]` 断言 `ApiErrorCode` 的 `serde_json` 序列化集合等于 12 个码串（05 §1 L44–L57 的 code 列）；TS 侧 `src/contracts/error.test.ts` 读取 `ApiErrorCode` 联合类型的运行时清单（由 `const API_ERROR_CODES` 数组导出并`satisfies` 联合）断言长度 12。

F-10 命令集覆盖测试：Rust `#[test] fn command_names_match_manifest()` 与 TS `src/contracts/commands.test.ts`（`Object.values(CMD)` 去重后长度 28，且每条与 `COMMAND_NAMES` 逐条相等）。M02 不实现任何 Command 本体，只保证注册集合的表在 M03–M13 追加实现时被点亮。

## 5. 非目标（明确不做）

### 5.0 已由 Lead 裁决的技术参数（**不再询问，按此实现**）

以下条目曾标为「待你确认」，但属技术参数且**已由 Lead 按官方文档与工程判断裁决**：**T1 T2 T3 T4 T5** —— 明细与理由见 `docs/14-ui-decision-register.md` §1 对应行。实现时直接落该值，**不得**再当作待确认项停下来问；若你认为某条在本模块不成立，在交付报告 §9 提出并说明，不要自行改动。

1. 不实现任何 Command 的业务逻辑（不查库、不读文件、不启动扫描）；`ping`/`app_info` 留 M01 的实现。
2. 不建表、不写 SQL、不引入 `rusqlite`（属 M03）；不定义 Repository trait（属 M03）。
3. 不实现 `pdf://` 协议（属 M01）、不做 PDF 引擎类型（05 §7 属 M05，**不得**在 `src/contracts/` 里重复定义 `DocumentHandle`/`RenderScheduler` 等）。
4. 不写任何 UI 组件、不定义主题令牌（属 M13/M14）；**不得自行确定视觉方案**。
5. 不改 `docs/05` 任何字段名/命令名/错误码去「迁就」实现；发现矛盾只写报告第 9 节。
6. 不做状态管理（zustand store 属各业务模块），不做路由。

6. 不得自行确定视觉方案；下面这份清单在本模块一律只留 `TODO(ui-confirm)` 占位，并在报告第 6 节逐条列出。

**本模块【待你确认】清单（不得自行选择）**

1. 【待你确认】`ApiError.message` 的中文短句措辞基线（统一句式还是按模块自由写）——建议契约层只保证 `code`，文案表由 M14 统一维护。
2. 【待你确认】`call` 超时命中时抛哪个码——建议 `E_INTERNAL` + `retriable: true`（契约未定义超时码，`E_CANCELED` 的语义是调用方主动取消）。
3. 【待你确认】`check-contracts.mjs` 失败是否阻塞 `pnpm build`——建议只在 `pnpm check-contracts` 与 CI 前置执行。
4. 【待你确认】`ApiError.detail` 是否允许展示在 UI——建议仅调试面板可见。
5. 【待你确认】`CMD` 键名风格（`CMD.DOCUMENT_LIST` 还是 `CMD.documentList`）——建议全大写下划线，与命令名一一映射。

## 6. 架构约束

- 允许依赖：M01 的工程与 `ApiError` 基类型、`@tauri-apps/api`（`invoke`/`listen`）、`serde`/`serde_json`。
- 不允许依赖：任何业务模块（`src-tauri/src/{db,library,index,jobs,search,aux}`、`src/{pdf-engine,render,reader,workspace,theme,features}`）。**契约层不得 import 实现层**，否则依赖方向倒置（02 §2 规则 1–5）。
- 接口所有权：`src-tauri/src/contracts/**`、`src/contracts/**`、`src/core/ipc.ts` 归 M02 独占（03 §4）；M01 首次创建的 `contracts/error.rs`、`contracts/app_info.rs` 在本模块落地后由 M02 唯一维护。
- 状态归属：本模块**无状态**。`ipc.ts` 只允许持有 `Map<event, Set<handler>>` 与超时计时器，不缓存业务数据。
- 不负责清单与边界线：本模块结束于「类型 + 常量 + 通道 + 检查脚本」；一切读写行为从 M03 起算。

## 7. 输入与输出

| 输入来源 | 数据形态 | 触发时机 |
|---|---|---|
| `docs/05-api-contracts.md` §1/§2/§3/§4/§5 | 冻结文本 | 人工抄录（唯一权威） |
| `docs/04-database-design.md` §3 | DDL 列名 | 校验 DTO 可映射性 |
| `src-tauri/src/contracts/*.rs` | Rust 结构源文件 | `check-contracts.mjs` 运行 |

| 输出目标 | 数据形态 | 消费方 |
|---|---|---|
| 全部 Rust 模块 | `*Dto` / `ApiError` / `COMMAND_NAMES` | M03–M13 |
| 全部 TS 模块 | `*Dto` / `CMD` / `EVT` / `CommandMap` / `EventMap` | M05–M15 |
| 业务前端 | `call<T>()` / `subscribe<E>()` | 全部 L3/L4 |
| CI 与验收 | `check-contracts.mjs` 退出码 | Lead/M15 |

## 8. 接口契约

**TS（05 §5 / L226–L239 原文签名，逐字实现）**

```ts
export async function call<K extends keyof CommandMap>(
  name: K, args: CommandMap[K]["args"], opts?: { timeoutMs?: number }
): Promise<CommandMap[K]["result"]>;

export async function subscribe<E extends keyof EventMap>(
  event: E, handler: (payload: EventMap[E]) => void
): Promise<() => void>;
```

**CommandMap 键（28 条，逐条对齐 05 §3 行号）**

| 键 | 契约行 | args | result |
|---|---|---|---|
| `ping` | #1 / L172 | `void` | `{ ok: true; version: string }` |
| `app_info` | #2 / L173 | `void` | `{ version: string; dataDir: string; dbPath: string; ftsEnabled: boolean; contentlessDelete: boolean }` |
| `library_root_list` | #3 / L174 | `void` | `LibraryRootDto[]` |
| `library_root_add` | #4 / L175 | `{ path: string }` | `LibraryRootDto` |
| `library_root_remove` | #5 / L176 | `{ id: number; purge: boolean }` | `void` |
| `library_scan_start` | #6 / L177 | `{ rootId?: number }` | `{ started: boolean; reason?: string }` |
| `document_list` | #7 / L178 | `{ query: DocumentQuery }` | `PageDto<DocumentDto>` |
| `document_get` | #8 / L179 | `{ id: number }` | `DocumentDetailDto` |
| `document_url` | #9 / L180 | `{ id: number }` | `DocumentSourceDto` |
| `document_recent` | #10 / L181 | `{ limit: number }` | `DocumentDto[]` |
| `document_touch_opened` | #11 / L182 | `{ id: number }` | `void` |
| `document_record_delete` | #12 / L183 | `{ id: number }` | `void` |
| `index_enqueue` | #13 / L184 | `{ documentId: number; priority?: number }` | `{ jobId: number }` |
| `index_cancel` | #14 / L185 | `{ jobId: number }` | `void` |
| `index_status` | #15 / L186 | `void` | `IndexStatusDto` |
| `index_pause` | #16 / L187 | `{ paused: boolean }` | `void` |
| `index_rebuild_all` | #17 / L188 | `{ rootId?: number }` | `{ started: boolean }` |
| `search_global` | #18 / L189 | `{ params: GlobalSearchParams }` | `GlobalSearchPageDto` |
| `search_global_count` | #19 / L190 | `{ params: GlobalSearchParams }` | `{ documents: number; pages: number }` |
| `bookmark_list` | #20 / L191 | `{ documentId: number }` | `BookmarkDto[]` |
| `bookmark_create` | #21 / L192 | `{ documentId; pageNo; title; note?; color? }` | `BookmarkDto` |
| `bookmark_update` | #22 / L193 | `{ id; title?; note?; color? }` | `BookmarkDto` |
| `bookmark_delete` | #23 / L194 | `{ id: number }` | `void` |
| `progress_get` | #24 / L195 | `{ documentId: number }` | `ProgressDto \| null` |
| `progress_save` | #25 / L196 | `{ progress: ProgressDto }` | `void` |
| `settings_get_all` | #26 / L197 | `void` | `SettingsMapDto` |
| `settings_set` | #27 / L198 | `{ key: string; value: string }` | `void` |
| `db_integrity_check` | #28 / L199 | `void` | `{ ftsRows; pageTextRows; orphanPages; mislabeledDocuments: number[] }` |

**EventMap 键（5 条，逐条对齐 05 §4 行号）**：`app://ready`（L214，`{ version }`，一次）、`library://scan-progress`（L215，`{ rootId: number|null; phase: "walking"|"finalizing"|"done"; scanned: number; added: number; updated: number; removed: number; error: ApiError|null }`，200ms）、`library://changed`（L216，`{ kinds: ("added"|"updated"|"removed")[]; documentIds: number[]; rootId: number|null }`，300ms 聚合）、`index://progress`（L217，`IndexStatusDto`，250ms）、`index://job-finished`（L218，`{ jobId: number; documentId: number; state: "done"|"failed"|"canceled"; error: ApiError|null }`，每任务一次）。

**本模块新增的内部接口（契约未定义）**：`src-tauri/src/contracts/manifest.rs::COMMAND_NAMES`；`scripts/check-contracts.mjs` 的三项检查函数；TS 侧 `API_ERROR_CODES` 运行时常量。三者均为检查用途，不进入业务调用面。

## 9. 数据结构

**DTO 权威表（字段逐项取自 05 §2；Rust 侧一律 `#[serde(rename_all = "camelCase")]`，字段名写 snake_case，序列化后自动与 TS 一致）**

| 类型 | 契约位置 | 关键字段（TS 视角） |
|---|---|---|
| `PageDto<T>` | 05 §2 / L64 | `items: T[]; total: number; offset: number; limit: number` |
| `MetaState` | L65 | `"pending" \| "ok" \| "failed"` |
| `TextState` | L66 | `"pending" \| "indexing" \| "indexed" \| "no_text" \| "failed"` |
| `ReadMode` | L67 | `"continuous" \| "single"` |
| `LibraryRootDto` | L69–L72 | `id, path, displayName, enabled, createdAt, lastScannedAt\|null` |
| `DocumentDto` | L74–L83 | `id, libraryRootId, fileName, relPath, sizeBytes, mtimeMs, pageCount\|null, pdfTitle\|null, pdfAuthor\|null, metaState, textState, lastOpenedAt\|null, hasProgress` |
| `DocumentDetailDto` | L85–L92 | 上列全部 + `absPath, pdfSubject, pdfKeywords, pdfProducer, pdfCreator, pdfCreationDate, indexErrorCode, indexErrorMsg, bookmarks, progress` |
| `DocumentQuery` | L94–L101 | `text?, rootIds?, textStates?, sort: "name"\|"recent"\|"added"\|"size", order: "asc"\|"desc", offset, limit`（limit ≤ 200） |
| `DocumentSourceDto` | L103 | `url, pageCount\|null, fileName` |
| `ProgressDto` | L105–L108 | `documentId, pageNo, scrollRatio, zoom, mode, updatedAt` |
| `BookmarkDto` | L110–L114 | `id, documentId, pageNo, title, note\|null, color\|null, createdAt, updatedAt` |
| `IndexStatusDto` | L116–L122 | `paused, workers, queued, running, documentsIndexed, documentsPending, documentsFailed, documentsNoText, current\|null` |
| `SearchMode` | L124 | `"phrase" \| "terms"` |
| `GlobalSearchParams` | L125–L131 | `query, mode, rootIds?, hitsPerDocument, documentOffset, documentLimit` |
| `GlobalSearchHitDto` | L133–L137 | `pageNo, snippet, ranges: [number, number][]` |
| `GlobalSearchResultDto` | L139–L141 | `document, hitCount, hits` |
| `GlobalSearchPageDto` | L143–L146 | `items, totalDocuments, offset, limit, tookMs` |
| `SettingsMapDto` | L148 | `Record<string, string>`（value 为 JSON 字符串） |

**序列化规则（三条，落到代码必须能指出出处）**

1. `#[serde(rename_all = "camelCase")]`：每个 DTO 结构都加；Rust `pub struct DocumentDto { pub file_name: String, … }` 序列化为 `fileName`（05 §2 / L153）。泛型 `PageDto<T>` 同样加。
2. `Option<T>` ↔ `T | null`（05 §2 / L154）：**禁止** `#[serde(skip_serializing_if = "Option::is_none")]`——省略字段会变成 TS 的 `undefined`，违反「不是 undefined」。TS 侧写成 `note: string | null`，不用可选标记。
3. 枚举字符串化（05 §2 / L155）：`TextState`、`MetaState`、`ReadMode`、`SearchMode` 加 `#[serde(rename_all = "snake_case")]`；`ApiErrorCode` **不加任何 rename**（变体名 `E_INVALID_ARG` 即协议值，05 §1 / L19–L23）；`kind`/`phase`/`state` 之类内联字符串联合类型在 Rust 侧用独立枚举 + `snake_case`，并在对应 DTO 字段上使用。

**「字段改名三处同步」检查法**：一处改 =（a）`docs/04` §3 的列名、（b）`src-tauri/src/contracts/*.rs` 的 `snake_case` 字段、（c）`src/contracts/*.ts` 的 `camelCase` 字段。`check-contracts.mjs` 检查 (b)↔(c)；(a)↔(b) 由 M03 的 Repository 行映射单元测试断言（在报告中互相引用）。脚本输出格式：`MISMATCH <TypeName>: rust-only=<fields> ts-only=<fields>`，全空时打印 `contracts OK (n types, 28 commands, 5 events, 12 codes)`。

## 10. 文件组织

```text
src-tauri/src/contracts/
├── mod.rs            # 门面：pub use 全部类型 + COMMAND_NAMES
├── error.rs          # ApiError / ApiErrorCode（M01 首建，本模块接管）
├── app_info.rs       # PingResult / AppInfoDto（M01 首建）
├── paging.rs         # PageDto<T> + MetaState/TextState/ReadMode
├── document.rs       # LibraryRootDto/DocumentDto/DocumentDetailDto/DocumentQuery/DocumentSourceDto
├── search.rs         # SearchMode/GlobalSearchParams/GlobalSearchHitDto/Result/Page
├── aux.rs            # ProgressDto/BookmarkDto/IndexStatusDto/SettingsMapDto
└── manifest.rs       # COMMAND_NAMES + 集合一致性测试
src/contracts/
├── error.ts          # ApiError / ApiErrorCode / API_ERROR_CODES / isApiError()
├── types.ts          # 全部 DTO 与枚举联合类型（与 Rust 一一对应）
├── commands.ts       # CMD（28 条，as const）+ CommandMap
├── events.ts         # EVT（5 条，as const）+ EventMap
├── index.ts          # 统一导出
└── *.test.ts         # commands/error 完整性测试
src/core/ipc.ts       # call<T>() / subscribe<E>() / 错误归一化 / 超时 / 订阅去重
scripts/check-contracts.mjs
```

## 11. 实施步骤

1. **抄 DTO（Rust 侧）**：按 05 §2 行序逐块落结构，先 `paging.rs` → `document.rs` → `search.rs` → `aux.rs`。判据：`cargo build` 通过；每条结构上方写 `/// 见 docs/05-api-contracts.md §2 L<行号>` 的溯源注释（这是「为什么」类注释，允许）。
2. **抄 DTO（TS 侧）**：镜像同序落 `types.ts`。判据：`tsc --noEmit` 通过。
3. **错误码**：两边齐备 → 写 F-09 的完整性测试。判据：删掉任一码，两条测试分别失败（用 `git stash` 或临时注释实测一次并记入报告）。
4. **命令与事件常量**：`manifest.rs` + `CMD`/`EVT` + `CommandMap`/`EventMap`。判据：`cargo test` 与 `pnpm test` 均能跑出 28/5 计数。
5. **IPC 客户端**：实现 `call`/`subscribe`（超时用 `AbortController` 语义或 `Promise.race`，二选一并在报告说明依据）。判据：单测用假 `invoke` 注入验证「未知错误 → `E_INTERNAL` + detail 保留」。
6. **一致性脚本**：实现 A/B/C 三项检查。判据：故意把某个 TS 字段改名，脚本 `exit 1` 并打印该字段；复原后 `exit 0`。
7. **接线验证**：把 M01 的 `scripts/check-contracts.mjs` 桩替换为真实脚本；把 M01 的 `ipc-probe.ts` 调用点换成 `call("ping", undefined)`。判据：`pnpm check-contracts` 绿。

## 12. 测试要求

**Rust**：`ApiErrorCode` 12 变体序列化快照；`COMMAND_NAMES` 长度 28 且无重复；`DocumentDto` 序列化 JSON 的键集合 == 05 §2 L74–L83 字段名集合（用 `serde_json::to_value` + 键排序断言）；`Option` 字段序列化后**存在且为 `null`**（防 `skip_serializing_if` 回归）。

**TS（vitest）**：`CMD` 值集合长度 28、`EVT` 长度 5、`API_ERROR_CODES` 长度 12；`call` 错误归一化 3 例（`ApiError` 原样透传 / `{ code: "X" }` 未知码 → `E_INTERNAL` / `new Error("boom")` → `E_INTERNAL` 且 `detail === "boom"`）；`call` 超时 1 例（`timeoutMs: 10` → 抛 `E_INTERNAL` 或 `E_CANCELED`，二选一后固定并记录）；`subscribe` 去重 1 例（同事件订阅两次，触发一次回调两次 × 单次发送 → 每回调各一次，且返回的两个取消函数互不影响）。

**边界**：`PageDto<T>` 空列表（`total = 0` 但 `items = []`）；`DocumentQuery.limit = 201` 属于 M04 的参数校验，本模块只保证类型允许 `number`。

**命令**：`cargo test --manifest-path src-tauri/Cargo.toml`；`pnpm test -- --run`；`pnpm build`（含 `tsc --noEmit`）；`node scripts/check-contracts.mjs`。

## 13. 验收标准

1. `cargo build --manifest-path src-tauri/Cargo.toml` 通过；`pnpm build`（含 `tsc --noEmit`）通过；无 `any`、无 `@ts-ignore`、无 `unwrap()`（`grep` 计数为 0，命令写进报告）。
2. `node scripts/check-contracts.mjs` 输出差集为空，并打印 `contracts OK (… 28 commands, 5 events, 12 codes)`，退出码 0。
3. `CMD` 集合与 Rust 注册集合完全相等，比对方式固定为两步：(a) 脚本用正则从 `src-tauri/src/lib.rs` 的 `tauri::generate_handler![…]` 抓取标识符集合，与 `COMMAND_NAMES` 比对；(b) `COMMAND_NAMES` 与 `Object.values(CMD)` 比对。两步任一失败即 `exit 1`。
4. 错误码完整性测试：Rust 侧删除任一 `ApiErrorCode` 变体 → 该测试失败；TS 侧删除任一码 → 对应测试失败（两条都实测一次并记录输出）。
5. `Option` 字段序列化为 `null` 而非缺失（快照断言）。
6. `call("ping", undefined)` 在 `cargo tauri dev` 下返回 `{ ok: true, version }`；注入非法命令名时抛出 `ApiError`（`code === "E_INTERNAL"`，`detail` 非空）。
7. 本模块不新增任何 `#[tauri::command]` 函数体（除 M01 的 `ping`/`app_info`），`grep -c "#\[tauri::command\]" src-tauri/src/contracts` 为 0。

## 14. 交付报告

## I. 交付报告格式（必须逐项填写）

```text
## 交付报告 — <模块 ID 模块名>

### 1. 修改/新增的文件（路径 + 一句话作用）
### 2. 实现的功能（对应任务清单逐条勾选）
### 3. 对外提供的接口（签名 + 语义；若无变化写"与契约一致"）
### 4. 如何测试（命令 + 步骤）
### 5. 测试结果（命令输出摘要，含失败项）
### 6. 待确认问题（【待你确认】条目逐条列出，附建议选项）
### 7. 已知问题与未完成项
### 8. 对其他模块的影响（含需要的额外接口）
### 9. 契约问题（如有：哪条契约不成立/缺失，建议如何改）
```

## 15. 禁止事项

## H. 禁止事项（任一项出现即视为交付失败）

1. 修改其他模块的文件或接口契约（见 03 的文件归属矩阵）。
2. 引入未经批准的架构变更或新的大型依赖。
3. 为通过验收而伪造实现、硬编码返回值、把未实现功能写成已完成。
4. 删除或破坏已有测试；降低既有断言以"通过"。
5. 长时间保留 mock 数据源而不接真实接口。
6. 越界实现其他模块职责（宁可返回"需要 M0x 提供"也不要自己造）。
7. 用 `display:none` 等手段"隐藏"本该完全不渲染的节点。

本模块补充禁令：

1. 不得为了「跑通」而给 DTO 加 `skip_serializing_if`、改字段名、改可空性；发现契约字段无法映射到 `docs/04` 的列，写报告第 9 节，不动代码。
2. 不得在 `src/contracts/` 重复定义 `pdfjs-dist` 相关类型或 `src/pdf-engine/types.ts` 的内容（05 §7 归 M05）。
3. 不得让 `ipc.ts` 缓存业务数据、拼 SQL、或 import 任何 `src/{workspace,reader,theme,features}` 模块。
4. 不得在 `ContractMap` 之外用裸字符串调用 `invoke`；不得把事件名写死在业务代码里（必须走 `EVT`）。
5. 不得把 `check-contracts.mjs` 写成「永远返回 0」的空壳；也不得用正则漏检嵌套结构后宣称「差集为空」——脚本必须能对故意改名报错（§11 步骤 6 的实测证据）。
6. 不得自行决定任何界面文案的措辞风格（`ApiError.message` 的具体中文短句留给 UI 确认/各模块），本模块只提供结构与字段。