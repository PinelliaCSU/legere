# 模块 M09：text-index（页面级文本提取与分词索引）

> 依赖前置：M01 foundation（日志/错误基座）、M02 contracts（DTO 与错误码）、M03 database（`page_text`/`page_fts` 迁移、Repository、FTS5 探针 V-03 结论）。
> 被依赖方：M10 job-orchestrator（唯一调度方）、M11 global-search（查询侧分词）、M04 library（元数据经 M10 的 `kind='meta'` 任务间接获得）。
> 归属层：L0 Rust Core；并行组：B（B 组内部严格串行：M09 → M10 → M11）。

## 1. 模块身份

M09 是「PDF 字节 → 可检索文本」的唯一转换点，位于 L0 Rust Core 的 `src-tauri/src/index/`。
它把一页 PDF 的内容变成 `page_text` 的一行（原始文本）与 `page_fts` 的一行（jieba 分词后的 `seg_text`），两行以 `rowid` 绑定（见 docs/02-system-architecture.md §11 D04）。
它同时是全库唯一的**分词器提供方**：文档侧写入与 M11 查询侧切分必须使用同一实例、同一配置（见 docs/02-system-architecture.md §11 D05）。
它不拥有任何线程、队列、事件或 Tauri Command —— 它是指令式同步函数，被 M10 在 `spawn_blocking` 里调用一次，做完整本或让位。

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

交付一个**同步、无状态、可被 `spawn_blocking` 直接调用**的索引内核：给定 `document_id` + 文件路径，产出可被 FTS5 检索的 `page_text`/`page_fts` 行，并对外提供唯一的文档级分词器。

1. `TextExtractor` trait 落地，并有**两个可运行的实现**与一个工厂函数。
2. 批 8 页一事务写库，页内全或无（不产生半页残留）。
3. jieba 单例分词与 `build_seg_text` 规则表落地，文档侧与查询侧对称。
4. 元数据（页数/标题/作者/生产者/创建日期等）可被 `kind='meta'` 任务取走并写回 `documents`。
5. 扫描件/加密/损坏三类 PDF 有确定性终态，进程不崩。

## 4. 功能范围（必须完成）

1. **trait 定义**：`TextExtractor` 提供 `page_count` / `get_metadata` / `extract_page` / `extract_range` 四个方法（签名见 §8），`Send + Sync`，全部返回 `Result<_, IndexError>`。
2. **首选实现（pdfium 适配）**：`PdfiumExtractor`，经 pdfium 动态库读取页面文本。**必须**在实现前完成 S0 探针（§11），并满足：动态库缺失/加载失败/版本不匹配时**不得 panic**，只在启动日志记一条 `warn!` 并回退。
3. **回退实现（纯 Rust）**：`RustExtractor`，不依赖任何外部动态库，保证「无 pdfium 也能索引」。允许在个别字体编码/连字上结果弱于 pdfium（D03 已允许与 PDF.js 结果存在差异，不追求逐字一致），但必须对同一文件稳定返回同一结果。
4. **工厂与诊断**：`create_extractor()` 返回进程内单例；`engine_name()` 返回 `"pdfium"` 或 `"rust"`；启动时用 `tracing::info!(module = "index", engine = engine_name())` 输出一次。**不得**改动 `app_info` 的返回结构（见 §8 附注）。
5. **元数据**：从 PDF 取 `page_count` / `pdf_title` / `pdf_author` / `pdf_subject` —— 见 §9 字段表；缺失一律 `None`，不得用空串伪装。
6. **分词器单例**：进程内唯一 `jieba_rs::Jieba`（类型名与构造签名以 S1 探针抄录为准），精确模式（不启用 HMM 的新词搜索部分，如探针显示该开关影响对称性则固定为关闭并记录）。
7. **`build_seg_text` 规则表**：见 §9 第 3 条。规则表**必须**是纯函数并有单测。
8. **写库**：每 8 页一个事务（docs/02-system-architecture.md §6 第 194 行），事务内先 `page_text` 插入、再 `page_fts` 插入，`page_fts.rowid = page_text.id`（docs/04-database-design.md §4 第 157 行）。
9. **幂等**：对同一 `(document_id, page_no)` 重复索引，行数不增（`UNIQUE (document_id, page_no)`，docs/04 §3 第 85 行）；覆盖前必须先删旧 FTS 行（rowid 复用会串号，docs/04 §4 第 158 行）。
10. **清空入口**：`clear_document(document_id)` 在同事务内先删 `page_fts` 行再删 `page_text` 行（docs/04 §6 第 176 行语义），供 M10 的 `reindex`/`rebuild_all` 使用。
11. **`no_text` 判定**：全书所有页 `raw_text.trim()` 均为空 → 返回 `IndexError::NoText`，错误码 `E_PDF_NO_TEXT`（docs/05 §1 第 53 行），由 M10 置 `text_state='no_text'` 且不再重试。
12. **批间让位与取消**：`index_pages` 每提交一批就调用一次注入的 `on_batch` 回调，回调返回 `BatchOutcome::Stop` 时**立刻**返回 `Ok(IndexSummary { stopped_early: true, ... })`，已提交批保留、未提交批不留半行。M09 不读任何全局取消标志。

