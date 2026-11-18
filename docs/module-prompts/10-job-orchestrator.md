# 模块 M10：job-orchestrator（索引任务调度器）

> 依赖前置：M09 text-index（`index_pages`/`index_metadata`/`clear_document` 可用）、M03 database（`indexing_jobs` 表与 Repository、`documents` 聚合计数）、M02 contracts（`IndexStatusDto`、`ApiError`）。
> 被依赖方：M04 library（把 `kind='meta'`/`kind='text'` 任务投递给本模块）、M11 global-search（读 `index_status`）、M14 workspace-shell（消费进度事件与暂停开关）。
> 归属层：L0 Rust Core；并行组：B（M09 → M10 → M11，串行）。

## 1. 模块身份

M10 是**唯一**的任务调度者：它把「某个文档需要元数据/正文索引」这件事变成一条持久化 + 内存双写的作业，用固定并发上限在 `spawn_blocking` 线程里驱动 M09 的提取内核，并把状态、进度、终态以事件与 DTO 形式交给前端。
它不碰 PDF 字节，也不写任何检索表——它只决定「谁、什么时候、以什么优先级、跑多久、失败几次后放弃」。
它是崩溃恢复的唯一责任人：进程重启后，`indexing_jobs` 里 `running` 的行必须回到 `queued`，`documents.text_state='indexing'` 必须回到 `pending`（见 docs/04-database-design.md §6 第 178 行）。

## 2. 项目背景

## A. 项目背景

你在开发 **Legere**：一款**个人使用**的本地 PDF 文献库阅读器桌面应用（Tauri 2 + Rust 后端 + React/TS 前端）。它不是一个「PDF 查看器」，而是「文献库管理 + 全文检索 + 自定义阅读体验」三者的结合体。

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

交付一个可被验收的调度内核：**后台索引永不阻塞前台阅读，且崩溃后不留半截状态**。

1. 内存优先级队列与 `indexing_jobs` 持久化双写，任一时刻 DB 是恢复的唯一真源。
2. 「不抢占、主动让位」的前台优先（docs/02-system-architecture.md §9 第 277 行），提取并发上限 2（同文档 §9 第 272 行）。
3. 协作式取消、重试上限与退避、启动恢复三件事全部可测。
4. `index://progress`（≤4 次/秒）与 `index://job-finished` 两个事件按契约发送。
5. 五个 Command 全部落地：`index_enqueue` / `index_cancel` / `index_status` / `index_pause` / `index_rebuild_all`。

## 4. 功能范围（必须完成）

