# 03 · 模块边界与职责

> 冻结契约。依据 master_plan §5.3、§7.1。模块数量 15，粒度按「可独立测试、可独立交付给一个 Agent」划分。

## 1. 模块总表

| ID | 模块 | 层 | 一句话职责 | 关键依赖 |
|---|---|---|---|---|
| M01 | foundation | 全栈 | 工程骨架、通信通道、日志/错误、测试环境、`pdf://` 协议壳 | — |
| M02 | contracts | 全栈 | 统一 DTO / 错误码 / Command 注册表 / TS 类型与 IPC 客户端 | M01 |
| M03 | database | Rust | Schema、迁移、Repository、SQLite 连接与探针 | M02 |
| M04 | library | Rust | 库根管理、递归扫描、元数据、增量判定、文件监控 | M03 |
| M05 | pdf-engine | TS | pdfjs-dist 封装：Document 生命周期、PageProxy、TextContent、Outline | M02 |
| M06 | render-scheduler | TS | 视口计算、渲染队列、并发与取消、Canvas/TextLayer 缓存 | M05 |
| M07 | reader-interaction | TS/React | 阅读模式、缩放、跳页、文本选择、进度回写 | M06 |
| M08 | doc-search | TS/React | 当前文献内搜索、命中坐标映射、文本层高亮 | M06, M07 |
| M09 | text-index | Rust | 页面级文本提取、jieba 分词、写入 `page_text`/`page_fts` | M03 |
| M10 | job-orchestrator | Rust | 索引任务队列、优先级、限流、取消、进度事件、崩溃恢复 | M09 |
| M11 | global-search | Rust + React | 查询解析、FTS5 检索、上下文/区间计算、结果面板 | M10, M03, M09 |
| M12 | bookmarks-progress | Rust + React | 书签 CRUD、阅读进度保存与恢复 | M03 |
| M13 | theme-settings | Rust + React | 主题令牌、护眼方案、设置持久化 | M03 |
| M14 | workspace-shell | React | 整体布局、**主页空间转盘**、文献库视图、面板编排 | M04, M11, M12, M13 |
| M15 | integration-release | 全栈 | 集成测试、性能基线、打包与发布 | 全部 |

## 2. 逐模块边界卡

每张卡按 master_plan §5.3 的九项填写。**「不负责」是硬边界**：出现越界实现视为缺陷。

### M01 foundation
- 所属层：全栈
- 核心职责：初始化 Tauri 2 + React + TS + Vite 工程；建立 `invoke` 通道与 `emit/listen` 事件通道最小可用回路；`tracing` 日志与滚动文件；`ApiError` 基类型；`pdf://` 自定义协议的**壳**（路由与 Range 语义）；vitest / cargo test 环境；`rust-toolchain.toml`、`.editorconfig`、`package.json` 脚本。
- 不负责：任何业务表结构、任何 PDF 解析、任何 UI 布局。
- 输入：无（工程起点）。
- 输出：可运行空壳应用；`ping` 命令与 `app://ready` 事件；`pdf://doc/{id}` 路由可用（先返回固定样本文件）。
- 依赖：无。
- 对外接口：`invoke("ping")`；`pdf://` 路由规则；日志初始化函数；测试环境约定。
- 关键数据结构：`AppConfig { logLevel, dataDir }`。
- 需测试：协议 Range 解析单元测试；空壳应用启动冒烟。

### M02 contracts
- 所属层：全栈
- 核心职责：定义全项目唯一的数据传输结构（Rust DTO + TS 镜像）、错误码枚举、Command 注册表（名称→入参→返回）、事件注册表（名称→payload）、分页约定、`src/core/ipc.ts` 客户端封装（含错误映射与超时）。
- 不负责：实现任何 Command 逻辑；不建表；不写 SQL。
- 输入：02-system-architecture、04-database-design、05-api-contracts。
- 输出：`src-tauri/src/contracts/*.rs`、`src/contracts/*.ts`、字段一致性检查脚本。
- 依赖：M01。
- 对外接口：所有 `*Dto`、`ApiError`、`CMD` 常量对象、`EVT` 常量对象、`call<T>()`、`subscribe<T>()`。
- 关键数据结构：`DocumentDto`、`DocumentQuery`、`Page<T>`、`GlobalSearchResult`、`ProgressDto`、`BookmarkDto`、`IndexStatusDto`、`SettingsMap`。
- 需测试：TS/Rust 字段名一致性快照；错误码完整性。