> 本模块**不注册任何 Tauri Command**（docs/05-api-contracts.md §3 第 170–199 行的 28 条命令中无 M09 条目）。

## 5. 非目标（明确不做）

1. **不做任务队列与调度**：不建线程、不持信号量、不重试、不节流事件、不写 `indexing_jobs` —— 全部归 M10（docs/03-module-boundaries.md §2 M10 卡第 126–134 行）。
2. **不写检索 SQL**：不做 `MATCH`、不做 `bm25`、不做聚合分页 —— 归 M11（docs/03 §2 M11 卡第 136–144 行）。
3. **不扫描目录、不判增量、不写 `documents` 的行存在性**：归 M04。
4. **不做 OCR**（docs/02 §11 D11）：扫描件直接 `no_text`，不允许引入 OCR 依赖或"尽力而为"的图片处理。
5. **不改 `app_info` 返回结构、不改 `tauri.conf.json`（含 `bundle.resources`）、不把二进制 dll 提交进仓库**：打包归 M01/M15，M09 只出「交付要求」。
6. **不自写 PDF 解析器**：回退实现必须使用现成 crate（候选见 S0），不得手写 xref/流解码。
7. **不 emit 任何事件**：`index://progress` 与 `index://job-finished` 只由 M10 发送（docs/05 §4 第 217–218 行）。
8. **不得自行确定任何视觉方案**（本模块无 UI，但 M11 的搜索面板会消费本模块的 `ranges` 语义；本模块只保证语义，不管呈现）。

**本模块【待你确认】清单（实现时留 `TODO(ui-confirm)`/`TODO(confirm)` 并写入交付报告 §6）**

1. 是否随安装包分发 pdfium 动态库（体积 + 授权 + 平台矩阵）——涉及产品与发布策略，须用户拍板；未拍板时实现必须保证「无 dll 也能跑」（回退实现）。
2. 回退实现选哪个 crate（`lopdf` 自写 content-stream 抽取 vs `pdf-extract` 高层封装）：体积与结果质量取舍，需用户确认后才可入 `Cargo.toml`。
3. 单汉字查询是否退化为子串扫描（属 M11 行为，但需 M09 提供 `raw_text` 侧能力，故在此登记）。

## 6. 架构约束

