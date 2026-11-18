# 模块 M11：global-search（库级检索与结果面板）

> 依赖前置：M09 text-index（`segment_query` 唯一分词入口）、M10 job-orchestrator（`index_status` 用于「索引未完成」判定）、M03 database（`page_text`/`page_fts`/`documents` 与只读连接）、M02 contracts（DTO、`call`/`subscribe`）。
> 被依赖方：M14 workspace-shell（挂载面板与路由跳转）、M08 doc-search（消费 `ranges` 做文本层高亮）、M15（性能基线）。
> 归属层：L0 Rust（`src-tauri/src/search/`）+ L4 React（`src/features/search-panel/`）；并行组：B。

## 1. 模块身份

M11 把「用户输入一句话」变成「跨全库、按文档聚合、带页内字符区间的可点击结果」。
它是唯一允许写 FTS5 检索 SQL 的模块（`MATCH`、`bm25`、聚合分页），也是唯一把 `ranges` 语义定义清楚的模块；但**高亮**归 M08、**跳转**归 M14、**分词**归 M09。
它是全项目唯一需要同时交付 Rust 与 React 的检索模块：Rust 侧是纯查询（零写入、零事件），React 侧是一个浮层面板（结构可定，视觉全部待确认）。

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

交付一条可验收的检索链路：**任意输入串都不抛错、结果按文档聚合且能精确跳到页内位置、100k 页规模 P95 < 200ms**。

1. 规范化 + 注入防护 + 分词构造的 `MATCH` 表达式，全部为可单测的纯函数。
2. 一条「先按文档聚合再分页」的 SQL 模板，并用 `EXPLAIN QUERY PLAN` 证明走倒排。
3. 在 `raw_text` 上自算 40 字上下文与字符区间（不用 `snippet()`，docs/02 §11 D06）。
4. 两个 Command 与 `tookMs` 计时。
5. 一个可被 M14 挂载的浮层面板：三态、请求序号取消、点击回调出参 `{ documentId, pageNo, ranges }`。

## 4. 功能范围（必须完成）

1. **规范化** `normalize_query(raw: &str) -> String`：`trim` → 全角转半角（U+FF01–U+FF5E → ASCII，U+3000 → 空格）→ 连续空白压成单空格 → 截断到 **100 字符**（本模块决定并记录，契约未给；超出即截断而非报错）。
2. **`sanitize_query`**：删除所有非「文字/数字/空白」字符（规则源：`docs/04-database-design.md §7 第 188 行` 列出的 `" * ( ) : ^ -` 与 `NEAR AND OR NOT` 等 FTS 语法字符）。实现优先用字符白名单——保留 `c.is_alphanumeric() || c.is_whitespace()`——而不依赖 `regex` 新依赖；若项目已有 `regex`，等价式为删除 `[^\p{L}\p{N}\s]`。**两者必须输出一致**，用同一组用例断言。
3. **空查询**：规范化后为空串 → 返回 `items: [], totalDocuments: 0, offset, limit, tookMs`，**不抛错**（空态由前端呈现）。参数越界（`hitsPerDocument > 5`、`documentLimit > 50`、`documentOffset < 0`）→ `E_INVALID_ARG`（docs/05 §2 第 129–130 行给了上限）。
4. **分词**：只调 M09 的 `index::segment_query(normalized)`；**不得**自建 `Jieba` 实例、不得自己做字符 n-gram。
5. **MATCH 构造** `build_match(tokens, mode) -> String`：
   - `mode == "phrase"` → `"t1 t2 t3"`（整串用双引号包裹，token 之间单空格；FTS5 短语 = 相邻 token 序列，docs/04 §7 第 185 行）。
   - `mode == "terms"` → `t1 AND t2 AND t3`（docs/04 §7 第 185 行）。
   - 防御：即使已 sanitize，仍把 token 中的 `"` 替换为 `""`（FTS5 字符串转义），并对空 token 列表返回「不查询」。
