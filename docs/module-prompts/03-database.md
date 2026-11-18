# 模块 M03：database

> 依赖前置：M02 contracts（`ApiError`/`ApiErrorCode`/全部 DTO 已冻结）。
> 被依赖方：M04 library、M09 text-index、M10 job-orchestrator、M11 global-search、M12 bookmarks-progress、M13 theme-settings。M03 之后才允许并行组 A–D 开工（03 §3）。
> 归属层：L0 Rust Core；并行组：串行主链第三环（`M01 -> M02 -> M03`），无并行伙伴。

## 1. 模块身份

M03 是唯一允许出现 SQL 的模块：它拥有 SQLite 连接的打开与 PRAGMA、`schema_migrations` 与版本化迁移、8 张表 + `page_fts` 虚表的落库、各表 Repository、FTS5 能力探针与降级分支、以及一致性维护（级联清理/自检/重建）。

数据流上它是全部持久层的终点：Command 层不写 SQL（02 §3 文字说明第 4 段「数据库只被 Repository 访问」），上层模块拿到的永远是 `*Dto`。它同时决定 `app_info` 的 `ftsEnabled`/`contentlessDelete` 两个字段的真值（05 §3 #2 归属 M01/M03）。

它不扫描文件系统、不提取 PDF 文本、不分词、不生成用户文案（03 §2 M03「不负责」）。

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

交付一个「迁移幂等、级联正确、FTS 与 page_text 严格同事务、写不堵读」的持久层，并让 `db_integrity_check` 在健康库上返回全零。

1. 库可打开：PRAGMA 五条按 04 §2 生效，WAL + 外键 + `busy_timeout`。
2. 迁移可重复执行：空库/旧库都能升到最新且不重复插入版本行（04 §5）。
3. 结构完整：`docs/04` §3 的 DDL 逐表落地，行名/列名/CHECK 约束一字不改。
4. Repository 可用：8 个 trait 覆盖 M04/M09/M11/M12/M13 的直接读写需求。
5. FTS5 能力已探明：V-03 探针执行并落 `DbCapabilities`，两分支都跑通测试（02 §11 D10）。
6. 一致性可控：`db_integrity_check`（05 §3 #28）+ 四类维护事务（04 §6）可调用。

## 4. 功能范围（必须完成）

F-01 连接与 PRAGMA：按 04 §2 / L15–L20 顺序执行 `journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`、`synchronous=NORMAL`。注意两处真实约束（实现前先用探针确认，不符则按注释落）：`journal_mode`/`synchronous` 必须在事务外设置；`foreign_keys` 在事务内设置是无效操作，因此放在连接建立后立即执行。

F-02 单写多读：`WriteQueue` 持有一个写连接并把所有写操作串行化（04 §2 / L22）；只读侧提供 N 个连接（N=3，可配置）。只读连接策略要先探针确认（自设探针 P-01，非 V 清单项）：WAL 下以 `SQLITE_OPEN_READ_ONLY` 打开是否成功；若出现 `SQLITE_READONLY_CANTINIT`/`SQLITE_CANTOPEN`，改为可写连接 + `PRAGMA query_only=ON`。两种结论都必须写进报告。

F-03 迁移加载：`src-tauri/migrations/001_init.sql` 保存 04 §3 完整 DDL（逐字，含缩进不影响语义但列定义不得改动）；`src-tauri/src/db/migrations.rs` 用 `include_str!` 嵌入，维护 `const MIGRATIONS: &[(i32, &str, &str)]`；启动流程按 04 §5 / L167：读 `schema_migrations.max(version)` → 按序执行未应用文件（**每个文件一个事务**，同一事务内插入版本行）→ 失败则整体回滚并返回 `E_DB`。迁移只增不改（04 §5 / L168）。