1. **队列**：`BinaryHeap<JobKey>`，`JobKey { priority: u8, seq: u64, job_id: i64 }`；`impl Ord` 写成反向比较，使 `pop()` 返回「priority 最小、seq 最小」的任务（0 级前台、先到先服务）。必须有一条单测覆盖 4 种入队顺序的出队顺序。
2. **双写**：入队 → `indexing_jobs` 落 `state='queued'` → 入堆；派发 → `state='running', started_at` → 出堆；结束 → `state ∈ {done,failed,canceled}` + `finished_at` + `error_code`/`error_msg`。**顺序固定：先写 DB 再改内存**，崩溃时以 DB 为准。
3. **priority 语义**：`0` = 前台（用户当前打开的文档），`10` = 后台（默认值，列默认值见 docs/04 §3 第 103 行）。`index_enqueue` 未传 `priority` 时取 10。
4. **后台让位**：每批之间检查两件事——(a) 全局 `paused` 是否为真；(b) 队列中是否存在 `priority < 当前任务 priority` 的 `queued` 任务。任一成立 → 当前任务**不失败**，回写 `state='queued'`、`attempts` 不增、重新入堆。这是「不抢占、主动让位」（docs/02 §9 第 277 行），不得用线程中断或抢占式取消实现。
5. **并发信号量**：提取并发上限 **2**（docs/02 §9 第 272 行），用 `tokio::sync::Semaphore`；permit 在派发前 acquire、在 `spawn_blocking` 结束（含错误与让位）后释放，任何路径都不得泄漏 permit（用 `OwnedSemaphorePermit` 交给闭包最稳）。
6. **协作式取消**：每个运行中任务持有一个 `Arc<AtomicBool>` 注册在 `HashMap<i64, CancelFlag>`；`index_cancel` 置位；M09 的 `on_batch` 回调读它并返回 `BatchOutcome::Stop`；终态为 `canceled`，不是 `failed`。
7. **重试与退避**：`attempts` 上限 **3**（第 3 次失败即终态 `failed`）；退避 `500ms × 2^(attempts-1)`，上限 8s；不重试的错误码：`E_PDF_NO_TEXT`、`E_PDF_ENCRYPTED`、`E_PDF_CORRUPT`、`E_PERMISSION`（docs/05 §1 第 44–53 行的 `retriable` 列）。`E_PDF_NO_TEXT` 走另一条路：直接置 `text_state='no_text'`，不重试（docs/02 §6 第 192 行）。
8. **启动恢复**：`UPDATE indexing_jobs SET state='queued' WHERE state='running'` 与 `UPDATE documents SET text_state='pending' WHERE text_state='indexing'`（docs/04 §6 第 178 行），然后从 DB 重建内存队列。恢复必须在 `app://ready` 之前完成，或至少在第一个任务派发之前完成。
9. **`index://progress`**：payload 为 `IndexStatusDto`（docs/05 §2 第 116–122 行），节流 **250ms**（docs/05 §4 第 217 行，≤4 次/秒）；节流窗口内多次状态变化只保留最后一次快照，窗口结束必发一个「尾包」，保证前端最终收敛。
10. **`index://job-finished`**：每任务恰好一次，payload 见 docs/05 §4 第 218 行；`documents.text_state` 的落库在发事件**之前**完成。
11. **五个 Command**：`index_enqueue`（返回 `{ jobId }` —— 见 §8 签名）、`index_cancel`、`index_status`、`index_pause`、`index_rebuild_all`；参数与返回严格按 docs/05 §3 第 184–188 行。
12. **重建**：`index_rebuild_all{ rootId? }` 清空 `page_fts` 与 `page_text`、所有未删除文档置 `text_state='pending'`、全量入队，然后立即返回 `{ started: true }`（docs/04 §6 第 180 行）；重建进行中重复调用 → `E_BUSY`（docs/05 §3 第 188 行）。
13. **状态快照**：`queued`/`running` 来自内存队列 + DB；`documentsIndexed/Pending/Failed/NoText` 来自 `documents` 聚合计数（docs/05 §2 第 164 行「内存调度器快照 + documents 聚合计数」）。
14. **停机**：应用退出时停止派发、把运行中任务回写 `state='queued'`（不等待提取完成），保证下次启动可恢复。

## 5. 非目标（明确不做）

### 5.0 已由 Lead 裁决的技术参数（**不再询问，按此实现**）

以下条目曾标为「待你确认」，但属技术参数且**已由 Lead 按官方文档与工程判断裁决**：**T17 T23** —— 明细与理由见 `docs/14-ui-decision-register.md` §1 对应行。实现时直接落该值，**不得**再当作待确认项停下来问；若你认为某条在本模块不成立，在交付报告 §9 提出并说明，不要自行改动。

1. **不解析 PDF、不提取文本、不分词、不写 `page_text`/`page_fts`** —— 一律调用 M09 的 `index_pages`/`index_metadata`/`clear_document`（docs/03 §2 M10 卡第 129–130 行）。
2. **不写检索 SQL、不做 `MATCH`/`bm25`/聚合分页** —— 归 M11。
3. **不扫描目录、不判增量、不建 `documents` 行** —— 归 M04；本模块只接收 `document_id`。
4. **不做数据库迁移、不建表** —— 归 M03。
5. **不实现 `reindex` 的语义差异之外的分支**：`kind` 三种取值的含义由本模块决定并记录（见 §9 第 4 条），不得新增第四种。
6. **不得自行确定视觉方案**：进度、暂停、取消、重建的界面呈现全部归 M14；本模块只出事件与 DTO，不出任何尺寸/颜色/动效。
7. 不做「索引失败自动后台无限重试」，也不做「索引时把 PDF 复制到临时目录」。

