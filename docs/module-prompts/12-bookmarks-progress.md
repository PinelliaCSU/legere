# 模块 M12：bookmarks-progress（书签与阅读进度）

> 依赖前置：M02 contracts（DTO / `CMD` / `src/core/ipc.ts`）、M03 database（`bookmarks` / `reading_progress` 表与写队列）。
> 被依赖方：M14 workspace-shell（书签面板、继续阅读）、M07 reader-interaction（进度回写的唯一调用方）。
> 归属层：L0 Rust（`src-tauri/src/aux/**`）+ L4 React（面板与 hook）；并行组：C（03 §3 第 194 行）。

## 1. 模块身份

M12 同时站在两端：L0 侧它只是 `bookmarks` 与 `reading_progress` 两张表（04 §3 第 118-140 行）的读写者；L4 侧它提供书签面板组件与「进度节流保存 / 恢复」的 hook（03 §2 M12 第 153 行）。
它不参与阅读渲染，也不知道 PDF 如何解析：M07 在滚动停止时把「页码 / 页内比例 / 缩放 / 模式」交给它，它负责节流、夹取与落库。
在数据流中它是「用户痕迹」的唯一入口——除书签与进度外，它不写任何表。

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

一句话：**给定 `documentId`，书签增删改查与阅读进度的保存/恢复全部可用、可测，且进度保存不会因节流丢掉最后一次值。**

分解目标：
1. 六个 Command 按 05 §3 第 191-196 行实现并注册，错误码与契约一致。
2. 进度保存节流 1000ms，并有 4 个强制 flush 触发点（卸载 / 失焦 / `pagehide` / 窗口关闭）。
3. 恢复时 `pageNo` 按当前 `pageCount` 夹取、`scrollRatio` 夹到 [0,1]（04 §4 第 161 行）。
4. 「继续阅读」的数据口径写明，且只提供本模块那一半（`progress_get` + `updated_at`）。
5. 书签面板结构可测（数据进来、事件出去），样式一律不落值。
6. 级联删除后的行为由可执行用例锁定（04 §6 第 176 行）。

## 4. 功能范围（必须完成）