F-04 DDL 落地顺序（必须按此顺序建，外键才能成立）：`schema_migrations` → `library_roots`（04 §3 / L34–L41）→ `documents` + 4 个索引（L44–L76）→ `page_text` + 索引（L79–L88）→ `page_fts` 虚表（L91–L96）→ `indexing_jobs` + 2 索引（L99–L115）→ `bookmarks` + 索引（L118–L129）→ `reading_progress`（L132–L140）→ `app_settings`（L143–L147）。`page_fts` 的 DDL 由 F-05 的探针结果二选一。

F-05 FTS5 探针与降级（V-03）：启动时在**临时库**上执行 02 §1 / L32 的探针 SQL——`CREATE VIRTUAL TABLE t USING fts5(a, content='', contentless_delete=1)`——捕获结果；`CREATE` 成功即 `contentless_delete = true`，失败则再探 `content=''` 单特性，最终落 `DbCapabilities { fts5, contentless_delete }` 并 `info!` 记录结论。降级分支按 04 §4 / L160：`contentless_delete` 不可用时建 `CREATE VIRTUAL TABLE page_fts USING fts5(seg_text, tokenize='unicode61 remove_diacritics 2')`（同列、去掉 `content=''` 与 `contentless_delete`），Repository 内部按 `DbCapabilities` 选择分支，**上层无感知**。探针结果同时供 `app_info` 的 `ftsEnabled`/`contentlessDelete` 使用。

F-06 Repository 清单（8 个 trait，签名见 §8）：`LibraryRootRepo`、`DocumentRepo`、`PageTextRepo`、`FtsRepo`、`JobRepo`、`BookmarkRepo`、`ProgressRepo`、`SettingsRepo`。实现体一律接收 `&Transaction`（写）或 `&Connection`（读），不自己开事务；事务边界由调用方（M03 的复合操作或上层模块）持有。

F-07 复合操作（跨表，必须同事务）：`insert_page_with_fts`（写 `page_text` 取 `id`，再以同一 id 作 `page_fts.rowid` 写 `seg_text`）；`delete_document_index`（**先** `DELETE FROM page_fts WHERE rowid=?` 逐条，**再** `DELETE FROM page_text WHERE document_id=?`）；`delete_document_record`（再显式删 FTS → 删 `documents` 行，靠外键级联清 `page_text`/`bookmarks`/`reading_progress`/`indexing_jobs`）；`purge_library_root`。四处依据：04 §6 / L176–L177 与 04 §4 / L158（rowid 复用会串号）。

F-08 一致性维护四类事务（04 §6 / L172–L180）：删除文档记录（同 F-07）、文档内容变更（清全部 FTS 行 + `page_text` 行并把 `text_state` 置 `'pending'`）、索引中断恢复（`UPDATE documents SET text_state='pending' WHERE text_state='indexing'`；`UPDATE indexing_jobs SET state='queued' WHERE state='running'`）、重建索引准备（清空 `page_fts` 与 `page_text`，未删除文档置 `pending`，由 M11 的 `index_rebuild_all` 调用）。

F-09 `app_settings` 读写：`get_all() -> SettingsMapDto`（`Record<string,string>`，05 §2 / L148），`set(key, value)` 幂等 upsert（`updated_at` 用 UTC ISO-8601）；读取的 JSON 解析失败不抛错、由调用方用默认值兜底（04 §4 / L162）。

F-10 `db_integrity_check`（05 §3 #28 / L199）：返回 `{ ftsRows, pageTextRows, orphanPages, mislabeledDocuments }`——前三者为计数（`orphanPages` = `page_text` 中 `document_id` 不存在于 `documents` 的行数），`mislabeledDocuments` = `text_state='indexed'` 但该文档无任何 `page_text` 行的 `document.id` 数组。**只报告不修复**（04 §6 / L179）。

F-11 命令注册：`db_integrity_check` 在 `src-tauri/src/lib.rs` 的 `generate_handler![…]` 中**追加一行**（03 §4 / L211：允许「注册一行」方式追加，须在报告声明）；同时把 `app_info` 的 `DbCapabilities` 注入 `OnceLock`。