6. **检索**：`page_fts MATCH ?` + `bm25(page_fts)` **升序**为默认相关度（docs/04 §7 第 187 行：bm25 返回负值，越小越相关）。**先验证 bm25 在 contentless 表上可用**（探针见 §11 S0），不可用则整条链路改为「MATCH 过滤 + 页序」并写报告。
7. **按文档聚合再分页**：见 §9 第 4 条的完整 SQL 模板；每文档取 `hitsPerDocument` 个命中页（默认 3、上限 5），文档按「最佳命中分」升序，再按 `documentOffset/documentLimit` 切片（上限 50）。禁止「先取前 N 条命中再聚合」。
8. **`hitCount` 语义**：= 该文档**命中的页数**（不受 `hitsPerDocument` 截断影响，用 `COUNT(DISTINCT page_no)` 得到）。bundle 见 §8 附注（契约未明确，本模块决定并记录）。
9. **上下文与区间**（不用 `snippet()`，D06）：在 `page_text.raw_text` 上为每个命中 token 做**大小写不敏感的子串定位**，取首个命中位置为中心开 **40 字**窗口（docs/02 §7 第 227 行），前后截断处补 `…`；返回的 `ranges` 是**snippet 内**的字符索引区间、左闭右开（docs/05 §2 第 136 行）。全角转半角是 1 字符对 1 字符映射，字符索引因此稳定；**禁止**用字节偏移。
10. **两个 Command** + `tookMs`：计时覆盖「规范化 → SQL → B 组装」，单位毫秒整数，写在 `GlobalSearchPageDto.tookMs`（docs/05 §2 第 145 行）。
11. **前端面板** `GlobalSearchPanel`：输入框、结果列表（文档 → 命中页行）、加载/空/错误三态、滚动加载下一页、`Esc` 关闭。**结构与状态可定，视觉全部待确认（§5）**。
12. **请求序号取消**：每次查询自增 `seq`；回包若 `seq !== currentSeq` 则丢弃（不入 state）；同一时刻只保留一个 in-flight 结果。**不用** AbortController 假设 Tauri 支持取消（未验证），靠序号丢弃。
13. **点击跳转**：回调 `onOpenHit({ documentId, pageNo, ranges })`；跳转与高亮由 M14 + M08 完成（`ReaderApi.goToPage(pageNo, { highlightRanges })`，docs/05 §7 第 331 行）。M11 不 import reader，不调 `goToPage`。
14. **索引未完成提示**：`index_status.documentsPending > 0` 时在面板内显示一条「部分文献尚未索引」提示（文案形态待确认），并在查询返回空结果时给出该提示而不是「无结果」。

## 5. 非目标（明确不做）

### 5.0 已由 Lead 裁决的技术参数（**不再询问，按此实现**）

以下条目曾标为「待你确认」，但属技术参数且**已由 Lead 按官方文档与工程判断裁决**：**T19 T20 T21** —— 明细与理由见 `docs/14-ui-decision-register.md` §1 对应行。实现时直接落该值，**不得**再当作待确认项停下来问；若你认为某条在本模块不成立，在交付报告 §9 提出并说明，不要自行改动。

1. **不写索引**：不写 `page_text`/`page_fts`/`documents`，不触发重新索引（`index_*` 归 M10）。
2. **不做文内搜索**：当前文档内搜索、命中矩形坐标、文本层高亮 DOM 全部归 M08。
3. **不实现分词器**：不新建 `Jieba`、不改词典、不做自定义切分规则（归 M09）。
4. **不使用 FTS5 的 `snippet()`/`highlight()`**（D06；它们在 contentless 表上本就不可用，且输出带分词空格）。
5. **不做 trigram 表或 `LIKE` 全表扫描兜底**（docs/04 §7 第 186 行明确不用 trigram；`LIKE` 兜底需用户拍板，见 §5 待确认第 6 条）。
6. **不改 M14 的路由、不做全局快捷键注册**：快捷键的表单归属与注册位置属 M14/设置面板，M11 只接受 `open` 受控 props。
7. **不得自行确定视觉方案**：面板位置、尺寸、间距、圆角、颜色、字体、动效、命中高亮样式一律不得给死值，一律留 `TODO(ui-confirm)`。

**本模块【待你确认】清单（实现时留 `TODO(ui-confirm)` 占位，逐条进交付报告 §6）**

