# 模块 M04：library

> 依赖前置：M03 database（`DocumentRepo`/`LibraryRootRepo`/`JobRepo` 与 `Db::read`/`write`）。
> 被依赖方：M10 job-orchestrator（本模块投递任务）、M14 workspace-shell（文献库视图数据源）、M11（经 `documents` 行）、M15。
> 归属层：L0 Rust Core；并行组：A（03 §3 第一批并行，M03 完成后即可开工，与 B/C/D 并发）。

## 1. 模块身份

M04 是「文件系统 → 数据库」的唯一入口：它把磁盘上的 PDF 文件变成 `documents` 行（文件事实：`rel_path`/`abs_path`/`size_bytes`/`mtime_ms`），并在增删改时投递 `indexing_jobs`，让索引链（M09/M10）有活干。

**它不解析 PDF**（03 §2 M04 / L64 硬边界）：`page_count` 与 `pdf_*` 元数据由 M09 的 `TextExtractor` 经 M10 的 `kind='meta'` 任务产出；正文由 `kind='text'` 任务产出。M04 只负责「发现文件、记住事实、判定增量、发布变更」。

数据流上它是 02 §8 增量索引流程图的左半边（扫描与差异计算），右半边（提取与分词）不归它。

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

交付一个「扫描一次就能让 `documents` 与磁盘一致、此后只按差异增量、且永不因单个坏文件崩溃」的文献库层，并把变更以 `library://*` 事件与 `indexing_jobs` 两种形式交出去。

1. 库根可增删查（`library_root_*` 三条命令），路径规范化与唯一约束正确。
2. 递归扫描可按 `(rel_path, size, mtime_ms)` 三分支判定增量（02 §8 / L262）。
3. 半写文件、无权限目录、符号链接、隐藏目录有明确策略且不崩溃。
4. 软删除与「同路径复活」保持 id 稳定（04 §4 / L155）。
5. `notify` 监控 800ms 防抖聚合，事件节流按 05 §4。
6. 7 条文档/扫描命令可用，`library_scan_start` 有 `E_BUSY` 重入保护。

## 4. 功能范围（必须完成）

F-01 库根（05 §3 #3/#4/#5）：`library_root_list` 返回全部根；`library_root_add` 校验路径存在且是目录（否则 `E_INVALID_ARG`）、无读权限 → `E_PERMISSION`、I/O 失败 → `E_IO`、写入冲突 → `E_DB`；路径按 04 §1 第 3 条**规范化**（Windows：反斜杠转正斜杠 + 盘符大写 + 去掉尾部分隔符）后写入 `library_roots.path`（UNIQUE）。`display_name` 取目录名（本模块的确定性策略：末级目录名，空则用盘符/路径）。`library_root_remove`：`purge=false` 仅删根行（`documents` 随外键级联消失，文件保留），`purge=true` 语义与 `false` **在数据库层面相同**——**不要**删用户磁盘文件；若 Agent 认为应删文件，先写报告第 9 节，不得自行实现删文件。

F-02 递归扫描（`walkdir` 或手写栈，遍历顺序无关）：忽略规则固定为——隐藏目录（名称以 `.` 开头）、系统保留目录（`System Volume Information`、`$RECYCLE.BIN`、`node_modules`、`.git`）、与应用数据目录同路径的目录；**符号链接不跟随**（`follow_links(false)`），遇到即跳过并 `debug!` 记录；只收 `.pdf` 扩展名（大小写不敏感）。单次遍历上限由 F-06 的配置常量给（默认 200000 个文件，超过则停止并记 `warn!`，事件 `phase="done"` 且 `error` 为 `E_INTERNAL`）。