F-12 `db_reset`：按 04 §5 / L170 只在 debug 构建编译（`#[cfg(debug_assertions)]`）。**注意契约缺口**：05 §3 的 28 条 Command 不含 `db_reset`，因此它不得进入 `CMD`/`COMMAND_NAMES` 集合（否则 M02 的集合比对会失败）；在报告第 9 节记录该缺口。

## 5. 非目标（明确不做）

### 5.0 已由 Lead 裁决的技术参数（**不再询问，按此实现**）

以下条目曾标为「待你确认」，但属技术参数且**已由 Lead 按官方文档与工程判断裁决**：**T6 T7** —— 明细与理由见 `docs/14-ui-decision-register.md` §1 对应行。实现时直接落该值，**不得**再当作待确认项停下来问；若你认为某条在本模块不成立，在交付报告 §9 提出并说明，不要自行改动。

1. 不扫描文件系统、不判定文件存在性、不算 mtime 差异（属 M04）。
2. 不提取 PDF 文本、不分词、不生成 `seg_text`（属 M09）——本模块只接收已分词的字符串并写库。
3. 不构造 FTS `MATCH` 表达式、不做 bm25 排序、不算上下文窗口（属 M11）；`FtsRepo` 只提供「按 rowid 增删」与「全表清空」。
4. 不实现 `index_*`、`library_*`、`document_*`、`search_*`、`bookmark_*`、`progress_*`、`settings_*` 这些 Command（分别是 M04/M10/M11/M12/M13 的注册职责），只提供 Repository。
5. 不生成任何面向用户的中文提示文案；`ApiError.message` 由调用方填（本模块只给 `code` + 技术 `detail`）。
6. 不写 UI、不做设置面板、**不得自行确定视觉方案**。
7. 不做数据库压缩、加密、分库或远程同步（D12：单实例单用户）。

7. 不得自行确定视觉方案；下面这份清单在本模块一律只留 `TODO(ui-confirm)` 占位，并在报告第 6 节逐条列出。

**本模块【待你确认】清单（不得自行选择）**

1. 【待你确认】迁移失败「只读降级」的提示位置与文案（04 §5 / L169 要求在 UI 顶部显示 `E_DB`）——属 M14 界面，建议本模块只返回 `E_DB` 并记日志。
2. 【待你确认】`db_reset` 是否需要 debug 可见的 UI 入口——建议不提供，只保留命令行/测试调用。
3. 【待你确认】只读连接数 N 的默认值是否可配（当前建议固定 3）——建议固定，不做设置项。
4. 【待你确认】慢查询阈值与日志级别（建议 >50ms 记 `warn!`）。

## 6. 架构约束

- 允许依赖：M02 的 `contracts::*`（DTO/错误码）、`rusqlite`（`bundled` feature，04 §1 技术栈由 02 §1 固定）、`tokio`、`serde_json`、`tracing`。
- 不允许依赖：`src-tauri/src/{library,index,jobs,search,aux}` 与任何前端类型（03 §4；02 §2 规则 4）。`db/` 被上述模块引用，反向引用即循环依赖。
- 接口所有权：`src-tauri/src/db/**` 与 `migrations/**` 归 M03 独占（03 §4 / L214）；`lib.rs` 只能追加注册行。
- 状态归属：连接池、`WriteQueue`、`DbCapabilities`、迁移版本号都归 M03；其他模块**不得**自行 `Connection::open`。
- 资源所有权：所有写入必须经 `WriteQueue` 提交；只读连接按需借出并归还，不跨 `await` 长时间持有 `rusqlite::Connection`（它非 `Sync` 语义上按句柄独占）——跨 `await` 的用法一律走 `spawn_blocking`。
- 不负责清单与边界线：本模块结束于「库 + Repository + 探针 + 自检」；「什么时候写」由 M04/M09/M10 决定。