**索引失败展示形式（A5 已裁决，不留 TODO）**

用户原话：「给出提示即可。」实现要求：终态仍必须写 `index_error_code` / `index_error_msg` 并发 `index://job-finished`（供诊断与日志）；但**不为失败原因做任何逐条列表或详情面板**，UI 侧只渲染一条汇总提示（`docs/16-copy-deck.md §3`「索引失败」行）。

**本模块【待你确认】清单（实现时留 `TODO(ui-confirm)` 并写入交付报告 §6）**

1. 暂停/恢复入口放在哪里（设置面板 / 文献库页顶栏 / 二者都有）——M10 只提供 `index_pause`，位置属 M14。
2. 索引进度的呈现粒度（全局一条 / 每文档一条）——`IndexStatusDto.current` 只给一个文档，是否够用需用户确认。
3. 取消「正在运行」的任务是否需要二次确认（UI 行为，影响 M14 与 M11 的取消按钮语义）。
4. `index_rebuild_all` 进行中的全局提示形态（是否阻塞文献库操作）。

## 6. 架构约束

- **只能依赖**：`index`（M09 的公开函数）、`db`（M03 的 Repository）、`contracts`（M02 的 DTO/错误码）、`tokio`、`tracing`、`tauri` 的 `AppHandle`（仅用于 `emit`）。**不得依赖**：`search`（M11）、`library`（M04）的具体实现（只接受 `document_id`，路径由本模块经 M03 的 `DocumentRepo` 查 `abs_path`）。
- **只调度，不解析**：本模块源码内不得出现任何 PDF 解析调用；提取只经 M09。**不写 `page_fts`**：`rg -n "page_fts|page_text" src-tauri/src/jobs` 必须为 0 命中（注释除外），这是一条可自动检查的边界线。
- **不得占用 tokio async 线程做 CPU 工作**：所有提取必须在 `tokio::task::spawn_blocking` 内执行（docs/02 §9 第 272 行）；async fn 只做 acquire/await/DB 短写/emit。单次 DB 写 < 50ms（同文档 §9 第 271 行）。
- **状态归属**：`indexing_jobs.state` 由本模块独占；`documents.text_state` 本模块只在「任务终态」时写 `indexing`/`indexed`/`no_text`/`failed` 四个值，`pending` 的初值归 M04。`documents.meta_state` 由 `kind='meta'` 任务的终态写。
- **错误出口**：所有跨 IPC 的错误必须是 `ApiError`（docs/05 §1）；领域错误用 `thiserror` 定义 `JobError` 并在 Command 层转换，禁止把 `anyhow` 字符串抛给前端。
- **不负责清单**：文本正确性、分词质量、检索相关度、PDF 兼容性、库根扫描、UI 呈现。

## 7. 输入与输出

| 输入来源 | 数据形态 | 触发时机 |
|---|---|---|
| M04 / M07（经 `index_enqueue`） | `{ documentId, priority? }` | 新文档入库、文件变更、用户打开未索引文档 |
| M04（进程内调用） | `EnqueueRequest { document_id, kind, priority }` | 扫描/监控发现变更（与 Command 同一入口） |
| 前端 | `index_cancel / index_pause / index_rebuild_all / index_status` | 用户操作与轮询 |
| 进程启动 | `indexing_jobs` 现有行 | 恢复 |
| M09 | `IndexSummary` / `IndexError` / `BatchOutcome` | 每次 `index_pages` 返回与每批回调 |