F-03 增量三分支（02 §8 / L262–L263）：一次扫描先 `DocumentRepo::facts_by_root` 取该根全量事实，再对本次遍历结果做差异：
- 新增（磁盘有、库无）→ `insert_found`，`meta_state='pending'`、`text_state='pending'`，投递 `kind='meta'` 与 `kind='text'` 两个任务（`priority=10`）。
- 变化（`size_bytes` 或 `mtime_ms` 任一不同）→ 同事务清索引（`FtsRepo::delete_document_index` + `text_state='pending'`）、`update_facts`，投递两个任务。
- 消失（库有、磁盘无且 `deleted_at IS NULL`）→ `soft_delete`（置 `deleted_at`）+ 清索引 + 投递 `kind='reindex'`？**不投递**：消失的文件只清索引、不排任务（避免对不存在文件开工）。此处与 02 §8 图的「C3 → H → I 入队」存在歧义，按本行实现并在报告第 9 节注明理由（节省无效任务）。

F-04 半写文件跳过：`mtime_ms` 距今 < 2000ms 的文件**本轮跳过**（02 §8 / L262）：不新增、不更新、不软删（已在库中的旧行保持原状），记 `debug!` 计数并在 `library://scan-progress` 的 `scanned` 中计入、`updated` 中不计入。判据逻辑：`now_ms - mtime_ms < 2000`。

F-05 软删除与复活（04 §4 / L155）：`deleted_at NOT NULL` 的行在同 `abs_path_key` 或同 `(library_root_id, rel_path_key)` 再次出现时 → `revive`（清 `deleted_at`、更新 `size`/`mtime`、`text_state='pending'`），**保持 id 不变**，因此书签与进度不丢。

F-06 rename/移动与合并（02 §8 / L251，04 §4 / L154）：`notify` 给出 rename/move 时按新路径的 `abs_path_key` 查 `find_by_abs_path_key`：命中同 id → `move_to_root` 更新 `abs_path`/`rel_path`；命中**另一条**未删除的 id → 冲突合并：保留目标 id（`merge_into(from_id, to_id)`，删 `from_id` 行及其索引），文件事实以新路径为准；成对事件缺失时（V-05 退化路径）→ 本次 rename 视同「先删后增」，用户可见后果是该文档重新索引一次（02 §8 / L263 已接受）。

F-07 `notify` 监控（`notify 8.x`，版本按 V-02 核实）：对每个 `enabled=1` 的根建 watcher，事件进入聚合缓冲，**800ms 静默窗口**后合并为一次增量扫描（02 §8 / L248）；同一路径在窗口内的多次事件只保留最后一次。watcher 生命周期归 `LibraryWatcher`，在 app 退出时 drop；**监控与扫描互斥**：监控触发的扫描同样走 F-08 的互斥锁。

F-08 `library_scan_start`（05 §3 #6）重入保护：进程内持 `Arc<AtomicBool>`（或 `tokio::sync::Mutex` 的 try_lock 语义）标记「扫描进行中」；已在进行时立即返回 `{ started: false, reason: "scan-in-progress" }` 并**不**报错？契约把该命令的错误码只列了 `E_BUSY`，故实现为：**进行中 → 返回 `Err(E_BUSY)`**（`retriable: true`，05 §1 语义表 / L54）；正常启动 → `{ started: true }` 并立即返回（扫描在 `spawn_blocking` 后台跑，遵循 05 §3 约束 2 与约束 4：>50ms 的 CPU 工作不得留在 Command 内）。`rootId` 缺省表示全部 `enabled` 根。

F-09 事件（05 §4）：`library://scan-progress` payload `{ rootId: number|null, phase: "walking"|"finalizing"|"done", scanned, added, updated, removed, error: ApiError|null }`，节流 200ms（`phase="done"` 的一条必须发送且不计入节流丢弃）；`library://changed` payload `{ kinds: ("added"|"updated"|"removed")[], documentIds: number[], rootId: number|null }`，聚合节流 300ms。两者**只做通知**（05 §4 规则 2）：前端收到后自行重新拉取 `document_list`，因此 payload 不追求完整。

F-10 任务投递：新增/变化后向 M10 投递 `kind='meta'` 与 `kind='text'`（03 §2 M04 / L67）。由于 M10 属并行组 B、此刻尚未就绪，本模块定义缝合 trait `IndexJobSink`（§8），并提供 `LogOnlyJobSink`（只 `warn!` 一条 `job_sink_unwired`）作为**临时**注入，M10 就绪后替换。**不得**长期保留（_shared-context H.5）。