- **只能依赖**：`db`（M03 的 Repository 与连接）、`contracts`（M02 的类型/错误码）、`tracing`、`jieba-rs`、所选 PDF 解析 crate。**不得依赖**：`jobs`（M10）、`search`（M11）、`library`（M04）、任何 `tauri` 的 `AppHandle` 事件 API。
- **SQL 所有权**：`page_text`/`page_fts` 的读写只经 M03 提供的 Repository（docs/02 §3 第 110 行「数据库只被 Repository 访问」；`docs/04 §4 第 157 行` 明确由 `PageTextRepo::insert_page` 保证 rowid 绑定）。若 M03 的方法签名缺失或不满足「同事务 + rowid 绑定」，写「接口需求」到交付报告 §8，**不得**在 `index/` 内写 INSERT/UPDATE 绕过。
- **线程所有权**：M09 所有对外函数都是**同步阻塞**的，且假定调用者已在 `spawn_blocking` 线程内（docs/02 §9 第 272 行）。M09 内部不得 `tokio::spawn`、不得 `block_on`。
- **状态归属**：文档状态机 `documents.text_state` 的写权限归 M10（`indexing`/`indexed`/`no_text`/`failed`）与 M04（新建行 `pending`）。M09 只返回错误/摘要，**不写状态列**。
- **不负责清单**：入队/优先级/让位决策/重试计数/进度节流/事件/崩溃恢复/检索/排序/分词之外的任何文本加工（不做摘要、不做关键词、不做语言识别）。

## 7. 输入与输出

| 输入来源 | 数据形态 | 触发时机 |
|---|---|---|
| M10（`kind='text'`/`'reindex'` 任务） | `IndexRequest { document_id, path, pages, batch_size }` | 调度器在 `spawn_blocking` 中调用 `index_pages` |
| M10（`kind='meta'` 任务） | `MetaRequest { document_id, path }` | `documents.meta_state='pending'` |
| 本地 PDF 文件 | 只读字节流 | 提取时（只读打开，绝不改写源文件） |
| M03 Repository | `PageTextRepo` / `DocumentRepo` 句柄 | 每批提交、元数据写回 |
| M11 | 查询串 | 调 `segment_query()` 取 tokens |

| 输出目标 | 数据形态 | 消费方 |
|---|---|---|
| SQLite `page_text` | 一行一页：`id, document_id, page_no, raw_text, char_count` | M11 取上下文；`db_integrity_check` |
| SQLite `page_fts` | `rowid = page_text.id`，列 `seg_text` | M11 `MATCH` |
| `documents` 元数据列 | `page_count` 与 `pdf_*` 七列 | M04 `document_get`、M14 主页 |
| `IndexSummary` / `BatchOutcome` | 返回值 / 回调 | M10 决定重试、让位、终态 |
| `Vec<String>` tokens | `segment_query` | M11 构造 `MATCH` |

## 8. 接口契约

```rust
// src-tauri/src/index/extractor/mod.rs
pub trait TextExtractor: Send + Sync {
    fn engine_name(&self) -> &'static str;                 // "pdfium" | "rust"
    fn page_count(&self, path: &Path) -> Result<u32, IndexError>;
    fn get_metadata(&self, path: &Path) -> Result<PdfMeta, IndexError>;
    fn extract_page(&self, path: &Path, page_no: u32) -> Result<ExtractedPage, IndexError>;
    fn extract_range(&self, path: &Path, pages: RangeInclusive<u32>)
        -> Result<Vec<ExtractedPage>, IndexError>;
}

// src-tauri/src/index/extractor/factory.rs
pub fn create_extractor() -> Arc<dyn TextExtractor>;       // 进程内单例（OnceLock）
pub fn engine_name() -> &'static str;

// src-tauri/src/index/tokenizer.rs
pub fn segment(raw: &str) -> SegmentedText;
pub fn segment_query(raw: &str) -> Vec<String>;            // M11 唯一入口，与文档侧同一实例
pub fn build_seg_text(tokens: &[String]) -> String;

// src-tauri/src/index/mod.rs
pub fn index_pages<F>(req: IndexRequest<'_>, on_batch: F) -> Result<IndexSummary, IndexError>
where F: FnMut(&IndexProgress) -> BatchOutcome;
pub fn index_metadata(req: MetaRequest<'_>) -> Result<PdfMeta, IndexError>;
pub fn clear_document(document_id: i64) -> Result<u64, IndexError>;   // 返回删除的页数
```

约束：