### M03 database
- 所属层：Rust
- 核心职责：SQLite 打开与 PRAGMA（WAL、foreign_keys、busy_timeout）；`schema_migrations` 与版本化迁移；各表 Repository；FTS5 能力探针（V-03）；一致性维护（级联清理、重建）。
- 不负责：扫描文件系统；分词；提取 PDF 文本；生成用户可见文案。
- 输入：迁移脚本、Repository 调用方传入的 DTO。
- 输出：Repository trait 实现；`DbCapabilities { fts5: bool, contentlessDelete: bool }`。
- 依赖：M02。
- 对外接口：见 05 §12 Repository Trait 清单（权威契约；全文签名见 module-prompts/03-database.md §8）。
- 关键数据结构：表结构见 04。
- 需测试：迁移幂等；外键级联；FTS 增删改一致性；并发读写（WAL）。

### M04 library
- 所属层：Rust
- 核心职责：库根增删改；递归扫描；文件事实（路径/大小/mtime）；**不解析 PDF**（元数据由 M09 的 `TextExtractor` 经 M10 的 `kind='meta'` 任务产出）；`(rel_path,size,mtime)` 增量判定；软删除；`notify` 监控 + 800ms 防抖；`library://changed`、`library://scan-progress` 事件。
- 不负责：提取正文；分词；建索引表；展示列表 UI。
- 输入：`library_root_add/remove` 命令；文件系统事件。
- 输出：`documents` 行（新行 `meta_state`/`text_state` 均为 `pending`）；变更事件；任务投递请求（发往 M10：`kind='meta'` 与 `kind='text'`）。
- 依赖：M03。
- 对外接口：`library_root_list/add/remove`、`document_list/get/url/recent/touch_opened/record_delete`、`library_scan_start`。
- 关键数据结构：`LibraryRootDto`、`ScanProgressEvent`、`LibraryChangedEvent`。
- 需测试：增量判定三分支；重名文件；无权限目录；损坏 PDF 不崩溃；监控防抖。

### M05 pdf-engine
- 所属层：TS
- 核心职责：`PdfEngine`（`openDocument` / `close` / `getPage` / `getTextContent` / `getOutline` / `getMetadata`）；`DocumentAdapter` 隔离 pdfjs-dist 具体类型；`PageProxy`（尺寸、旋转、viewport 计算）；`RenderTask` 包装与取消；版本适配层（V-01 结论落地）；错误归一化为 `PdfEngineError`。
- 不负责：决定渲染哪些页（M06）；绘制 UI；读取本地文件（走 `pdf://`）。
- 输入：`{ url, docId }`。
- 输出：`DocumentHandle`、`PageHandle`、`TextContentHandle`、`OutlineNode[]`、`PdfMetadata`。
- 依赖：M02。
- 对外接口：见 05 §7。
- 关键数据结构：`PageGeometry { widthPt, heightPt, rotation }`、`TextItem { str, x, y, width, height, fontSize }[]`、`TextContentHandle { items, text, itemStarts }`（字段名以 05 §7 为准）。
- 需测试：文档生命周期（打开/关闭/重复关闭）；损坏 PDF 返回 `E_PDF_CORRUPT`；TextLayer 适配兼容测试。

### M06 render-scheduler
- 所属层：TS
- 核心职责：视口模型（模式、缩放、滚动位置）→ 可见页集合与预取窗口；优先级队列；并发上限；过期任务取消；Canvas LRU（字节预算）；TextContent LRU；`dispose` 全量释放；向订阅者广播「页就绪」。
- 不负责：解析 PDF 字节；DOM 布局与样式；用户交互手势。
- 输入：`setViewport()`、`setDocument(handle)`、`subscribe(handler)`。
- 输出：`PageRenderState`（idle/queued/rendering/ready/error + bitmap + scale）。
- 依赖：M05。
- 对外接口：见 05 §7。
- 关键数据结构：`ViewportState { mode, scale, scrollTop, viewportHeight, viewportWidth, pageGeometries }`、`RenderBudget { maxConcurrent, cacheBytes, prefetchPages }`（以 05 §7 为准）。
- 需测试：快速滚动不爆任务数；缩放取消旧任务；LRU 逐出后重渲；`dispose` 后无残留 renderTask。

### M07 reader-interaction
- 所属层：React
- 核心职责：阅读界面（连续 / 单页）的 DOM 结构与滚动容器；缩放手势与快捷键；跳页；文本选择与复制；阅读进度节流保存与恢复；与 Scheduler 的桥接（订阅页状态渲染 canvas/textLayer 占位）。
- 不负责：搜索（M08）；书签存储（M12）；主题令牌（M13）；直接调 `page.render()`。
- 输入：`DocumentHandle`、`ProgressDto`、`ThemeTokens`。
- 输出：`ReaderView` 组件族；`onProgressChange`；`getSelectionText()`。
- 依赖：M06。
- 对外接口：`ReaderProvider`、`useReader()`。
- 关键数据结构：`ReaderState`。
- 需测试：模式切换不重载文档（断言 `getDocument` 只调一次）；进度恢复位置正确；缩放锚点稳定。