F-11 文档命令（05 §3 #7–#12）：`document_list`（`limit > 200` → `E_INVALID_ARG`；`sort`/`order` 按契约四值/两值；`text` 走 `file_name`/`pdf_title` `LIKE` 模糊匹配且必须转义 `%`/`_`）、`document_get`（`DocumentDetailDto`，含 `bookmarks` 与 `progress`，不存在 → `E_NOT_FOUND`）、`document_url`（F-12）、`document_recent`（按 `last_opened_at DESC`，排除已删除与从未打开者）、`document_touch_opened`（`last_opened_at = now`）、`document_record_delete`（软删 + 清索引，同事务，`E_NOT_FOUND`/`E_DB`）。以上均先 `E_NOT_FOUND` 后 `E_DB` 的顺序判定。

F-12 `document_url`（05 §3 #9 / L180，05 §6 / L243）：返回 `DocumentSourceDto { url, pageCount, fileName }`，其中 `url = "pdf://doc/{id}?v={mtime_ms}"`（`mtime_ms` 取库内值，用于避开 WebView 缓存）。它**不读文件字节**，只做「存在性 + 可读性」检查：文件不存在 → `E_NOT_FOUND`；`PermissionDenied` → `E_PERMISSION`（契约该行只列 `E_NOT_FOUND`/`E_IO`，按 `E_IO` 也可接受——选 `E_IO` 并在报告注明）；其余读失败 → `E_IO`。返回值必须是**协议 URL**，绝对不拼接本地路径（05 §6 安全条目）。

F-13 `IndexJobSink` 安装点与 `app://ready` 之后的首轮扫描：M04 不主动在启动时全量扫描（那是 M10/M14 的编排职责），只提供 `library_scan_start`；若 Agent 认为需要「启动自动扫描」，写报告第 9 节，不自作主张（避免与 M14 编排冲突）。

## 5. 非目标（明确不做）

### 5.0 已由 Lead 裁决的技术参数（**不再询问，按此实现**）

以下条目曾标为「待你确认」，但属技术参数且**已由 Lead 按官方文档与工程判断裁决**：**T22 T23 T24 T25 T26** —— 明细与理由见 `docs/14-ui-decision-register.md` §1 对应行。实现时直接落该值，**不得**再当作待确认项停下来问；若你认为某条在本模块不成立，在交付报告 §9 提出并说明，不要自行改动。

1. **不解析 PDF**：不打开文件读页数、不读 `/Title` 等元数据、不做 `%PDF-` 头校验（03 §2 M04 / L64）。损坏 PDF 的后果由 `kind='meta'` 任务失败体现，M04 只保证不崩溃。
2. 不提取正文、不分词、不写 `page_text`/`page_fts`（属 M09）。
3. 不实现任务队列、优先级、限流、取消、进度事件（属 M10）；只投递。
4. 不实现 `search_*`、`index_*`、`bookmark_*`、`progress_*`、`settings_*`、`db_integrity_check`（分别 M11/M10/M12/M12/M13/M03）。
5. 不实现任何文献库 UI、列表卡片、排序控件、空状态文案；**不得自行确定视觉方案**（03 §2 M04 / L65「展示列表 UI」不在本模块）。
6. 不删用户磁盘上的文件（F-01 已明确）。
7. 不做全量哈希（02 §8 / L262 明确只按三元组判定）。

7. 不得自行确定视觉方案；下面这份清单在本模块一律只留 `TODO(ui-confirm)` 占位，并在报告第 6 节逐条列出。

**本模块【待你确认】清单（不得自行选择）**

1. 【待你确认】文献库列表的默认排序（`sort` 契约给四值但未给默认）——建议 `recent`。
2. 【待你确认】`library_root_remove(purge: true)` 是否应删除磁盘文件——契约未定义，建议**不删**，只删数据库行。
3. 【待你确认】扫描进度的呈现形态（状态栏文字/进度条/不显示）——建议本模块只发事件，不做任何 UI。
4. 【待你确认】无权限目录的提示方式（整体报一次还是逐个列出）——建议扫描结束聚合成一次。
5. 【待你确认】「半写文件跳过」是否需要用户可见提示——建议不提示，只记日志。
6. 【待你确认】`library://changed` 的 `documentIds` 上限（当前建议 500）是否需要调整。