## 7. 输入与输出

| 输入来源 | 数据形态 | 触发时机 |
|---|---|---|
| M02 契约 | `*Dto`、`ApiError` | 编译期 |
| 上层模块 | 行级参数（`document_id`、`page_no`、已分词串） | 每次写入 |
| 文件系统 | 数据库文件路径（`app_data_dir()/legere.db`） | 启动 |
| 迁移文件 | `migrations/*.sql` 文本（`include_str!`） | 启动 |

| 输出目标 | 数据形态 | 消费方 |
|---|---|---|
| 上层模块 | `PageDto<DocumentDto>` 等 DTO | M04/M09/M11/M12/M13 |
| 上层模块 | `DbCapabilities` | M01 `app_info`、M11 查询分支 |
| 命令面 | `db_integrity_check` 返回值 | 前端诊断入口 |
| 日志 | 迁移版本、探针结论、慢查询（>`50ms` 记 `warn!`） | 开发者 |

## 8. 接口契约

**Command（05 §3 #28 / L199 原文）**：`db_integrity_check` — 入参 `—`，返回 `{ ftsRows: number, pageTextRows: number, orphanPages: number, mislabeledDocuments: number[] }`，错误码 `E_DB`，归属 M03。

**核心类型**

```rust
pub struct Db { /* WriteQueue + 只读连接池 + path + capabilities */ }
pub struct DbCapabilities { pub fts5: bool, pub contentless_delete: bool }   // 03 §2 M03 输出项

impl Db {
    pub fn open(path: &std::path::Path) -> Result<Self, ApiError>;   // PRAGMA + 探针 + 迁移
    pub fn capabilities(&self) -> DbCapabilities;
    pub fn write<T>(&self, f: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<T, ApiError>) -> Result<T, ApiError>;
    pub fn read<T>(&self, f: impl FnOnce(&rusqlite::Connection) -> Result<T, ApiError>) -> Result<T, ApiError>;
    pub fn integrity_check(&self) -> Result<IntegrityReport, ApiError>;
}
```

**Repository trait（契约缺口说明：03 §2 M03 / L58 写「对外接口：见 05 §3 Repository Trait 清单」，但 05 §3 是 Command 注册表、并无 trait 定义。因此下列签名由本模块定义，M04/M09/M11/M12/M13 只能依赖它们；交付报告第 9 节必须提出该缺口。）**