1. 面板形态与位置：居中浮层 / 顶部下拉 / 右侧抽屉（三选一或组合）。
2. 尺寸与结果项高度、一次可见命中条数、单文档命中页的展开方式（全部展开 / 默认折叠）。
3. 浮现与消失动效：有无、时长、缓动曲线。
4. 唤起快捷键（候选：`Ctrl/Cmd+K`、`Ctrl+Shift+F`、其他）以及是否注册为全局快捷键（需 M14 的快捷键表统一分配）。
5. 输入触发方式：即时搜索（防抖 X ms）还是回车触发；防抖毫秒数。
6. 结果项信息密度：显示文件名 / 标题 / 作者 / 页码 / 上下文行数中的哪些；命中片段的高亮样式（交 M13 主题令牌 + M08 语义）。
7. 空态、错误态、索引未完成提示的文案形态与图标。
8. 单汉字查询的召回策略（token 级精确匹配 = 0 命中，见 §13 第 2 条）：接受现状还是增加子串兜底。

## 6. 架构约束

- **只能依赖**：Rust 侧 `db`（M03 只读连接）、`index`（M09 `segment_query`）、`contracts`（M02）；前端 `src/core/ipc.ts` 的 `call/subscribe`、`src/contracts/*.ts` 的类型、M14 提供的受控 props。**不得依赖**：M10 `jobs` 的内部结构（只可 `index_status`）、M09 的写库函数、M08 的高亮实现、`pdfjs-dist`。
- **只读**：`src-tauri/src/search/` 内不得出现 `INSERT/UPDATE/DELETE/PRAGMA`；只允许 `SELECT`。SQL 位置归本模块（docs/03 §2 M11 卡第 138 行把「SQL 检索与排序」划给 M11），但**连接**必须来自 M03 的只读连接入口；若 M03 未暴露，报告「接口需求」，不得自建 `Connection::open`。
- **前端不得出现 SQL 或表名**（docs/02 §2 规则 3）；`MATCH` 串只能在 Rust 内构造，前端只传 `GlobalSearchParams`。
- **不 emit 事件、不订阅事件**（除可选：索引完成后刷新结果需由 M14 触发重新查询，M11 不直接 listen —— 见 §8 附注 3）。
- **状态归属**：`GlobalSearchParams`/`GlobalSearchPageDto` 是 IPC 契约（M02 手写镜像），M11 不新增字段；面板内部状态（`query/seq/items/loading/error`）归 M11 的 `use-global-search.ts`（zustand 或 React state 均可，但**同一状态不得两处持有**）。
- **不负责清单**：分词实现、索引写入、页内高亮与矩形坐标、路由与快捷键注册、性能预算以外的任何优化承诺。

## 7. 输入与输出

| 输入来源 | 数据形态 | 触发时机 |
|---|---|---|
| 用户（输入框） | 原始字符串 | 输入 / 回车 / 防抖到期 |
| 前端 `call("search_global", { params })` | `GlobalSearchParams` | 每次查询与翻页 |
| 前端 `call("search_global_count", { params })` | 同参数 | 面板顶部计数（可选，见 §13 第 6 条） |
| M09 | `Vec<String>` tokens | 构造 `MATCH` 前 |
| M03 | `page_fts` 命中的 `rowid` 集 + `page_text.raw_text` + `documents` 行 | 每次查询 |
| M10 | `IndexStatusDto` | 面板挂载时一次 |

| 输出目标 | 数据形态 | 消费方 |
|---|---|---|
| 前端 | `GlobalSearchPageDto` | `GlobalSearchPanel` |
| 前端 | `{ documents, pages }` | 计数区 |
| M14 | `onOpenHit({ documentId, pageNo, ranges })` | 路由到 `reader` |
| M08 | `ranges: [number, number][]`（经 M14 传递） | 文本层高亮 |

### 7.2 面板形态与交互（D23/D24/D25 已由用户拍板，照此实现，不得再问）