## 6. 架构约束

- 允许依赖：M03 的 `Db` 与 Repository trait、`notify`、`tokio`、`walkdir`（或等价手写遍历）、`tracing`、serde。
- 不允许依赖：`src-tauri/src/{index,jobs,search,aux}`（M09–M13）；前端任何类型；**不得**直接 `Connection::open` 或写 SQL（03 §4；02 §3）。
- 接口所有权：`src-tauri/src/library/**` 归 M04 独占（03 §4 / L215）；`lib.rs` 只追加注册行。
- 状态归属：扫描互斥标志、watcher 句柄、聚合缓冲归 M04；`documents` 行的真值归数据库。
- 资源所有权：`walkdir` 迭代器不得跨 `await`；文件`ReadDir` 句柄用完即释放；watcher 必须在 app 生命周期内保持存活，drop 即停止监控。
- 不负责清单与边界线：本模块结束于「`documents` 行 + 变更事件 + 任务投递请求」；PDF 事实（页数、元数据）从 M09 起算。

## 7. 输入与输出

| 输入来源 | 数据形态 | 触发时机 |
|---|---|---|
| 前端 `invoke` | `{ path }` / `{ id, purge }` / `{ rootId? }` / `{ query }` / `{ id }` | 用户操作 |
| 文件系统 | 目录树（`ReadDir` 迭代） | 扫描 |
| `notify` watcher | `Event { kind, paths }` | 文件变动后 800ms 聚合 |
| M03 | `Db`、`DocFact`、`PageDto<DocumentDto>` | 每次读写 |

| 输出目标 | 数据形态 | 消费方 |
|---|---|---|
| 前端 | `LibraryRootDto[]`/`DocumentDto[]`/`PageDto<DocumentDto>`/`DocumentDetailDto`/`DocumentSourceDto`/`ApiError` | M14、M02 `call<T>` |
| 前端（事件） | `library://scan-progress`（200ms）、`library://changed`（300ms） | M14 列表刷新 |
| M10 | `IndexJobSink::enqueue(documentId, kind, priority)` | 索引链 |
| M03 | 事务内的行写入与索引清理 | 持久层 |

## 8. 接口契约

**Command（05 §3 表，逐条对齐行号）**

```rust
// #3 / L174  library_root_list      | — | LibraryRootDto[]                                   | E_DB
#[tauri::command] pub async fn library_root_list() -> Result<Vec<LibraryRootDto>, ApiError>;
// #4 / L175  library_root_add       | { path } | LibraryRootDto | E_INVALID_ARG, E_IO, E_PERMISSION, E_DB
#[tauri::command] pub async fn library_root_add(path: String) -> Result<LibraryRootDto, ApiError>;
// #5 / L176  library_root_remove    | { id, purge } | void | E_NOT_FOUND, E_DB
#[tauri::command] pub async fn library_root_remove(id: i64, purge: bool) -> Result<(), ApiError>;
// #6 / L177  library_scan_start     | { rootId? } | { started, reason? } | E_BUSY
#[tauri::command] pub async fn library_scan_start(root_id: Option<i64>) -> Result<ScanStartResult, ApiError>;
// #7 / L178  document_list          | { query } | PageDto<DocumentDto> | E_INVALID_ARG, E_DB
#[tauri::command] pub async fn document_list(query: DocumentQuery) -> Result<PageDto<DocumentDto>, ApiError>;
// #8 / L179  document_get           | { id } | DocumentDetailDto | E_NOT_FOUND
#[tauri::command] pub async fn document_get(id: i64) -> Result<DocumentDetailDto, ApiError>;
// #9 / L180  document_url           | { id } | DocumentSourceDto | E_NOT_FOUND, E_IO
#[tauri::command] pub async fn document_url(id: i64) -> Result<DocumentSourceDto, ApiError>;
// #10 / L181 document_recent        | { limit } | DocumentDto[] | E_DB
#[tauri::command] pub async fn document_recent(limit: i64) -> Result<Vec<DocumentDto>, ApiError>;
// #11 / L182 document_touch_opened  | { id } | void | E_NOT_FOUND
#[tauri::command] pub async fn document_touch_opened(id: i64) -> Result<(), ApiError>;
// #12 / L183 document_record_delete | { id } | void | E_NOT_FOUND, E_DB
#[tauri::command] pub async fn document_record_delete(id: i64) -> Result<(), ApiError>;
```