```rust
pub trait LibraryRootRepo {                       // 04 §3 library_roots
    fn list(&self, c: &Connection) -> Result<Vec<LibraryRootDto>, ApiError>;
    fn get(&self, c: &Connection, id: i64) -> Result<LibraryRootDto, ApiError>;      // 无 → E_NOT_FOUND
    fn add(&self, tx: &Transaction<'_>, path: &str, display_name: &str) -> Result<LibraryRootDto, ApiError>;
    fn remove(&self, tx: &Transaction<'_>, id: i64, purge: bool) -> Result<(), ApiError>;
    fn set_enabled(&self, tx: &Transaction<'_>, id: i64, enabled: bool) -> Result<(), ApiError>;
    fn set_last_scanned_at(&self, tx: &Transaction<'_>, id: i64, at: &str) -> Result<(), ApiError>;
}

pub trait DocumentRepo {                           // 04 §3 documents
    fn list(&self, c: &Connection, q: &DocumentQuery) -> Result<PageDto<DocumentDto>, ApiError>;
    fn get_detail(&self, c: &Connection, id: i64) -> Result<DocumentDetailDto, ApiError>;
    fn recent(&self, c: &Connection, limit: i64) -> Result<Vec<DocumentDto>, ApiError>;
    fn touch_opened(&self, tx: &Transaction<'_>, id: i64, at: &str) -> Result<(), ApiError>;
    fn facts_by_root(&self, c: &Connection, root_id: i64) -> Result<Vec<DocFact>, ApiError>;
    fn find_by_abs_path_key(&self, c: &Connection, abs_path_key: &str) -> Result<Option<DocFact>, ApiError>;  // R17
    fn find_by_rel_path_key(&self, c: &Connection, root_id: i64, rel_path_key: &str) -> Result<Option<DocFact>, ApiError>;  // R17
    fn insert_found(&self, tx: &Transaction<'_>, n: &NewDocument<'_>) -> Result<i64, ApiError>;
    fn update_facts(&self, tx: &Transaction<'_>, id: i64, size_bytes: i64, mtime_ms: i64, at: &str) -> Result<(), ApiError>;
    fn revive(&self, tx: &Transaction<'_>, id: i64, at: &str) -> Result<(), ApiError>;   // 清 deleted_at
    fn move_to_root(&self, tx: &Transaction<'_>, id: i64, root_id: i64, rel_path: &str, rel_path_key: &str, abs_path: &str, abs_path_key: &str, at: &str) -> Result<(), ApiError>;  // R17
    fn merge_into(&self, tx: &Transaction<'_>, from_id: i64, to_id: i64) -> Result<(), ApiError>;  // 04 §4 / L154 合并
    fn soft_delete(&self, tx: &Transaction<'_>, id: i64, at: &str) -> Result<(), ApiError>;
    fn set_states(&self, tx: &Transaction<'_>, id: i64, meta: MetaState, text: TextState) -> Result<(), ApiError>;
    fn set_page_count_and_meta(&self, tx: &Transaction<'_>, id: i64, page_count: Option<i64>) -> Result<(), ApiError>;
    fn reset_indexing_to_pending(&self, tx: &Transaction<'_>) -> Result<usize, ApiError>;
}

pub trait PageTextRepo {                           // 04 §3 page_text
    fn page_ids(&self, c: &Connection, document_id: i64) -> Result<Vec<i64>, ApiError>;
    fn raw_text(&self, c: &Connection, document_id: i64, page_no: i64) -> Result<Option<String>, ApiError>;
    fn count_for_document(&self, c: &Connection, document_id: i64) -> Result<i64, ApiError>;
    fn count_all(&self, c: &Connection) -> Result<i64, ApiError>;
}

pub trait FtsRepo {                                // 04 §3 page_fts（含跨表复合操作）
    fn insert_page_with_fts(&self, tx: &Transaction<'_>, document_id: i64, page_no: i64,
                            raw_text: &str, seg_text: &str) -> Result<i64, ApiError>;   // 返回 page_text.id == page_fts.rowid
    fn delete_document_index(&self, tx: &Transaction<'_>, document_id: i64) -> Result<usize, ApiError>; // 先 FTS 后 page_text
    fn clear_all(&self, tx: &Transaction<'_>) -> Result<usize, ApiError>;            // 重建用
    fn count(&self, c: &Connection) -> Result<i64, ApiError>;
}

pub trait JobRepo {                            // 04 §3 indexing_jobs
    fn enqueue(&self, tx: &Transaction<'_>, document_id: i64, kind: JobKind, priority: i32, at: &str) -> Result<i64, ApiError>;
    fn get(&self, c: &Connection, id: i64) -> Result<Option<JobRow>, ApiError>;
    fn mark_running(&self, tx: &Transaction<'_>, id: i64, at: &str) -> Result<(), ApiError>;
    fn mark_finished(&self, tx: &Transaction<'_>, id: i64, state: JobState,
                     error_code: Option<&str>, error_msg: Option<&str>, at: &str) -> Result<(), ApiError>;
    fn bump_attempts(&self, tx: &Transaction<'_>, id: i64) -> Result<i32, ApiError>;
    fn cancel(&self, tx: &Transaction<'_>, id: i64, at: &str) -> Result<(), ApiError>;
    fn requeue_running(&self, tx: &Transaction<'_>) -> Result<usize, ApiError>;
    fn counts(&self, c: &Connection) -> Result<JobCounts, ApiError>;
}

pub trait BookmarkRepo {                           // 04 §3 bookmarks
    fn list(&self, c: &Connection, document_id: i64) -> Result<Vec<BookmarkDto>, ApiError>;
    fn get(&self, c: &Connection, id: i64) -> Result<BookmarkDto, ApiError>;
    fn create(&self, tx: &Transaction<'_>, document_id: i64, page_no: i64, title: &str,
              note: Option<&str>, color: Option<&str>, at: &str) -> Result<BookmarkDto, ApiError>;
    fn update(&self, tx: &Transaction<'_>, id: i64, title: Option<&str>, note: Option<&str>,
              color: Option<&str>, at: &str) -> Result<BookmarkDto, ApiError>;
    fn delete(&self, tx: &Transaction<'_>, id: i64) -> Result<(), ApiError>;
}

pub trait ProgressRepo {                           // 04 §3 reading_progress
    fn get(&self, c: &Connection, document_id: i64) -> Result<Option<ProgressDto>, ApiError>;
    fn upsert(&self, tx: &Transaction<'_>, p: &ProgressDto) -> Result<(), ApiError>;
    fn clamp_page(&self, tx: &Transaction<'_>, document_id: i64, page_no: i64, page_count: i64) -> Result<(), ApiError>;
    fn had_progress(&self, c: &Connection, document_id: i64) -> Result<bool, ApiError>;   // DocumentDto.hasProgress
}

pub trait SettingsRepo {                           // 04 §3 app_settings
    fn get_all(&self, c: &Connection) -> Result<SettingsMapDto, ApiError>;
    fn get(&self, c: &Connection, key: &str) -> Result<Option<String>, ApiError>;
    fn set(&self, tx: &Transaction<'_>, key: &str, value: &str, at: &str) -> Result<(), ApiError>;
    fn delete(&self, tx: &Transaction<'_>, key: &str) -> Result<(), ApiError>;
}
```