| 项 | 已定结论 |
|---|---|
| 形态 | **居中浮层**（overlay），宽 `720px`（≤ 90vw），距顶 `15vh`，浮层 `--lg-bg-elevated` + `--lg-radius-lg` |
| 动效 | `120ms` 淡入 + 轻微上移 4px（`--lg-dur-fast`，曲线 `cubic-bezier(.2,0,0,1)`）；关闭 `120ms` 淡出 |
| 唤醒 | `Ctrl+K`，**仅应用内**，不注册系统级全局热键 |
| 触发 | **即时搜索**，防抖 `250ms`；`Enter` 立即触发（跳过防抖） |
| 关闭 | `Esc` / 点浮层外 / 再次 `Ctrl+K` |
| 键盘 | `↑`/`↓` 在命中项间移动，`Enter` 打开当前项，`Tab` 不逃出浮层（焦点陷阱） |
| 单文档命中 | 默认展开前 3 条命中页，超出显示「还有 N 页命中」可展开（`hitsPerDocument` 契约上限 5） |
| 焦点与可访问性 | 打开时聚焦输入框；`role="dialog"` + `aria-modal="true"`；关闭后焦点回到唤起前元素 |

**仍未定**（不得自行发明）：结果项信息密度与命中高亮样式（高亮已由 D21 定，面板内的高亮沿用同一令牌）、空态/错误态/索引未完成提示的**文案**（D28）。

## 8. 接口契约

```text
search_global        { params: GlobalSearchParams } -> GlobalSearchPageDto
                     E_INVALID_ARG, E_UNSUPPORTED, E_DB          (docs/05 §3 第 189 行)
search_global_count  { params: GlobalSearchParams } -> { documents: number, pages: number }
                     E_INVALID_ARG                               (docs/05 §3 第 190 行)
```

DTO 逐字取自 docs/05 §2：`GlobalSearchParams`（第 125–131 行）、`GlobalSearchHitDto`（第 133–137 行）、`GlobalSearchResultDto`（第 139–141 行）、`GlobalSearchPageDto`（第 143–146 行）。前端调用 `call("search_global", { params }, { timeoutMs: 20000 })`（docs/05 §5 第 239 行给了该建议值）。

Rust 内部接口（供 `commands.rs` 薄层调用，便于单测不经 IPC）：

```rust
// src-tauri/src/search/mod.rs
pub fn search_page(params: &GlobalSearchParams) -> Result<GlobalSearchPageDto, SearchError>;
pub fn search_count(params: &GlobalSearchParams) -> Result<(u64, u64), SearchError>; // (documents, pages)

// 纯函数（必须可测，不碰 DB）
pub fn normalize_query(raw: &str) -> String;
pub fn sanitize_query(raw: &str) -> String;
pub fn build_match(tokens: &[String], mode: SearchMode) -> Option<String>;
pub fn build_snippet(raw_text: &str, tokens: &[String]) -> (String, Vec<(usize, usize)>);
```

前端组件契约（本模块新增，非 IPC 契约）：

```ts
export interface GlobalSearchPanelProps {
  open: boolean;
  onClose: () => void;
  onOpenHit: (target: { documentId: number; pageNo: number; ranges: [number, number][] }) => void;
  initialQuery?: string;
}
```

**附注（三处契约问题/歧义，请原样写入交付报告 §9）**

1. `docs/05 §2 第 140 行` 的 `hitCount` 未定义「命中次数」还是「命中页数」；本模块按**命中页数**实现并在报告登记，若 Lead 要求改为命中次数需同步 05 与 M14。
2. 任务书引用的 `07-search-engine-design.md` 的「边界用例表」在 `docs/` 中**不存在**；本模块以 §12 的表为准，并在报告中登记「待 07 落地后复核」。
3. 索引完成后自动刷新结果需要「M11 订阅某个事件」或「M14 在收到 `index://job-finished` 后调刷新」；本模块按后者实现（不 listen），若 Lead 选择前者需改本模块依赖方向。

## 9. 数据结构