入参命名规则：05 §3 约束 1「入参一律为单对象」。Tauri 侧参数名用 `snake_case`，前端传 `{ rootId }` 时由 Tauri 的 camelCase↔snake_case 约定处理——**这一条属待验证项**（见 §13 判据 9），若实测不通，在 `lib.rs` 的 `invoke_handler` 上方统一加 `#[tauri::command(rename_all = "camelCase")]` 并在报告注明。

**事件（05 §4 / L215–L216 原文）**

```ts
"library://scan-progress": { rootId: number | null; phase: "walking" | "finalizing" | "done";
  scanned: number; added: number; updated: number; removed: number; error: ApiError | null }  // 200ms
"library://changed": { kinds: ("added" | "updated" | "removed")[]; documentIds: number[]; rootId: number | null } // 300ms 聚合
```

**本模块新增的内部接口（契约未定义，需在报告列出）**

```rust
// 与 M10 的缝合点；M10 就绪后由 jobs::JobOrchestrator 实现
pub trait IndexJobSink: Send + Sync {
    fn enqueue(&self, document_id: i64, kind: JobKind, priority: i32) -> Result<i64, ApiError>;
}
pub enum JobKind { Meta, Text, Reindex }   // 与 04 §3 indexing_jobs.kind CHECK 三值一致

// 扫描入口（供 Command 与 watcher 共用）
pub struct ScanRequest { pub root_id: Option<i64>, pub trigger: ScanTrigger }  // trigger: Manual | Watch | Startup
pub struct ScanStats { pub scanned: u32, pub added: u32, pub updated: u32, pub removed: u32 }
pub async fn run_scan(db: &Db, sink: &dyn IndexJobSink, req: ScanRequest, progress: &dyn ProgressSink) -> Result<ScanStats, ApiError>;

pub struct ScanStartResult { pub started: bool, pub reason: Option<String> }
```

**契约命名不一致（必须按 05 实现并在报告第 9 节提出）**：(a) 03 §2 M04 / L69 写 `document_delete_record`，05 §3 #12 / L183 为 `document_record_delete` → 以 05 为准；(b) 02 §5 时序图 / L155 写 `document_open_url(id)`，05 §3 #9 / L180 为 `document_url` → 以 05 为准。

## 9. 数据结构

| 名称 | 来源 | 关键点 |
|---|---|---|
| `LibraryRootDto` | 05 §2 / L69–L72 | `id, path, displayName, enabled, createdAt, lastScannedAt\|null` |
| `DocumentDto` | 05 §2 / L74–L83 | `hasProgress` = `EXISTS(reading_progress)`（05 §2 / L161 映射表）；`pageCount\|null` 由 M09 回填 |
| `DocumentDetailDto` | 05 §2 / L85–L92 | 额外 `absPath` 与 6 个 `pdf_*`、`indexErrorCode`/`indexErrorMsg`、`bookmarks`、`progress` |
| `DocumentQuery` | 05 §2 / L94–L101 | `limit` 上限 200（`E_INVALID_ARG`）；`sort` 四值、`order` 两值 |
| `DocumentSourceDto` | 05 §2 / L103 | `url, pageCount\|null, fileName` |
| `ScanProgressPayload` | 05 §4 / L215 | 与事件字段一一对应；`phase` 用 `snake_case` 枚举 |
| `LibraryChangedPayload` | 05 §4 / L216 | `kinds` 为去重后集合，`documentIds` 上限 500（超出只发前 500 条 + `warn!`，前端会重拉） |
| `DocFact`/`NewDocument` | M03 的 `DocumentRepo` | 行级事实，不跨模块暴露 |
| `ScanStats`/`ScanRequest`/`ScanStartResult` | 本模块 | 内部类型（§8） |