1. `bookmark_list`：`{ documentId }` → `BookmarkDto[]`；排序 `page_no ASC, created_at ASC`（由 04 §3 第 129 行的 `idx_bookmarks_doc(document_id, page_no)` 支撑）；`documentId` 不存在时返回空数组（契约未给 `E_NOT_FOUND`，见 §6 契约缺口 3）。
2. `bookmark_create`：`{ documentId, pageNo, title, note?, color? }` → `BookmarkDto`。校验：`pageNo >= 1`（04 §3 第 121 行 `CHECK`）；`title` 去首尾空白后非空，否则 `E_INVALID_ARG`；`note`/`color` 缺省存 `NULL`；`created_at` 与 `updated_at` 同一值（UTC ISO-8601，04 §1 第 8 行）。
3. 标题缺省规则（**前端侧**）：用户不填标题时，以 `DEFAULT_BOOKMARK_TITLE(pageNo)` 生成默认标题并**显式传入** `title`；Rust 侧不生成任何文案。默认文案冻结为 `第 ${pageNo} 页`（本题给定），单点定义在 `default-title.ts`。
4. `bookmark_update`：`{ id, title?, note?, color? }` → `BookmarkDto`；语义「未提供 = 不改，提供则整体覆盖」（因此 `note: null` 表示清空）；`id` 不存在 → `E_NOT_FOUND`；`title` 提供且为空白 → `E_INVALID_ARG`；同事务刷新 `updated_at`。
5. `bookmark_delete`：`{ id }` → `void`；`id` 不存在 → `E_NOT_FOUND`。判定用 `rows_affected == 0`，禁止「先查后删」（两者之间可被其它写抢占）。
6. `color` 语义：可选字符串，可为 `null`。本模块**不校验色值集合**（色板属视觉决策，见 §7 第 2 条），只拒绝含控制字符或长度 > 32 的串 → `E_INVALID_ARG`。该上限为本模块自定细节，交付报告 §9 记录。
7. `progress_get`：`{ documentId }` → `ProgressDto | null`；无行返回 `null`（不合成默认值，调用方自己决定初始位置）；读回时把 `scrollRatio` 夹到 [0,1]（历史脏数据容错）。
8. `progress_save`：`{ progress: ProgressDto }` → `void`；按 `document_id` 主键 upsert（`INSERT ... ON CONFLICT(document_id) DO UPDATE`），写入 `updated_at`。入参校验：`pageNo >= 1`、`scrollRatio ∈ [0,1]`、`zoom > 0`、`mode ∈ {continuous, single}`，任一不满足 → `E_INVALID_ARG`（**写入口拒绝越界，不静默夹取**；夹取只发生在读回与恢复）。
9. 节流保存（React）：`useProgressPersistence({ documentId })` 内部 1000ms trailing 节流；同一 1s 窗口内 N 次 `record()` 只发一次 `progress_save`，且发送的是**最新**值。
10. 强制 flush（不受节流窗口约束，立即发送）：(a) 组件卸载 / 文档关闭前；(b) `document.visibilitychange` → `hidden`；(c) `pagehide`；(d) 窗口关闭（Tauri API 先按 §11 步骤 6 验证）。
11. 恢复：`useProgressRestore(documentId, pageCount)` + 纯函数 `clampProgress(saved, pageCount)`；`pageNo = clamp(saved.pageNo, 1, pageCount ?? saved.pageNo)`（`pageCount` 为 `null` 即未知，不夹上界）；`scrollRatio = clamp(saved.scrollRatio, 0, 1)`。
12. 「继续阅读」数据源口径：`reading_progress.updated_at` 由本模块保证正确，`progress_get` 可判空；而「最近阅读」的**排序查询**归 M04 的 `document_recent({ limit })`（03 §2 M04 第 69 行、05 §3 第 181 行），`DocumentDto.hasProgress` 由 M04/M03 填充（05 §2 第 82、161 行）。M14 负责组合两者。本模块**不新增**任何查询 Command。
13. `BookmarkList` 纯展示组件 + `useBookmarks(documentId)` 容器 hook：列出当前文档书签、按 `pageNo` 升序、点击条目触发 `onJump(pageNo)`、可删除、可编辑标题/备注；空态容器带 `data-bookmark-empty` 锚点；当前页高亮【待你确认】。
14. 本模块**不发送**任何事件，也不监听任何事件（书签/进度变更不影响 `library://changed` 的语义）。

## 5. 非目标（明确不做）

### 5.0 已由 Lead 裁决的技术参数（**不再询问，按此实现**）

以下条目曾标为「待你确认」，但属技术参数且**已由 Lead 按官方文档与工程判断裁决**：**T9** —— 明细与理由见 `docs/14-ui-decision-register.md` §1 对应行。实现时直接落该值，**不得**再当作待确认项停下来问；若你认为某条在本模块不成立，在交付报告 §9 提出并说明，不要自行改动。

1. **不处理 PDF 内置 Outline**：Outline 由 M05 的 `getOutline()` 只读提供（05 §7 第 261 行），**不落库**（03 §2 M12 第 149 行、04 §3 第 117 行注释）。把它写进 `bookmarks` 或新建 outline 表都是缺陷。
2. 不做阅读器布局、滚动容器、缩放手势（M07）；不做文内搜索（M08）。
3. 不实现 `document_recent` 的排序与查询（M04），不做「继续阅读」的卡片视觉。
4. 不做书签导出/导入、跨库统计、标签体系、折叠分组、多文档聚合视图。
5. 不新增 Command / 事件 / DTO 字段；需要时按 03 §5 第 234 行写「接口需求」等 Lead 裁定。
6. 不写级联删除 SQL：删文档时同事务清 FTS 与子表属 M03（04 §6 第 176 行）。
7. **不得自行确定视觉方案**：书签面板任何尺寸/颜色/间距/圆角/动效/字体、色板具体色值、删除确认形态、空态文案，全部属于 §7【待你确认】，实现时留 `TODO(ui-confirm)` 占位。
8. 不做 OCR、不做文本提取、不读 PDF 字节。

## 6. 架构约束