实现约束：所有 trait 方法返回 `Result<_, ApiError>`；写方法收 `&Transaction<'_>`、读方法收 `&Connection`，**trait 实现不得自己开事务**（事务边界归调用方）。`job.rs`/`bookmark.rs`/`progress.rs`/`settings.rs` 四个文件的实现必须与上面签名逐字一致，并在交付报告「对外提供的接口」节逐条列出。

内部行类型（不暴露给前端，命名以 `Row` 或事实结构结尾，05 §9 / L353）：`DocFact { id, library_root_id, rel_path, rel_path_key, abs_path, abs_path_key, size_bytes, mtime_ms, deleted_at: Option<String>, text_state, meta_state }`、`NewDocument<'_>`、`JobCounts`、`IntegrityReport`。

## 9. 数据结构

**表清单（04 §3，逐字对齐，行号见括注）**

| 表 | 契约位置 | 关键约束 |
|---|---|---|
| `schema_migrations` | L27–L31 | `version INTEGER PRIMARY KEY`、`name`、`applied_at` |
| `library_roots` | L34–L41 | `path UNIQUE`、`enabled CHECK IN (0,1)` |
| `documents` | L44–L71 | `abs_path_key UNIQUE`（R17，唯一性只认 key 列）；`UNIQUE(library_root_id, rel_path_key)`；`library_root_id REFERENCES library_roots(id) ON DELETE CASCADE`；两个 state 的 CHECK 白名单 |
| `page_text` | L79–L88 | `id INTEGER PRIMARY KEY`（**即 rowid 别名，不加 AUTOINCREMENT**，04 §4 / L157）；`UNIQUE(document_id, page_no)`；`ON DELETE CASCADE` |
| `page_fts` | L91–L96 | `fts5(seg_text, tokenize='unicode61 remove_diacritics 2', content='', contentless_delete=1)`；降级形态见 F-05 |
| `indexing_jobs` | L99–L115 | `kind CHECK IN ('meta','text','reindex')`、`state CHECK` 五值、`priority` 0=前台/10=后台 |
| `bookmarks` | L118–L129 | `page_no CHECK >= 1`、`ON DELETE CASCADE` |
| `reading_progress` | L132–L140 | `document_id INTEGER PRIMARY KEY`、`mode CHECK IN ('continuous','single')` |
| `app_settings` | L143–L147 | `key TEXT PRIMARY KEY`、`value` 为 JSON 字符串 |