路径规范化唯一实现点：`src-tauri/src/library/paths.rs::normalize_abs()`，所有写库路径必须过它（先 `normalize_abs()` 再 `to_lowercase()` 得 `abs_path_key`；否则同一文件的不同写法会击穿唯一约束，见 R17）。

## 10. 文件组织

```text
src-tauri/src/library/
├── mod.rs            # 模块门面：pub use 命令与 run_scan
├── paths.rs          # normalize_abs / display_name_for / to_rel_path（+ 单测）
├── roots.rs          # library_root_* 三条命令的实现
├── walker.rs         # 递归遍历 + 忽略规则 + 符号链接策略 + 上限
├── scan.rs           # 差三分支判定、半写跳过、计数与 ScanStats
├── changes.rs        # 软删除/复活/rename/合并 的收口函数
├── watch.rs          # notify watcher + 800ms 聚合窗口 + 与扫描的互斥
├── events.rs         # 事件构造、200ms/300ms 节流器、phase 生命周期
├── commands.rs       # document_* 六条命令（薄层：校验 → 调 repo）
└── sink.rs           # IndexJobSink trait + LogOnlyJobSink（临时）
```

## 11. 实施步骤

1. **路径与库根**：`paths.rs` 先写单测（Windows 反斜杠、盘符大小写、尾部斜杠、`..`），再实现三条 `library_root_*`。判据：同一目录用三种写法添加，第二次起返回 `E_DB` 或复用唯一行（选其一并在报告说明），不会出现两行。
2. **遍历器**：`walker.rs` 产出 `(rel_path, abs_path, size, mtime_ms)` 流。判据：对一个含 `node_modules`/`.git`/符号链接的测试目录，输出中这三类均不出现。
3. **三分支增量**：`scan.rs` 接 `DocumentRepo`。判据：空库扫一次 → `added=N`；再扫一次 → `added=0, updated=0, removed=0`；`touch` 一个文件后再扫 → `updated=1`；删掉一个文件后再扫 → `removed=1` 且该行 `deleted_at` 非空。
4. **半写与损坏**：把一个文件 `mtime` 设为 `now` 后立即扫描 → 本轮不含它；把一个随机字节文件命名为 `.pdf` 入库 → 不崩溃（只入行，元数据由 M09 失败）。判据：两次扫描均无 panic，日志有记录。
5. **复活与合并**：软删一行后把文件放回原路径 → 扫一次，id 不变、`deleted_at` 为 NULL；把文件 A 移动到已存在的 B 路径 → 一行（B 的 id）、无 UNIQUE 冲突。判据：`SELECT count(*)` 与 id 断言。
6. **监控**：`watch.rs` + 800ms 聚合。判据：1 秒内对同一文件写 10 次 → 只产生 **1 次** `library://changed`（前端 listener 计数）与 1 轮增量扫描。
7. **命令接线与事件节流**：`commands.rs` + `events.rs`；`library_scan_start` 加 `E_BUSY`。判据：扫描进行中再调一次返回 `E_BUSY`（`retriable: true`）。
8. **`document_url` 与协议壳联通**：确认 `url` 形态可被 M01 的 `pdf://` handler 解析（`id` 与 `v`），并把 M01 的 `FixturePathResolver` 取代为查库实现（**这属于「接口需求」，需在报告第 8 节提出，由 Lead 允许后替换 M01 的占位实现**）。

## 12. 测试要求

Rust（`tests/library_*.rs`，用 `tempfile` 造目录树；PDF 样本可用任意字节序列，因本模块不解析）：