### M08 doc-search
- 所属层：TS/React
- 核心职责：当前文档内搜索（基于已提取 `TextContent` 的字符串匹配，含中文不分词子串匹配）；结果列表与计数；命中项 → 页 + 页内矩形坐标；文本层高亮 DOM；上一个/下一个跳转。
- 不负责：库级搜索（M11）；FTS5；索引。
- 输入：查询串、`TextContentHandle`。
- 输出：`DocSearchHit[]`、高亮指令。
- 依赖：M06、M07。
- 对外接口：`createDocSearch(searchTextProvider)`、`useDocSearch()`。
- 需测试：跨行/跨 item 命中；中文子串；大小写与全角归一；空查询。

### M09 text-index
- 所属层：Rust
- 核心职责：`TextExtractor` trait（页数、元数据、逐页文本）；pdfium 适配实现 + 纯 Rust 回退实现；jieba 分词器（单例、精确模式、标点过滤、中英混排）；写入 `page_text`；生成 `seg_text` 写入 `page_fts`；查询侧提供同一分词器（供 M11 使用）。
- 不负责：任务队列与调度（M10）；SQL 检索与排序（M11）；扫描文件（M04）。
- 输入：`document_id` + 文件路径 + 页范围。
- 输出：`ExtractedPage { pageNo, rawText }`、`SegmentedText`、`TokenizerHandle`。
- 依赖：M03。
- 对外接口：`TextExtractor`、`segment()`、`index_pages()`。
- 需测试：扫描版 PDF → `no_text`；加密 PDF → `failed` 不崩溃；分词对称性；单页表写入幂等。

### M10 job-orchestrator
- 所属层：Rust
- 核心职责：内存优先级队列 + `indexing_jobs` 持久化；入队/取消/让位；并发信号量；批间检查前台让位；`index://progress`、`index://job-finished` 事件（节流 ≤ 4 次/秒）；启动时重置 `indexing` 任务；`index_status` 快照。
- 不负责：提取或分词细节；直接写 `page_fts`。
- 输入：`enqueue()`、取消请求、启动恢复。
- 输出：任务状态流转；事件；`IndexStatusDto`。
- 依赖：M09。
- 对外接口：`index_enqueue`、`index_cancel`、`index_status`、`index_pause`（不另设 `index_resume`：恢复即 `index_pause { paused: false }`）。
- 需测试：优先级让位；取消中断；重启恢复；重试上限 3 次。

### M11 global-search
- 所属层：Rust + React
- 核心职责：查询规范化与切分；MATCH 表达式构造与注入防护；FTS5 检索 + bm25；按文档聚合；上下文窗口与命中区间计算；分页；前端搜索面板（浮层）与结果跳转。
- 不负责：索引写入；当前文献内搜索；分词器实现（用 M09）。
- 输入：`GlobalSearchParams`。
- 输出：`GlobalSearchResult`、`GlobalSearchPage`。
- 依赖：M10、M03、M09。
- 对外接口：`search_global`、`search_global_count`，`GlobalSearchPanel` 组件。
- 需测试：特殊字符；<3 字符中文查询；100k 页规模响应时间。

### M12 bookmarks-progress
- 所属层：Rust + React
- 核心职责：书签 CRUD（标题/备注/颜色/页码）；按文档列出；跳转；阅读进度保存（节流 1s）与读取；「继续阅读」数据源。
- 不负责：PDF 内置 Outline（属 M05 只读数据，不落库）；阅读器布局。
- 输入：`BookmarkDto`、`ProgressDto`。
- 输出：书签列表；`ProgressDto`；最近阅读排序数据。
- 依赖：M03。
- 对外接口：`bookmark_*`、`progress_get/save`，`BookmarkList`、`useProgressPersistence()`。
- 需测试：级联删除；节流不丢最后一次；恢复位置夹取。

### M13 theme-settings
- 所属层：Rust + React
- 核心职责：主题令牌（light / dark / paper）；护眼方案（外围背景 + 可选暖色光罩，**不改 canvas 像素**）；CSS 变量注入；设置读写（`app_settings`）；默认值合并；设置面板骨架（视觉待确认）。
- 不负责：PDF 内容处理；单文档级临时覆盖。
- 输入：`SettingsMap`。
- 输出：`ThemeTokens`、`useTheme()`、`settings_get_all/set`。
- 依赖：M03。
- 对外接口：`ThemeTokens` 变量名表（冻结）、`settings_*`。
- 需测试：令牌完整性；持久化往返；非法值回退默认。