- `docs/03-module-boundaries.md §2 M09 卡第 123 行` 冻结的三个对外名词 `TextExtractor`、`segment()`、`index_pages()` 必须**逐字保留**；其余函数名可在本模块内调整。
- `IndexError` 必须能把每个变体映射到一个 `ApiErrorCode`（docs/05 §1 第 19–23 行枚举，不得新增错误码）：`Corrupt→E_PDF_CORRUPT`、`Encrypted→E_PDF_ENCRYPTED`、`NoText→E_PDF_NO_TEXT`、`Io→E_IO`、`Permission→E_PERMISSION`、`Db→E_DB`、`NotFound→E_NOT_FOUND`、`Canceled→E_CANCELED`。
- 引擎发现顺序固定：`LEGERE_TEXT_ENGINE=pdfium|rust` 环境变量（诊断用）> 自动探测（pdfium 可用则 pdfium）> 回退。

**附注（两处契约问题，请原样写入交付报告 §9，不要自行绕过）**

1. `docs/03 §2 M03 卡第 58 行` 写「对外接口：见 05 §3 Repository Trait 清单」，但 `docs/05 §3` 是 Command 注册表，**不存在 Repository Trait 清单**。`PageTextRepo::insert_page` 的确切签名只能由 M03 的交付物给出 —— 开工前先读 `src-tauri/src/db/` 与 M03 交付报告确认；不满足则写「接口需求」。
2. 任务书要求「在 `app_info` 暴露实际引擎名」，但 `docs/05 §3 第 173 行` 的 `app_info` 返回结构为 `{ version, dataDir, dbPath, ftsEnabled, contentlessDelete }`，**无引擎名字段**；`app_info` 归属 M01/M03。因此本模块**不实现该字段**，改为：暴露 `index::engine_name()` + 一条启动日志，并在交付报告提「接口需求：`app_info` 增 `textEngine`（架构变更，需 Lead 批准）」。

## 9. 数据结构

1. **`ExtractedPage`**（内部）：`{ page_no: u32 /*1-based*/, raw_text: String, char_count: u32 }`。`char_count` = `raw_text.chars().count()`（按字符而非字节，与 `ranges` 的字符索引口径一致，docs/05 §2 第 136 行）。
2. **`PdfMeta`** → `documents` 列对照（列名逐字取自 docs/04 §3 第 52–59 行）：

| `PdfMeta` 字段 | `documents` 列 | 缺失时 |
|---|---|---|
| `page_count` | `page_count` | `None` |
| `title` | `pdf_title` | `None` |
| `author` | `pdf_author` | `None` |
| `subject` | `pdf_subject` | `None` |
| `keywords` | `pdf_keywords` | `None` |
| `producer` | `pdf_producer` | `None` |
| `creator` | `pdf_creator` | `None` |
| `creation_date` | `pdf_creation_date` | `None`（保留 PDF 原串，不擅自转 UTC） |

3. **`build_seg_text` 规则表**（最终依据应为 `07-search-engine-design.md` 的规则表；该文档**当前不存在**于 `docs/`，故以下按 `docs/04 §7 第 184–186 行` 落地。**若将来 07 与本表冲突，以 07 为准**，并在交付报告登记差异）：

| 规则 | 取值 |
|---|---|
| 输入 | `raw_text` 原文 |
| 切分 | `jieba` 精确模式，`cut(raw, false)`（HMM 开关以 S1 探针为准，不得两侧不同） |
| 丢弃 | 纯标点 / 纯空白 / `token.trim().is_empty()` 的 token |
| 保留 | 中文单字、中文词、英文词、数字、中英混排片段 |
| 连接 | 单空格 `' '` 连接，保持原顺序（「中文分词的效果」→ `中文 分词 的 效果`） |
| 不做 | 不去重、不做同义词、不做大小写折叠、不做词干化（大小写与变音符由 FTS5 `unicode61 remove_diacritics 2` 统一，docs/04 §7 第 184 行） |
| 空结果 | 返回空串 `""`，且**不写** `page_fts` 行与该页 `page_text` 行 |