- 允许依赖：仅 M02（`src/contracts/*` 的 DTO 与 `CMD` 常量、`src/core/ipc.ts` 的 `call`）与 M03（连接 / 写队列）。
- 禁止依赖：M04/M09/M10/M11 的任何 Rust 模块；前端禁止 import `src/pdf-engine/**`、`src/render/**`、`src/reader/**`（02 §2 第 56-60 行：L4 不得跨层调 L2）。前端不得出现 SQL 或表名（_shared-context §D）。
- SQL 归属：两张表的 SQL 写在本模块 `aux/bookmarks/repo.rs`、`aux/progress/repo.rs`，但**必须复用 M03 的写队列**（04 §2 第 22 行：所有写操作经 `WriteQueue` 串行化），不得自行 `Connection::open`。
- 状态归属：书签与进度的唯一真源是 SQLite。React 侧只允许持有「待发送的最新值」，禁止写 `localStorage` / `sessionStorage` / 自建文件。
- 资源所有权：本模块不持有 `DocumentHandle`、不持有 canvas、不开文件句柄。
- 契约缺口（需 Lead 裁定，不得自行改契约）：
  1. 03 §2 M03 第 58 行写「对外接口：见 05 §3 Repository Trait 清单」，但 05 §3 第 170-199 行只有 Command 注册表，**没有 Repository Trait 清单**。本模块按「自写 SQL + 复用 M03 连接/写队列」实现；若 M03 后续提供同名 Repository，改用之并删除本模块 SQL。
  2. 03 §4 第 209-230 行的文件归属矩阵**未给 M12 分配前端目录**。本模块按 `src/features/bookmarks/**` 实现（与 03 §4 第 228 行 M11 的 `src/features/search-panel/**` 同级命名），并在交付报告 §9 声明，请 Lead 归档。
  3. `bookmark_list` 对未知 `documentId` 返回空数组、不抛错 —— **已由 Lead 裁决为 R19**（05 §3 第 6 条），按此实现，交付报告 §9 不必再报缺口。
  4. `progress_save` 对未知 `documentId` 必须返回 `E_NOT_FOUND`（**R19 已裁决**，先做存在性检查，禁止让它退化成外键错误 `E_DB`）。原文此处曾建议返回 `E_INVALID_ARG`，以 R19 为准。旧文续：ocumentId` 视为越界参数），并在报告 §9 记录该解释。

## 7. 输入与输出

| 输入来源 | 数据形态 | 触发时机 |
|---|---|---|
| M07 reader-interaction | `ProgressDto` 去掉 `documentId`/`updatedAt` 的部分（05 §2 第 105-108 行） | 滚动停止、1s 节流到期、卸载、失焦、`pagehide` |
| 用户（书签面板） | `{ pageNo, title?, note?, color? }` | 点击「添加书签」 |
| M14 workspace-shell | `documentId`、`pageCount`（取自 `DocumentDetailDto`，05 §2 第 76 行） | 进入阅读器 / 恢复进度 |
| M03 database | `BookmarkRow` / `ProgressRow` | 查询返回 |

| 输出目标 | 数据形态 | 消费方 |
|---|---|---|
| 前端（经 L1 `call`） | `BookmarkDto[]`、`ProgressDto | null` | M14 面板、M07 恢复 |
| SQLite | `bookmarks` / `reading_progress` 行 | M03、M04 的 `hasProgress`（05 §2 第 161 行） |
| M07 | `{ pageNo, scrollRatio, zoom, mode }` | 阅读器初始定位 |

### 7.2 【待你确认】清单（实现时留 `TODO(ui-confirm)`）

1. ~~书签条目形态~~ → **D26 已拍板**：左侧抽屉，宽 `360px` 全高；**单行条目**（页码 + 标题，不显示备注摘要与时间）；6 色色标；删除需二次确认（用应用内浮层，不用系统原生弹窗，见 T9）。仍然待确认：
2. 色板：具体的书签颜色集合（色值属于视觉决策）；`color = null` 时的默认呈现。
3. ~~删除二次确认~~ → **D26 已拍板**：需要确认，形态为应用内浮层（不是系统原生弹窗、不是行内二次点击）。
4. 空态文案与「当前页无书签」提示的文案。
5. 当前页书签的高亮表现（边框 / 左侧色条 / 加粗）。
6. ~~面板容器形态~~ → **D26 已拍板**：左侧抽屉（`AppShell` 编排，M12 只提供内容组件）。
7. 面板内是否显示「跳转到书签」以外的操作（编辑备注入口的位置）。
8. 默认书签标题的最终文案（现按本题给定实现为 `第 N 页`；是否带空格、是否需要 `P.N` 变体）。

## 8. 接口契约

Rust Command（签名与 05 §3 第 191-196 行一致，入参一律单对象，05 §3 第 203 行）：

```rust
// src-tauri/src/aux/bookmarks/commands.rs
#[tauri::command]
pub async fn bookmark_list(document_id: i64) -> Result<Vec<BookmarkDto>, ApiError>;