1. 三分支各一例（新增/更新/消失），断言 `ScanStats` 四个计数与库内行状态。
2. 重名文件：两个不同子目录同名 `a.pdf` → 两行，`rel_path` 不同；同一 `abs_path_key` 无法插入两行（`A.pdf` 与 `a.pdf` 在 Windows 上是同一文件，故 key 化后必然冲突）。
3. 同路径复活：软删后放回 → id 不变、`deleted_at IS NULL`、`text_state='pending'`。
4. rename/合并：`move` 到空路径 → 一行路径更新；`move` 到已有路径 → 一行（目标 id）+ `from` 行消失。
5. 无权限目录：用 `icacls` 造一个拒绝读取的子目录（Windows）→ 扫描返回/记录 `E_PERMISSION`，其余根照常完成，进程不崩溃（做不到造权限就写「未验证」并给命令）。
6. 半写跳过：`mtime = now` → 本轮 0 变更；把 `mtime` 拨回 3s 前再扫 → 变更 1。
7. 防抖：模拟 10 次连续写入 → 聚合窗口内只触发 1 次扫描（直接对聚合器单测，不必依赖真实文件系统事件）。
8. `E_BUSY`：并发两次 `library_scan_start` → 第二次 `E_BUSY`。
9. `document_list` 边界：`limit=201` → `E_INVALID_ARG`；`text` 含 `%` → 不当作通配符；空结果 `total=0, items=[]`。
10. `document_url`：返回串严格匹配 `^pdf://doc/\d+\?v=\d+$`；文件被删后调用 → `E_NOT_FOUND`。

命令：`cargo test --manifest-path src-tauri/Cargo.toml`、`cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`。

## 13. 验收标准

1. 三分支增量各一例通过（§12 用例 1，贴计数输出）。
2. 重名文件与同路径复活两例通过（用例 2、3，贴 id 断言）。
3. 无权限目录返回 `E_PERMISSION` 且不崩溃（用例 5；若无法构造权限，报告写「未验证」+ 命令）。
4. 损坏 PDF（改名后的随机字节）不崩溃：入行成功、`meta_state` 仍为 `pending`，失败由 M09 的 `kind='meta'` 任务体现（用例 4）。
5. 监控防抖：1 秒内 10 次改动只产生 **1 次** `library://changed`（用例 7，贴计数）。
6. 扫描期间重复调用返回 `E_BUSY` 且 `retriable === true`（用例 8）。
7. 事件节流可观测：一次全量扫描的 `library://scan-progress` 条数 ≤ `ceil(耗时/200ms)+1`，最后一条 `phase === "done"`。
8. `document_url` 返回 `pdf://doc/{id}?v={mtime_ms}`（用例 10 的正则断言），且该 URL 能被 M01 协议壳以 `206` 回应（联调用例，若 M04 阶段协议壳仍返回 fixture，则写「待联调」）。
9. `library_root_add` 对不存在路径返回 `E_INVALID_ARG`、对重复路径不产生第二行；前端传 `{ rootId }` 能到达 `root_id` 参数（若不能，按 §8 加 `rename_all = "camelCase"` 并在报告声明）。
10. 全模块无 SQL 字面量：`grep -rE "SELECT |INSERT |UPDATE |DELETE " src-tauri/src/library` 计数为 0。

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

1. 不得打开 PDF 读取页数/元数据/是否加密（03 §2 M04 / L64）；`page_count`、`pdf_*` 只能来自 M09。
2. 不得删除、移动或改写用户磁盘上的任何文件；`library_root_remove(purge: true)` 只删数据库行。
3. 不得在 `library/` 下写 SQL 或直接 `Connection::open`；一切读写经 M03 的 Repository。
4. 不得省略半写文件跳过与符号链接不跟随两条策略，也不得把 800ms 聚合窗口换成「每次事件立刻扫」。
5. 不得为了让 `library://changed` 计数看起来正确而人为合并/丢弃事件；也不得把节流做成「丢弃最后一条」（`phase="done"` 必须送达）。
6. 不得自行设计文献库列表的布局、卡片、排序控件或空状态文案——本节一律 `TODO(ui-confirm)` 并进报告的待确认清单。