4. **`SegmentedText`**：`{ seg_text: String, token_count: u32 }`。
5. **表的写入形状**：`page_text` 五列（docs/04 §3 第 79–86 行）；`page_fts` 一列 `seg_text` + `rowid = page_text.id`（docs/04 §3 第 91–96 行）。降级分支（V-03 探针给出 `contentlessDelete=false`）由 **M03 的 Repository 内部**选择，M09 代码不得出现两套分支（docs/04 §4 第 160 行）。
6. **`IndexSummary`**：`{ document_id: i64, total_pages: u32, pages_written: u32, pages_skipped: u32, stopped_early: bool, elapsed_ms: u64 }` —— M10 用它写 `page_count` 之外的统计与日志，**不用它写 `text_state`**。

## 10. 文件组织

```text
src-tauri/src/index/mod.rs                  # index_pages / index_metadata / clear_document 的门面与批循环
src-tauri/src/index/extractor/mod.rs        # TextExtractor trait、ExtractedPage、PdfMeta
src-tauri/src/index/extractor/pdfium.rs     # PdfiumExtractor（首选）
src-tauri/src/index/extractor/rust_native.rs# RustExtractor（回退，零动态库）
src-tauri/src/index/extractor/factory.rs    # create_extractor / engine_name / 环境变量覆盖
src-tauri/src/index/tokenizer.rs            # jieba 单例、segment / segment_query
src-tauri/src/index/segment_rules.rs        # build_seg_text 规则表纯函数
src-tauri/src/index/writer.rs               # 批 8 页事务：调 M03 Repository，本文件不含 SQL
src-tauri/src/index/error.rs                # IndexError + ApiErrorCode 映射
src-tauri/tests/index_integration.rs        # 需真实样本的集成测试（#[ignore] 或 feature 门控）
```

归属矩阵：本目录只属于 M09（docs/03 §4 第 217 行），其他模块不得修改；M09 也不得改 `db/**`、`jobs/**`、`search/**`。

## 11. 实施步骤

**S0 探针（必须先做，做完才能选实现）**
- `cargo add --dry-run pdfium-render` 与 `cargo add --dry-run lopdf` / `--dry-run pdf-extract`：抄录可用版本与依赖树变化（对应 V-02 的同类做法，docs/02 §1 第 31 行）。
- 关闭 V-03 结论：读 M03 交付报告里的 `DbCapabilities { fts5, contentlessDelete }`；若未关闭，先在 `sqlite3`/rusqlite 上执行 docs/02 §1 第 32 行的探针 SQL 并记录。
- 判据：三个 crate 的版本、体积、许可证、Windows 支持结论写入交付报告；缺这项不许进 S2。

**S1 分词器（V-04）**：实现 `tokenizer.rs` + `segment_rules.rs`；用 `cargo doc -p jieba-rs --open` 抄录 `Jieba`/`cut` 的真实签名再写代码。落点：`cargo test index::segment` 通过（含中英混排、纯标点、空串）。

**S2 trait + 回退实现**：`extractor/mod.rs` + `rust_native.rs` + `error.rs`。落点：给定一个 3 页样本 PDF，`page_count == 3`、`extract_page(1)` 返回非空 `raw_text`。

**S3 首选实现 + 工厂**：`pdfium.rs` + `factory.rs`。落点：dll 存在时 `engine_name() == "pdfium"`；把 dll 改名后重启，`engine_name() == "rust"` 且全流程仍通过（这条是回退的验收）。

**S4 写库批循环**：`writer.rs` + `mod.rs` 的 `index_pages`。落点：索引一个 20 页样本后，`page_text` 行数 = 20，且 `SELECT COUNT(*) FROM page_fts f JOIN page_text p ON p.id = f.rowid` = 20。

**S5 幂等与清空**：重复索引两次 + `clear_document`。落点：行数不变；清空后两表对该文档均为 0 行。

**S6 元数据**：`index_metadata` + 回写 `documents`。落点：`document_get` 能看到 `pdfTitle`/`pageCount`（经 M04 的 DTO 路径）。