**四个必须显式处理的易错点（04 §4）**

1. `abs_path_key` 全局唯一（R17）：所有查重/合并/JOIN 一律走 `*_key` 列；`abs_path`/`rel_path` 只用于展示与打开文件。
2. `deleted_at` 软删：同路径再出现优先「复活」旧行（`revive`），保持 id 稳定、书签与进度不丢（L155）。
3. rowid 复用：删除页面必须同一事务内**先删 FTS 行再删 `page_text`**；`DELETE FROM documents` 前必须显式 `DELETE FROM page_fts`（FTS 无外键）（L158，04 §6 / L176）。
4. `reading_progress.scroll_ratio` 恢复时 `page_no` 按新 `page_count` 夹取（L161）——夹取算子落在 `ProgressRepo::clamp_page`。

## 10. 文件组织

```text
src-tauri/migrations/
└── 001_init.sql              # 04 §3 完整 DDL（page_fts 由探针二选一，见 F-05 的写法说明）
src-tauri/src/db/
├── mod.rs                    # Db 门面：open/read/write/capabilities/integrity_check
├── conn.rs                   # 连接建立 + 04 §2 五条 PRAGMA + 只读连接策略（P-01）
├── write_queue.rs            # 单写连接串行化
├── migrations.rs             # include_str! + schema_migrations 推进（每文件一事务）
├── probe.rs                  # V-03 探针 → DbCapabilities
├── caps.rs                   # DbCapabilities 定义（app_info 注入源）
├── repo/
│   ├── mod.rs                # trait 重导出
│   ├── library_root.rs / document.rs / page_text.rs / fts.rs
│   ├── job.rs / bookmark.rs / progress.rs / settings.rs
├── integrity.rs              # db_integrity_check 实现（四项统计）
└── projection.rs             # 行 → DTO 映射（*Row → *Dto），改名三处的落点
```

## 11. 实施步骤

1. **连接与 PRAGMA**：`Db::open` 打开临时库、执行五条 PRAGMA、打印 `journal_mode` 回读值。判据：`PRAGMA journal_mode` 返回 `wal`；`PRAGMA foreign_keys` 返回 `1`。
2. **迁移器**：`001_init.sql` + `include_str!` + 版本推进。判据：空库首跑执行 1 个文件并插入 version=1；重跑不执行任何文件、版本行仍为 1。
3. **探针 + 降级（V-03）**：实现 `probe.rs`，两种结果各跑一次。判据：日志出现 `fts5=true contentless_delete=<bool>`；把探针结果强制为 `false` 时降级 DDL 也能建成。
4. **Repository 单表**：先 `LibraryRootRepo`/`DocumentRepo` 的读写，再 `PageTextRepo`/`FtsRepo`。判据：`insert_page_with_fts` 后 `page_text.id == page_fts.rowid`（`SELECT rowid FROM page_fts` 断言）。
5. **复合与一致性事务**：F-07 三处 + F-08 四类。判据：删文档后 `page_text`/`bookmarks`/`reading_progress`/`indexing_jobs` 均无残留，且 FTS 行数下降相同数量。
6. **`db_integrity_check` + 注册**：实现四项统计，`lib.rs` 追加一行注册，注入 `DbCapabilities` 给 `app_info`。判据：健康库返回 `ftsRows == pageTextRows`、`orphanPages == 0`、`mislabeledDocuments == []`。
7. **测试补齐**：§12 的六组用例。判据：`cargo test` 全绿，含故意构造的 rowid 复用场景。