1. **`GlobalSearchParams`**（docs/05 §2 第 125–131 行）：`query, mode: "phrase"|"terms", rootIds?: number[], hitsPerDocument, documentOffset, documentLimit`。默认与上限：`hitsPerDocument` 默认 3 上限 5；`documentLimit` 默认 50 上限 50（docs/05 §8 第 341–342 行）；`documentOffset ≥ 0`。
2. **`GlobalSearchHitDto`**：`pageNo` 1-based；`snippet` = 原文窗口 + 首尾 `…`；`ranges` = snippet 内字符区间数组，左闭右开，互不重叠、按起点升序。
3. **`GlobalSearchPageDto`**：`items: GlobalSearchResultDto[]; totalDocuments: number; offset; limit; tookMs`。`totalDocuments` = 命中文档总数（与 `search_global_count.documents` 相同查询谓词）。
4. **聚合 SQL 模板**（`documentIds` 过滤为动态 `IN (?,?,…)` 占位符拼接，不拼入值本身；若 M03 的 SQLite 建有 JSON1，可换 `json_each`，但要先探针）：

```sql
WITH hits AS (
  SELECT pt.document_id AS document_id,
         pt.page_no     AS page_no,
         bm25(page_fts) AS score
  FROM page_fts
  JOIN page_text pt ON pt.id = page_fts.rowid
  JOIN documents  d ON d.id = pt.document_id
  WHERE page_fts MATCH ?1
    AND d.deleted_at IS NULL
    -- 可选：AND d.library_root_id IN (?, ?, ...)
),
per_doc AS (
  SELECT document_id,
         MIN(score)                        AS doc_score,
         COUNT(DISTINCT page_no)           AS hit_count,
         COUNT(*)                          AS page_hit_rows
  FROM hits GROUP BY document_id
),
ranked AS (
  SELECT document_id, doc_score, hit_count,
         ROW_NUMBER() OVER (ORDER BY doc_score ASC, document_id ASC) AS doc_rn
  FROM per_doc
),
top_pages AS (
  SELECT h.document_id, h.page_no, h.score,
         ROW_NUMBER() OVER (PARTITION BY h.document_id ORDER BY h.score ASC, h.page_no ASC) AS rn
  FROM hits h
)
SELECT r.document_id, r.hit_count, tp.page_no, tp.score,
       d.file_name, d.rel_path, d.size_bytes, d.mtime_ms, d.page_count,
       d.pdf_title, d.pdf_author, d.meta_state, d.text_state, d.last_opened_at,
       EXISTS(SELECT 1 FROM reading_progress p WHERE p.document_id = d.id) AS has_progress
FROM ranked r
JOIN top_pages tp ON tp.document_id = r.document_id AND tp.rn <= ?2   -- hitsPerDocument
JOIN documents d  ON d.id = r.document_id
WHERE r.doc_rn > ?3 AND r.doc_rn <= ?3 + ?4                            -- offset / limit
ORDER BY r.doc_rn ASC, tp.rn ASC;
```

5. **`DocumentDto` 组装**：结果里的文档字段必须能直接映射为 `DocumentDto`（docs/05 §2 第 74–83 行），包括 `hasProgress` 的来源（docs/05 §2 第 161 行：`EXISTS(reading_progress)`）；`absPath` 不在 `DocumentDto` 中，不得额外塞字段。
6. **`SearchError`**：`InvalidArg→E_INVALID_ARG`、`NoFts5→E_UNSUPPORTED`、`Db→E_DB`（映射到 docs/05 §1 的枚举，不新增错误码）。

## 10. 文件组织

```text
src-tauri/src/search/mod.rs                 # 门面：search_page / search_count
src-tauri/src/search/normalize.rs           # trim / 全角半角 / 长度上限 / sanitize
src-tauri/src/search/match_expr.rs          # build_match（phrase/terms）+ 转义
src-tauri/src/search/query.rs               # 聚合 SQL 模板 + 分页 + 只读连接调用
src-tauri/src/search/snippet.rs             # 40 字窗口、ranges、省略号（纯函数）
src-tauri/src/search/assemble.rs            # DTO 组装（DocumentDto / GlobalSearchResultDto）
src-tauri/src/search/error.rs               # SearchError + ApiError 映射
src-tauri/src/search/commands.rs            # 两个 #[tauri::command]（薄层）
src/features/search-panel/GlobalSearchPanel.tsx   # 浮层结构与三态渲染（无视觉数值）
src/features/search-panel/use-global-search.ts    # 查询状态机 + 请求序号 + 防抖
src/features/search-panel/request-sequence.ts     # 序号丢弃逻辑（纯函数，可单测）
src/features/search-panel/search-panel.test.tsx   # vitest 组件/状态测试
```