### M14 workspace-shell
- 所属层：React
- 核心职责：应用总布局与路由（`home` / `library` / `reader` / `settings`）；**主页空间转盘**（见 13-ui-home-concept.md，本模块最高优先级设计物）；文献库视图；面板编排；模块间跳转编排。
- 不负责：数据查询实现；阅读渲染；主题令牌定义。
- 输入：`DocumentDto[]`、`GlobalSearchResult`、`ProgressDto`、`ThemeTokens`。
- 输出：布局组件、路由、转盘组件、面板组件。
- 依赖：M04、M11、M12、M13（可先 mock）。
- 对外接口：`AppShell`、`useRouter()`、`HomeSpace`。
- 需测试：路由切换不重建文档；转盘 N=1/2/12/60 布局不崩；键盘可达性。

### M15 integration-release
- 所属层：全栈
- 核心职责：集成测试编排、真实 PDF 样本库、性能基线（首屏时间、滚动帧率、搜索 P95、内存峰值）、打包配置（Windows 优先）、发布检查清单、已知限制文档。
- 不负责：新增业务功能；修改其他模块契约。
- 输入：全部模块。
- 输出：测试基线文档、打包产物、验收报告。
- 依赖：全部。
- 需测试：端到端脚本 + 人工清单。

## 3. 开发顺序与并行组

```text
串行主链（不可并行）:
  M01 -> M02 -> M03

第一批并行（M03 完成后同时开工）:
  A: M04 (library)
  B: M09 -> M10 -> M11   （后端检索链，必须串行）
  C: M12 (bookmarks-progress)
  D: M13 (theme-settings)

第二批并行（前端链，可与第一批同时进行，只依赖 M02）:
  E: M05 -> M06 -> M07 -> M08   （必须串行）

第三批（汇聚）:
  M14 workspace-shell（依赖 A/B/C/D 的接口；先 mock 后接线）
  M15 integration-release（最后）
```

**并行约束**：E 链在 M02 冻结后即可开工，不必等任何 Rust 业务模块；M14 越早开工越好，但只能对着 mock 数据源写，接口一旦就绪就必须切到真实数据源（不得长期保留 mock 分支）。

## 4. 文件归属矩阵（防止多 Agent 改同一文件）

| 路径 | 归属模块 | 其他模块可否修改 |
|---|---|---|
| `src-tauri/src/main.rs`、`lib.rs` | M01 | 仅以「注册一行」方式追加（交付报告中声明） |
| `src-tauri/src/contracts/**` | M02 | 否（变更 = 架构变更） |
| `src/contracts/**`、`src/core/ipc.ts` | M02 | 否 |
| `src-tauri/src/db/**`、`migrations/**` | M03 | 否 |
| `src-tauri/src/library/**` | M04 | 否 |
| `src-tauri/src/index/**` | M09 | 否 |
| `src-tauri/src/jobs/**` | M10 | 否 |
| `src-tauri/src/search/**` | M11 | 否 |
| `src-tauri/src/aux/bookmarks/**` | M12 | 否 |
| `src-tauri/src/aux/progress/**` | M12 | 否 |
| `src-tauri/src/aux/settings/**` | M13 | 否 |
| `src/pdf-engine/**` | M05 | 否 |
| `src/render/**` | M06 | 否 |
| `src/reader/**` | M07 | 否 |
| `src/reader/search/**` | M08 | 否 |
| `src/workspace/**` | M14 | 否 |
| `src/ui/**`（无状态基础组件） | M14 | 其他模块可复用但不得改；需要新组件时在本模块目录内建 |
| `src/features/search-panel/**` | M11 | 否 |
| `src/theme/**` | M13 | 否 |
| `src/features/bookmarks/**`、`src/features/progress/**` | M12 | 否 |
| `src/app/**`（router/shell 装配入口） | M14 | 否 |
| `src/dev/**`（mock 数据源、调试开关） | M14（仅 debug 构建使用） | 否 |
| `src-tauri/tauri.conf.json` | M01 建立骨架；**M15 唯一有权改打包相关键** | 其他模块只读 |
| `tests/**`（集成测试、样本说明） | M15 | 各模块可新增本模块子目录 |
| `scripts/**` | M02（契约检查）/ M15（基线脚本） | 否 |
| `artifacts/**`（截图、基线记录） | M15 | 各模块可写自己子目录 |
| `docs/**` | Lead | 模块只能追加各自「实现说明」小节 |

## 5. 冲突处理规则

1. 需要别的模块提供新接口 → 先在交付报告写「接口需求」，由 Lead 决定是扩展契约还是用现有接口实现；**不得**自己改别人的文件。
2. 两个模块都认为该功能归自己 → 以本文档「不负责」一栏为准；仍冲突则上报。
3. 契约字段必须变更 → 标记「架构变更」，列出受影响模块清单，等待批准后再改。
4. 发现本文档本身有错 → 提出，不在代码里顺手绕过。