#[tauri::command]
pub async fn bookmark_create(document_id: i64, page_no: i64, title: String,
                             note: Option<String>, color: Option<String>)
                             -> Result<BookmarkDto, ApiError>;

#[tauri::command]
pub async fn bookmark_update(id: i64, title: Option<String>, note: Option<String>,
                             color: Option<String>) -> Result<BookmarkDto, ApiError>;

#[tauri::command]
pub async fn bookmark_delete(id: i64) -> Result<(), ApiError>;
```

```rust
// src-tauri/src/aux/progress/commands.rs
#[tauri::command]
pub async fn progress_get(document_id: i64) -> Result<Option<ProgressDto>, ApiError>;

#[tauri::command]
pub async fn progress_save(progress: ProgressDto) -> Result<(), ApiError>;
```

前端调用口径：命令参数在 Rust 侧为 `snake_case`，前端 `invoke` 的键按契约写 `camelCase`（`documentId` / `pageNo`）。**实现前先验证**这一映射是否由 Tauri 2 默认完成：写一个最小命令 `fn probe(my_arg: i32)`，用 `{ myArg: 1 }` 与 `{ my_arg: 1 }` 各调一次；判据 = 只有 `camelCase` 形式成功。若两者都失败，改用 `#[tauri::command(rename_all = "camelCase")]` 显式声明。

本模块自定的内部接口（契约未定义，属本模块所有）：

```ts
// src/features/bookmarks/use-bookmarks.ts
export function useBookmarks(documentId: number): {
  items: BookmarkDto[]; loading: boolean; error: ApiError | null;
  reload(): Promise<void>;
  create(input: { pageNo: number; title?: string; note?: string | null; color?: string | null }): Promise<void>;
  update(id: number, patch: { title?: string; note?: string | null; color?: string | null }): Promise<void>;
  remove(id: number): Promise<void>;
};

// src/features/bookmarks/BookmarkList.tsx —— 纯展示，不发 IPC
export interface BookmarkListProps {
  items: BookmarkDto[];
  currentPage: number;
  loading: boolean;
  error: ApiError | null;
  onJump(pageNo: number): void;
  onDelete(id: number): void;
  onEdit(id: number, patch: { title?: string; note?: string | null; color?: string | null }): void;
}

// src/features/bookmarks/progress-persistence.ts
export function useProgressPersistence(opts: { documentId: number }): {
  record(value: { pageNo: number; scrollRatio: number; zoom: number; mode: ReadMode }): void;
  flush(): Promise<void>;
  readonly pendingValue: ProgressDto | null;
};
// 节流窗口冻结为 1000ms，不开放给调用方修改。

// src/features/bookmarks/progress-restore.ts（纯函数，可单测）
export function clampProgress(
  saved: ProgressDto, pageCount: number | null
): { pageNo: number; scrollRatio: number; zoom: number; mode: ReadMode };

export function useProgressRestore(documentId: number, pageCount: number | null): {
  state: "loading" | "ready" | "none" | "error";
  value: { pageNo: number; scrollRatio: number; zoom: number; mode: ReadMode } | null;
  error: ApiError | null;
};
```

## 9. 数据结构

`bookmarks`（04 §3 第 118-129 行，列名逐字）：

| 列 | 类型 | 本模块读写规则 |
|---|---|---|
| `id` | INTEGER PK | 自增由 SQLite 分配，不手写 |
| `document_id` | INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE | 由入参给定，不做存在性预检 |
| `page_no` | INTEGER NOT NULL CHECK (page_no >= 1) | 入参先校验，再落库 |
| `title` | TEXT NOT NULL | 去空白后必须非空 |
| `note` | TEXT | `null` 存 NULL |
| `color` | TEXT | `null` 存 NULL；不校验色值 |
| `created_at` | TEXT NOT NULL | UTC ISO-8601 |
| `updated_at` | TEXT NOT NULL | 每次 update 刷新 |