归属：`src-tauri/src/search/**` 与 `src/features/search-panel/**` 只属于 M11（docs/03 §4 第 219、228 行）。

## 11. 实施步骤

**S0 探针**：确认 (a) `docs/02 §1 V-03` 的 FTS5 结论（`DbCapabilities`）；(b) 在 `page_fts` 上执行 `SELECT rowid, bm25(page_fts) FROM page_fts WHERE page_fts MATCH '<token>' ORDER BY bm25(page_fts) LIMIT 5` —— 判据：无 `unable to use function bm25` / `no such column` 报错；(c) SQLite 版本 ≥ 3.25（窗口函数），02 §1 第 14 行称 bundled 3.54.1，实测一次 `select sqlite_version()` 记录。三项任一不成立 → 停，写报告。
**S1 规范化**：`normalize.rs`。落点：§12 的 12 条用例全绿。
**S2 MATCH 构造**：`match_expr.rs`。落点：`phrase`/`terms` 各 5 例输出逐字断言。
**S3 SQL 骨架**：`query.rs` 先跑通「单文档单页」命中；同时抄录 `EXPLAIN QUERY PLAN` 输出到报告。
**S4 聚合分页**：`per_doc/ranked/top_pages` 三段 CTE。落点：造 3 文档 × 10 命中页，`hitsPerDocument=3`、`documentLimit=2` 时返回 2 文档 × 3 页，且 `hitCount` 为命中页数。
**S5 上下文与区间**：`snippet.rs`。落点：§12 的 6 条 ranges 用例。
**S6 两个命令 + tookMs**：`assemble.rs` + `commands.rs`。落点：前端 `invoke` 手动调一次，返回结构符合 docs/05 §2 第 143–146 行。
**S7 前端状态机**：`use-global-search.ts` + `request-sequence.ts`。落点：vitest 断言过期回包被丢弃。
**S8 面板结构**：`GlobalSearchPanel.tsx`（三态 + 列表 + 分页），视觉留 `TODO(ui-confirm)`。
**S9 性能**：100k 页数据生成脚本 + P95 测量，写进报告。

## 12. 测试要求

**规范化与注入（`normalize.rs`，纯单测）**：

| 输入 | `sanitize_query` 期望 | 说明 |
|---|---|---|
| `中文 分词` | `中文 分词` | 原样 |
| `""` / `***` / `（）` | 空串 | 纯标点 → 不查询 |
| `foo*` | `foo` | 去 FTS 前缀符 |
| `(a AND b)` | `a AND b` → 见注 | 去括号；`AND` 作为普通词保留时按 token 处理 |
| `a NEAR/2 b` | `a NEAR 2 b` | 去 `/` |
| `"x u0031; OR 1=1` | `x 1 OR 1 1` | 引号/等号被删，`OR` 作为普通词 |
| `中文\r\n分词` | `中文 分词` | 空白压缩 |
| 长度 200 字符 | 截断到 100 | 与 §4 第 1 条一致 |
| 全角 `ＡＢＣ１２３` | `ABC123` | 全角转半角 |

注：`AND/OR/NOT/NEAR` 出现在**用户查询**里时按普通词处理（它们已被 sanitize 保留为字母），最终 `MATCH` 由 `build_match` 用参数化 token 重建，因此不会成为语法符——这条必须有断言。

**MATCH 构造**：`["中文","分词","的","效果"]` + `phrase` → `"中文 分词 的 效果"`；同 tokens + `terms` → `中文 AND 分词 AND 的 AND 效果`；空 tokens → `None`。

**ranges（纯单测）**：命中在开头/中间/结尾；同一窗口内两个命中 → 2 条区间且不重叠；窗口跨越 40 字边界 → 两侧加 `…` 且索引按 snippet 计；命中在最后 5 字 → 窗口向前取满 40 字；大小写不同 → 命中且区间指向原文大小写。