| 输出目标 | 数据形态 | 消费方 |
|---|---|---|
| SQLite `indexing_jobs` | 状态流转行 | 恢复、`db_integrity_check`、验收断言 |
| `documents.text_state` / `meta_state` / `page_count` | 单列更新 | M04 列表、M14 主页 |
| `index://progress` | `IndexStatusDto` | M14 / M11 的进度条 |
| `index://job-finished` | `{ jobId, documentId, state, error }` | M14 的「索引完成」提示、M11 刷新结果 |
| `index_status` 返回值 | `IndexStatusDto` | 前端首屏拉取（事件只是通知，docs/05 §4 规则 2） |

## 8. 接口契约

五个 Command（入参/返回/错误码逐字取自 docs/05-api-contracts.md §3 第 184–188 行）：

```text
index_enqueue      { documentId: number, priority?: number } -> { jobId: number }   E_NOT_FOUND
index_cancel       { jobId: number }                          -> void               E_NOT_FOUND
index_status       —                                          -> IndexStatusDto     E_DB
index_pause        { paused: boolean }                        -> void               —
index_rebuild_all  { rootId?: number }                        -> { started: boolean }  E_BUSY, E_DB
```

两个事件（docs/05 §4 第 217–218 行）：`index://progress` payload = `IndexStatusDto`；`index://job-finished` payload = `{ jobId, documentId, state: "done"|"failed"|"canceled", error: ApiError | null }`。

进程内接口（供 M04 与命令层共用，Rust 内部）：

```rust
// src-tauri/src/jobs/mod.rs
pub fn init(app: AppHandle) -> Result<(), JobError>;          // 启动恢复 + 起调度循环
pub fn enqueue(req: EnqueueRequest) -> Result<i64, JobError>; // 返回 job_id
pub fn cancel(job_id: i64) -> Result<(), JobError>;
pub fn status() -> Result<IndexStatusDto, JobError>;
pub fn set_paused(paused: bool);
pub fn rebuild_all(root_id: Option<i64>) -> Result<(), JobError>;
pub fn shutdown();                                            // 停止派发并把 running 回写 queued
```

参数命名映射（camelCase ↔ snake_case）必须照抄 M01/M02 已注册的 Command 写法，**不得**在本模块自定另一套映射。

**附注（已由 Lead 裁决为 R11，03 已同步修订，不必再报缺口）**：`docs/05 §3 第 187 行` 只定义 `index_pause { paused: boolean }`。实现 `index_pause`，**不新增 `index_resume`**（新增 Command = 架构变更）；恢复通过 `index_pause { paused: false }` 完成。

## 9. 数据结构

1. **`indexing_jobs`**（docs/04 §3 第 99–115 行，列名逐字）：`id, document_id, kind, priority, state, attempts, error_code, error_msg, enqueued_at, started_at, finished_at`。索引 `idx_jobs_state(state, priority, enqueued_at)` 正好服务「取最高优先级」查询。
2. **`state` 取值**：`queued | running | done | failed | canceled`（同表 CHECK）。让位**不**引入新状态，回 `queued`。
3. **`IndexStatusDto`** 字段（docs/05 §2 第 116–122 行）：`paused, workers, queued, running, documentsIndexed, documentsPending, documentsFailed, documentsNoText, current{ documentId, pageNo, totalPages } | null`。`workers` = 信号量上限（2，常量，不做用户可配）。
4. **`kind` 语义**（本模块决定并记录，契约只给了取值枚举）：
   - `'meta'` → 调 M09 `index_metadata`，写 `documents.page_count` 与 `pdf_*` 七列，终态写 `meta_state='ok'|'failed'`。
   - `'text'` → 调 M09 `index_pages`，写 `page_text`/`page_fts`，终态写 `text_state`。
   - `'reindex'` → 先 M09 `clear_document` 再按 `'text'` 执行（用于内容变更与手动重建）。
   - `index_enqueue` 不暴露 `kind`（docs/05 §3 第 184 行无该参数）：调度器按文档当前状态决定：`meta_state='pending'` 先入 `'meta'`，随后入 `'text'`。
5. **`JobKey`** 与比较方向：`(priority, seq)` 升序出队；`seq` 为进程内单调递增计数器，用于同优先级先到先服务（`enqueued_at` 只到秒/字典序，不足以区分）。
6. **`CancelFlag`**：`Arc<AtomicBool>`，注册表在任务终态时移除；`Ordering::SeqCst` 足够，不引入锁。