`reading_progress`（04 §3 第 132-140 行，一文档一行）：

| 列 | 类型 | 本模块读写规则 |
|---|---|---|
| `document_id` | INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE | upsert 冲突键 |
| `page_no` | INTEGER NOT NULL CHECK (page_no >= 1) | 入参校验 >= 1 |
| `scroll_ratio` | REAL NOT NULL DEFAULT 0 | 入参 [0,1]；读回夹取 |
| `zoom` | REAL NOT NULL DEFAULT 1.0 | 入参 > 0 |
| `mode` | TEXT NOT NULL DEFAULT 'continuous' CHECK IN ('continuous','single') | 入参必须命中枚举 |
| `updated_at` | TEXT NOT NULL | 每次 upsert 刷新 |

DTO 字段见 05 §2 第 110-114 行（`BookmarkDto`）与第 105-108 行（`ProgressDto`）；`ReadMode` 见 05 §2 第 67 行。本模块不新增 DTO、不改任何列。

## 10. 文件组织

```text
src-tauri/src/aux/bookmarks/
  mod.rs       # 模块出口：4 个命令名清单 + pub use
  commands.rs  # #[tauri::command]，只做参数校验 + DTO 转换
  repo.rs      # 4 条 SQL，走 M03 写队列
  model.rs     # BookmarkRow <-> BookmarkDto
  tests.rs     # #[cfg(test)]
src-tauri/src/aux/progress/
  mod.rs / commands.rs / repo.rs / model.rs / tests.rs   # 同上，2 个命令 + upsert
src/features/bookmarks/
  BookmarkList.tsx       # 纯展示组件（结构定、样式待确认）
  use-bookmarks.ts       # IPC 容器 hook
  default-title.ts       # 默认标题单点定义
  progress-persistence.ts# 节流 + flush
  progress-restore.ts    # clampProgress 纯函数 + 恢复 hook
  *.test.ts
```

## 11. 实施步骤

1. 建 `aux/bookmarks` 骨架与 `model.rs`（Row ↔ Dto，含时间格式），`cargo check` 通过——此步不连库。
2. `repo.rs` 四条 SQL + `commands.rs` 四个命令 + 注册；用测试内固定临时 DB 跑 CRUD 用例。
3. `aux/progress` 同法：upsert + `progress_get` 读回夹取；两条错误路径用例（`pageNo=0`、`scrollRatio=1.5`）。
4. 级联用例：删 `documents` 行后两张子表计数为 0（依赖 `PRAGMA foreign_keys = ON`，04 §2 第 17 行；若 M03 未开启则本步**阻塞并上报**，不得自行关闭外键）。
5. `default-title.ts` + `progress-restore.ts` 纯函数与单测（夹取三分支）。
6. `progress-persistence.ts` 的节流与 4 个 flush 触发点。**先验证**窗口关闭 API：`npx tauri --version` 后读 `node_modules/@tauri-apps/api/window.d.ts`，抄录 `onCloseRequested` 签名；判据 = 存在返回 `Promise<UnlistenFn>` 的 `onCloseRequested(handler)`。若不满足，只用 `visibilitychange` + `pagehide`，并在报告写「窗口关闭可能丢最后 <1s 进度」。
7. `useBookmarks` 接 6 个命令；`BookmarkList` 纯展示 + `data-bookmark-empty` 锚点。
8. `cargo clippy --all-targets -- -D warnings` 与 `tsc --noEmit` 清零；单文件 < 600 行、单函数 < 80 行。

## 12. 测试要求

Rust（`#[cfg(test)]`，跑在真实 SQLite 临时文件上，不用内存 mock 替代 SQL）：
- 正常：create → list（1 条）→ update(title) → list（标题变、`updated_at` 不小于旧值）→ delete → list（0 条）。
- 边界：`pageNo = 1` 与 `pageNo` 极大值；`note = None` 与 `note = Some("")`；重复 delete 第二次返回 `E_NOT_FOUND`。
- 错误：`title = "   "` → `E_INVALID_ARG`；`pageNo = 0` → `E_INVALID_ARG`；`id` 不存在 → `E_NOT_FOUND`。
- 进度：连续两次 save 后行数 = 1 且值 = 第二次；`progress_get` 对无行返回 `None`；脏数据 `scroll_ratio = 1.4` 读回为 `1.0`。
- 级联：删 `documents` 行 → 两子表计数 0。
- 重开：关闭连接后重新打开同一 DB 文件，进度仍在（等价「重启后恢复」）。