**S7 终态三例**：扫描件、加密、损坏。落点：依次得到 `NoText`/`Encrypted`/`Corrupt`，进程无 panic（`cargo test` 全绿，无 `panicked` 输出）。

**S8 让位与取消**：`on_batch` 返回 `Stop` 的两条路径。落点：中途 Stop 后，`page_text` 行数 = 已提交批的页数之和（8 的倍数），无半页残留。

**S9 报告**：交付报告 + 「接口需求」（`app_info.textEngine`、pdfium dll 打包）。

## 12. 测试要求

单元（`#[cfg(test)]`，不需要样本）：分词对称性、`build_seg_text` 六行规则表逐行断言、`IndexError → ApiErrorCode` 全变体映射、批边界计算（`0/1/7/8/9/16` 页切批结果）、工厂环境变量优先级。

集成（需样本，`#[ignore]` 或 `LEGERE_SAMPLES_DIR` 环境变量门控）：幂等、rowid 一致性、清空、三终态、让位落点。缺样本时**必须**在报告写「未验证」。

命令：

```bash
cargo test --manifest-path src-tauri/Cargo.toml index::
cargo test --manifest-path src-tauri/Cargo.toml --test index_integration -- --ignored --nocapture
```

## 13. 验收标准

1. 扫描件 PDF → `index_pages` 返回 `Err(NoText)`（错误码 `E_PDF_NO_TEXT`）；M10 链路跑完后 `SELECT text_state FROM documents WHERE id=?` 为 `no_text`，且不再入队。
2. 加密 PDF → 返回 `Err(Encrypted)`（`E_PDF_ENCRYPTED`）；应用进程存活、后续任务继续执行；`text_state` 最终为 `failed`。
3. 对同一 PDF 连续索引两次：`SELECT COUNT(*) FROM page_text WHERE document_id=?` 两次读数据相同；`SELECT COUNT(*) FROM page_fts f JOIN page_text p ON p.id=f.rowid WHERE p.document_id=?` 等于页数。
4. 分词对称性：`segment(text).seg_text` 两次调用逐字节相同；`segment_query(q)` 与 `segment(q)` 的 token 序列相同（同一函数路径，断言相等）。
5. 100 页中文 PDF：报告实测 `elapsed_ms` 与所用引擎；判据 = 数值被真实测出并写进报告，且 < 120000ms（超时视为阻断，需要排查而不是调大阈值）。
6. 降级：临时使 pdfium 不可用后，整套 S4–S8 用例仍全部通过（除 S3 的 `engine_name` 断言改为 `"rust"`）。
7. 任何错误路径下无 `unwrap()`/`panic!`：`cargo clippy -- -D clippy::unwrap_used` 无新增告警（若项目未开该 lint，用 `rg "\.unwrap\(\)" src-tauri/src/index` 结果为 0 条）。

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

1. 不得在 `src-tauri/src/index/` 内出现 `INSERT`/`UPDATE`/`DELETE`/`MATCH` 等 SQL 文本；写库一律经 M03 Repository（`rg -n "INSERT|UPDATE|DELETE|MATCH" src-tauri/src/index` 只允许出现在注释与测试夹具里）。
2. 不得写 `documents.text_state`/`meta_state`（状态归 M10/M04）；本模块只返回错误与统计。
3. 不得 `emit` 任何事件、不得持有 `AppHandle`、不得 `tokio::spawn`。
4. 不得因 pdfium 不可用而让索引能力整体失效——回退实现必须真实可用，不得写成 `todo!()` + 回退。
5. 不得把 `pdfium.dll` 或其他二进制提交进仓库、不得改 `tauri.conf.json`（打包要求写交付报告，由 M01/M15 执行）。
6. 不得在没有 S0 证据的情况下把 PDF 解析 crate 写进 `Cargo.toml`；新增 runtime 依赖必须在报告 §9 说明理由与体积影响（_shared-context.md §E 第 7 条）。