## 10. 文件组织

```text
src-tauri/src/jobs/mod.rs          # init/enqueue/cancel/status/set_paused/rebuild_all/shutdown 门面
src-tauri/src/jobs/queue.rs        # JobKey、BinaryHeap 封装、seq 计数器
src-tauri/src/jobs/dispatcher.rs   # 主循环：acquire permit -> spawn_blocking -> 终态
src-tauri/src/jobs/lane.rs         # 单任务执行：调 M09、批间让位/取消判定、错误分类
src-tauri/src/jobs/retry.rs        # 重试上限与退避计算（纯函数，可单测）
src-tauri/src/jobs/progress.rs     # 250ms 节流器 + IndexStatusDto 快照组装
src-tauri/src/jobs/recovery.rs     # 启动恢复两条 UPDATE + 队列重建
src-tauri/src/jobs/commands.rs     # 五个 #[tauri::command]（薄层：校验 + 转换 + 调门面）
src-tauri/src/jobs/error.rs        # JobError + ApiError 映射
src-tauri/tests/jobs_integration.rs# 真实 sqlite + 临时 PDF 的集成测试
```

本目录只属于 M10（docs/03 §4 第 218 行）。允许在 `src-tauri/src/lib.rs` 追加**注册行**（docs/03 §4 第 211 行要求：仅追加并在交付报告声明），不得改其他模块文件。

## 11. 实施步骤

**S0 前置确认**：读 M03 的 `IndexJobRepo`（入队/取队/状态更新）与 `DocumentRepo`（查 `abs_path`、按 `text_state` 聚合计数）签名；读 M09 的 `index_pages` 回调签名。缺方法 → 交付报告 §8 写「接口需求」，不得自写 SQL 绕过（docs/02 §3 第 110 行）。
**S1 队列**：`queue.rs` + 4 条排序单测。落点 `cargo test jobs::queue` 全绿。
**S2 恢复**：`recovery.rs`。落点：造一条 `state='running'` 的作业与一个 `text_state='indexing'` 的文档，启动后两者分别变 `queued`/`pending`。
**S3 派发**：`dispatcher.rs` + 信号量 + `spawn_blocking`。落点：3 个后台任务串行执行完，日志显示并发不超过 2。
**S4 让位**：`lane.rs` 的批间判定。落点：S3 之后插入一个 `priority=0` 任务，DB 中它的 `started_at` 早于剩余后台任务。
**S5 取消**：`index_cancel`。落点：取消一个 40 页任务后 `state='canceled'` 且 `page_text` 行数是 8 的倍数。
**S6 重试与终态**：`retry.rs` + 错误分类。落点：模拟 `E_IO` 连续失败 3 次 → `failed`，`attempts=3`；模拟 `E_PDF_NO_TEXT` → `no_text` 且 `attempts=1`。
**S7 事件与节流**：`progress.rs`。落点：用一个 fake emitter 计数，2 秒内 ≤8 次，且末态必有一个尾包。
**S8 命令**：`commands.rs` + 注册行。落点：前端 `invoke` 五个命令各返回值符合 docs/05 §3。
**S9 重建与停机**：`rebuild_all` + `shutdown`。落点：重建后 `page_text` 为 0 行且 `text_state` 全 `pending`；退出后 DB 无 `running`。

## 12. 测试要求

单元（不需要文件）：队列排序 4 例、退避计算 4 例（attempts 1/2/3 与非重试码）、错误码 → 是否重试的真值表（覆盖 docs/05 §1 全部 12 个码）、节流器时间窗口（用注入的 `Instant`/假时钟）、`IndexStatusDto` 组装（含 `current` 为 null 的分支）。

集成（真实 sqlite 临时库 + 临时 PDF）：恢复、让位、取消、重试、重建、无 permit 泄漏（50 个任务后 `Semaphore::available_permits() == 2`）。

命令：