**集成**：聚合分页、`search_global_count` 与 `search_page` 的 `totalDocuments` 相等、`rootIds` 过滤、空库、未索引文档不出现（无 `page_text` 行）。

**性能脚本**（`#[ignore]`）：生成 2000 文档 × 50 页（≈100k 页）的 `page_text`/`page_fts`；跑 100 次真实查询（中文词、英文词、短语、多词各 25 次），输出 P50/P95/P99 与 `EXPLAIN QUERY PLAN`。

命令：

```bash
cargo test --manifest-path src-tauri/Cargo.toml search::
cargo test --manifest-path src-tauri/Cargo.toml --test search_perf -- --ignored --nocapture
npx vitest run src/features/search-panel
```

## 13. 验收标准

1. **特殊字符不抛错**：`["`、`*`、`AND`、`NEAR`、`(`、`)`、`:`、`^`、`-`、`"""`、`***`、`（）`、`a OR b`、`"x" OR 1=1` 逐个调用 `search_global`：全部返回 `Ok`（可为空结果），**不得**出现 `E_DB`/`E_INTERNAL`/`E_INVALID_ARG`；异常字符输入不得让 SQL 抛出 FTS 语法错误（断言 `SearchError` 中无 `Db` 变体）。
2. **单汉字查询给出确定行为**：语义 = token 级精确匹配（不保证子串召回）。断言：库中含 `中文分词的效果`（`seg_text` = `中文 分词 的 效果`），查询 `词` → 0 命中；查询 `分词` → 命中；查询 `中文` → 命中。该行为写入报告，并由用户在 §5 第 8 条确认是否接受。
3. **100k 页 P95 < 200ms**：按 §12 的性能脚本测得 P95 < 200ms，并把 P50/P95/P99 与机器信息写进报告；`EXPLAIN QUERY PLAN` 必须显示 `page_fts` 以 `MATCH` 驱动（倒排索引扫描），不得显示对 `page_text` 的全表扫描作为驱动表。若 > 200ms，先给 `EXPLAIN` 证据再优化，不得隐瞒。
4. **点击跳转正确**：对一条已知命中（文档 A 第 37 页），点击后 `onOpenHit` 收到的 `documentId=A`、`pageNo=37`、`ranges` 与 `search_global` 返回逐值相等（前端测试断言）；M14 侧用 `ReaderApi.goToPage(37, { highlightRanges: ranges })` 完成跳转与高亮。
5. **过期请求丢弃**：让 #1（慢）与 #2（快）两次查询并发，#1 后返回 → 最终渲染的数据 = #2 的结果（断言 `seq` 相等且列表内容来自 #2）。
6. **count 与 page 自洽**：同一 `params` 下 `search_global_count.documents == search_global.totalDocuments`，且 `pages ` = 命中页总数（遍历全部分页累加 `hitCount` 相等）。
7. **边界**：`hitsPerDocument=6` 或 `documentLimit=51` → `E_INVALID_ARG`；`query` 为空串 → 空结果且 `tookMs` 为数字；`rg -n "snippet\(|highlight\(" src-tauri/src/search` 为 0 命中。

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

1. 不得使用 FTS5 `snippet()`/`highlight()`（docs/02 §11 D06）；上下文与区间必须在 `raw_text` 上自算。
2. 不得在前端拼接 `MATCH` 串、表名或 SQL；`GlobalSearchParams` 之外不向前端暴露任何查询细节。
3. 不得自建 `Jieba` 实例或自定义切分规则；只能调 `index::segment_query`（保证文档侧与查询侧对称，docs/02 §11 D05）。
4. 不得实现文本层高亮、页内矩形计算或阅读器跳转（M08/M14 的职责），只能通过 `onOpenHit` 交出自己的 `ranges`。
5. 不得为「单汉字召回」私自加 `LIKE '%x%'` 全表扫描或 trigram 表；该策略需用户确认（§5 第 8 条）。
6. 不得让 `search_global` 与 `search_global_count` 使用两套不同的 WHERE 谓词（计数与结果必然对不上）。
7. 不得写死任何视觉数值（位置/宽高/圆角/颜色/间距/动效/字体）；一律 `TODO(ui-confirm)` 并进报告 §6。