## 12. 测试要求

Rust（`#[cfg(test)]` 或 `tests/db_*.rs`；需要 `tempfile` 作 dev-dependency，报告中说明体积可忽略）：

1. 迁移幂等：空库 → 最新；再 `open` 一次不重复建表、版本行仍 1；`schema_migrations` 行数 == `MIGRATIONS.len()`。
2. 级联：删 root → 其 `documents` 消失；删 document → `page_text`/`bookmarks`/`reading_progress`/`indexing_jobs` 消失；且在删除文档前显式删 FTS 后 `FtsRepo::count` 相应减少。
3. rowid 复用回归（04 §9 / L204）：连续 3 轮「插入文档 A 的页 → 删除文档 A → 插入文档 B 的页」，第 3 轮后按 A 的关键词查询命中数为 0。这条必须真实执行（`MATCH` 语句由测试内联构造，不使用 M11 代码）。
4. 并发：1 个写线程（循环插入 200 条）+ 3 个读线程循环 10s，断言无 `SQLITE_BUSY` 逃逸、无 panics；记录最慢一次写耗时。
5. 降级分支：强制 `contentless_delete=false` 后跑用例 1–4 全部通过（02 §11 D10）。
6. `db_integrity_check`：健康库四项分别为「相等、相等、0、空数组」；人为删掉某文档的 `page_text` 行并把 `text_state` 改回 `indexed` → `mislabeledDocuments` 含该 id。

命令：`cargo test --manifest-path src-tauri/Cargo.toml`、`cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`。

## 13. 验收标准

1. 迁移幂等：同一库 `Db::open` 两次，第二次日志显示 `applied=0`，`schema_migrations` 行数不变。
2. 级联正确：删 root 后该 root 下 `documents` 计数为 0；删 document 后四张子表计数为 0 且 FTS 行数同步减少。
3. 三轮「插-删-插」后，查询不返回已删文档的页码（用例 3 通过，输出贴报告）。
4. 1 写 3 读连续 10s 无 `SQLITE_BUSY`（用例 4 通过，贴耗时摘要）。
5. 降级分支全用例通过（用例 5），且 `app_info.contentlessDelete` 与探针结论一致。
6. `db_integrity_check` 在正常库上返回 `orphanPages = 0`、`mislabeledDocuments = []`、`ftsRows == pageTextRows`。
7. `#[tauri::command]` 只在 M03 出现 1 处（`db_integrity_check`），且 `src-tauri/src/lib.rs` 相对 M02 只多这一行注册；`db_reset` 编译进 debug、不进 `CMD`（用 `cargo build --release` 与 `grep` 证明）。
8. PRAGMA 生效：库建立后 `PRAGMA journal_mode` 为 `wal`、`foreign_keys` 为 `1`。

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

1. 不得修改 `docs/04` 的 DDL 去迁就实现（例如把 `page_text.id` 改成 `AUTOINCREMENT`、给 `page_fts` 加列）；发现不成立写报告第 9 节。
2. 不得在删除路径上「只删 `documents` 行、依赖外键」而漏删 `page_fts`——FTS 无外键，漏删即 rowid 串号。
3. 不得让上层模块自己 `Connection::open` 或自己拼 SQL；不得把 `rusqlite::Error` 的 Display 串直接塞进 `ApiError.message`（进 `detail`，`code` 用 `E_DB`）。
4. 不得用 `Mutex` 包住整个查询路径导致读也被串行化；只读连接不得跨 `await` 持有。
5. 不得把 `db_reset` 放进 `CMD`/`COMMAND_NAMES`，也不得在 release 构建里暴露它。
6. 不得省略降级分支（只测 `contentless_delete=1` 一条路就宣称完成）。