```bash
cargo test --manifest-path src-tauri/Cargo.toml jobs::
cargo test --manifest-path src-tauri/Cargo.toml --test jobs_integration -- --nocapture
rg -n "page_fts|page_text" src-tauri/src/jobs   # 期望：0 命中（注释除外）
```

## 13. 验收标准

1. **前台插队**：先入 5 个 `priority=10` 的各 40 页任务，等第 1 个开始后立即入 1 个 `priority=0` 任务。判据：`SELECT document_id, started_at FROM indexing_jobs ORDER BY started_at` 中该前台任务的 `started_at` 早于其后 4 个后台任务，且「入队 → 开始」间隔 < 1000ms（从 `enqueued_at` 与 `started_at` 计算）。日志顺序作为第二证据。
2. **取消**：`index_cancel` 后 ≤2000ms，该 `jobId` 的 `state='canceled'`，`index://job-finished` 收到 `state: "canceled"`，且 `SELECT COUNT(*) FROM page_text WHERE document_id=?` 为 8 的倍数（无半页残留）。
3. **崩溃恢复**：任务运行中强杀进程（`Stop-Process -Name legere -Force` 或 `taskkill /F /IM legere.exe`），重启后：`SELECT state FROM indexing_jobs WHERE id=?` = `queued`；`SELECT COUNT(*) FROM documents WHERE text_state='indexing'` = 0；`page_text` 行数为 8 的倍数。
4. **进度频率**：对单个任务采集 2 秒事件流，事件数 ≤ 8 且相邻间隔 ≥ 250ms（留 5% 抖动余量），结束时必有尾包（最后一次 payload 的 `current` 与该任务终态一致）。
5. **无内存增长**：连续 50 个任务后，内部计数（队列长度 0、注册表长度 0、`available_permits()==2`）回到基线；进程 WorkingSet 两次读数（`(Get-Process -Name legere).WorkingSet64`）增长 < 20MB，并把实测值写进报告。
6. **边界**：`rg -n "page_fts|page_text" src-tauri/src/jobs` 为 0 命中；`rg -n "spawn\(" src-tauri/src/jobs` 只出现 `spawn_blocking`。
7. 五个 Command 的错误码与 docs/05 §3 第 184–188 行一致（`index_cancel` 传不存在的 jobId → `E_NOT_FOUND`）。

## 14. 交付报告

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

报告只写事实。没有验证的事情写「未验证」。

## 15. 禁止事项

## H. 禁止事项（任一项出现即视为交付失败）

1. 修改其他模块的文件或接口契约（见 03 的文件归属矩阵）。
2. 引入未经批准的架构变更或新的大型依赖。
3. 为通过验收而伪造实现、硬编码返回值、把未实现功能写成已完成。
4. 删除或破坏已有测试；降低既有断言以"通过"。
5. 长时间保留 mock 数据源而不接真实接口。
6. 越界实现其他模块职责（宁可返回"需要 M0x 提供"也不要自己造）。
7. 用 `display:none` 等手段"隐藏"本该完全不渲染的节点。

本模块追加：

1. 不得在本模块内调用任何 PDF 解析/文本提取 API；只允许调 `index::index_pages` / `index::index_metadata` / `index::clear_document`。
2. 不得写入 `page_text`/`page_fts`（含"顺手补一行"），不得出现这两个表名（`docs/02 §6第 209 行` 的 rowid 绑定只能由 M09 经 M03 Repository 完成）。
3. 不得新增 `index_resume` 或其他 Command；不得改 `IndexStatusDto` 字段（docs/05 §2 第 116–122 行是冻结契约）。
4. 不得用 `std::thread::spawn` / `tokio::task::spawn` 包裹 CPU 工作以规避 `spawn_blocking`，也不得在 async fn 内直接调 `index_pages`。
5. 不得把「索引失败」静默丢弃：每次终态必须写 `error_code`/`error_msg` 并发 `index://job-finished`。
6. 不得让节流器吃掉尾包（前端必须能看到最终状态），也不得用 `sleep` 轮询实现节流。