TS（vitest）：
- 节流：`vi.useFakeTimers()`，1s 内 10 次 `record()` → `call` 计数 1，参数 = 第 10 次值；再前进 1000ms 后计数仍为 1（无多余尾包）。
- flush：`visibilitychange`(hidden) 后立即 1 次；`unmount()` 后剩余待发值发送 1 次。
- 夹取：`clampProgress({pageNo:999, scrollRatio:1.4}, 10)` → `{pageNo:10, scrollRatio:1}`；`pageCount = null` → `pageNo 999`；`scrollRatio = -0.2` → 0。
- 默认标题：`DEFAULT_BOOKMARK_TITLE(7) === "第 7 页"`。
- 组件：3 条 fixture 渲染 3 条；点击第 2 条 `onJump` 收到其 `pageNo`；空数组渲染 `data-bookmark-empty`。

命令（包管理器以仓库 `package.json` 的 `packageManager` 字段为准；下按 npm 写，pnpm 同理替换）：

```bash
cd src-tauri && cargo test aux:: && cargo clippy --all-targets -- -D warnings
npx vitest run src/features/bookmarks && npx tsc --noEmit
```

## 13. 验收标准

1. **级联删除**：插入 1 文档 + 2 书签 + 1 进度，执行 `DELETE FROM documents WHERE id=?` 后 `SELECT COUNT(*) FROM bookmarks` = 0 且 `reading_progress` = 0（用例名 `cascade_removes_bookmarks_and_progress`）。
2. **节流**：连续 10 次保存只有最后一次发送并落库——`progress_save` 调用计数 = 1，参数 = 第 10 次值；随后查库 `page_no` = 第 10 次值，`updated_at` 非空。
3. **超界夹取**：`pageCount = 10` + 存 `pageNo = 999` → 恢复 `pageNo = 10`；`pageCount = null` → 999 不被夹取；`scrollRatio` 1.4 → 1、-0.2 → 0。
4. **重启可恢复**：`progress_save` → 关闭连接/应用 → 重开后 `progress_get` 返回同一 `pageNo`（自动化用「关闭连接后重开同一 DB 文件」用例；人工重启作为补充观察）。
5. 6 个 Command 在 `CMD` 常量与 Rust `#[tauri::command]` 注册集合中一一对应（比对方式见 05 §10 第 363 行）。
6. 错误路径全部返回契约错误码：空白 `title` → `E_INVALID_ARG`；`pageNo = 0` → `E_INVALID_ARG`；未知 `id` → `E_NOT_FOUND`；重复 delete → `E_NOT_FOUND`。
7. 书签面板：3 条 fixture 渲染 3 条、点击第 2 条 `onJump` 收到其 `pageNo`、空数组渲染 `data-bookmark-empty` 容器且不渲染任何条目节点。
8. `cargo clippy --all-targets -- -D warnings` 与 `npx tsc --noEmit` 均 0 错误；本模块文件无 `unwrap()`/`expect()`；单文件 < 600 行。
9. 交付报告 §6 逐条列出 §7.2 的 8 条待确认项与当前占位实现。

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

1. 不得把 PDF 内置 Outline 写入 `bookmarks` 或新建任何 outline 表。
2. 不得在 Rust 侧生成默认标题文案（默认标题只在 `default-title.ts` 一处）。
3. 不得新增契约外的 Command（如 `bookmark_search` / `bookmark_reorder` / `progress_delete`）。
4. 不得为节流引入第二真源（`localStorage` / `sessionStorage` / 自建文件）；唯一真源是 `reading_progress`。
5. 不得为了让「只落最后一次」的断言通过而把节流改成 debounce 之外的手工补发（如先发一次再发一次）。
6. 不得自行决定书签色值、面板视觉与删除确认形态。
