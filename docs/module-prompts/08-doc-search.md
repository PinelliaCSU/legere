# 模块 M08：doc-search

> 依赖前置：M06 render-scheduler、M07 reader-interaction（`ReaderApi` 与文本层容器已可用）、M05 的 `TextContentHandle` 与 `getItemRanges()`；被依赖方：M15 integration-release。
> 归属层：L3（TS/React）；并行组：E（`M05 → M06 → M07 → M08` 串行，见 `docs/03-module-boundaries.md` §3 第 197–198 行）。

## 1. 模块身份

M08 是"当前打开的这本 PDF 里找字"：它从已提取的 `TextContentHandle.text` 上做**字面量子串匹配**（中文不分词），把命中换算成「页码 + 页内矩形的列表」，再交给 M07 的页面层级画出高亮层，并提供上一个/下一个与计数。
它不做库级检索（M11 的 FTS5 索引），不写索引，不解析 PDF 字节。它是 master_plan §3.4「当前文献搜索」的唯一实现者，也是搜索结果 → 页面坐标映射（§5.6 第 5 项难点）的落点。

## 2. 项目背景

### A. 项目背景

你在开发 **Legere**：一款**个人使用**的本地 PDF 文献库阅读器桌面应用（Tauri 2 + Rust 后端 + React/TS 前端）。它不是一个"PDF 查看器"，而是「文献库管理 + 全文检索 + 自定义阅读体验」三者的结合体。

Local-first 硬约束：

- PDF 文件永远在本地，不上传、不联网同步。
- 索引、书签、进度、设置全部存本地 SQLite。
- 不依赖任何云服务；离线可用是核心能力。

产品形态要点（来自用户本人）：

- **阅读界面完全自定义**，不使用 PDF.js 默认 Viewer 的 UI。PDF.js 只作为底层能力（加载、渲染、文本提取、Outline）。
- 应用有**用户亲自设计的入口主页**：书脊沿圆周排布的空间转盘，可见弧渲染书脊并可交互，隐藏弧**完全不渲染**任何书籍信息。详见 `docs/13-ui-home-concept.md`。
- 不做 OCR；扫描版 PDF 允许索引失败，但应用不得崩溃、不得伪装成功。

### B. 技术栈（已冻结，不得替换）

Tauri 2 · Rust（edition 2021）· React + TypeScript + Vite · pdfjs-dist（**仅 Display API**）· SQLite（`rusqlite` bundled）· FTS5 · `jieba-rs` · Tokio · `notify` · Zustand · Tailwind CSS · serde。

若要替换任何一项：先停止实现，在交付报告中写「技术选择异议」并说明（1）问题（2）影响（3）现有栈内能否解决（4）是否必须替换（5）替换成本。**不得**自行更换。

### C. 必须阅读的冻结契约（本次实现的唯一事实来源）

| 文件 | 提供什么 |
|---|---|
| `docs/02-system-architecture.md` | 分层、依赖方向、数据流、6 张架构图、决策记录 D01–D12、待验证项 V-01–V-07 |
| `docs/03-module-boundaries.md` | 15 个模块的职责/不负责/输入输出/文件归属矩阵/并行组 |
| `docs/04-database-design.md` | 完整 DDL、字段语义、迁移、一致性、FTS5 细节 |
| `docs/05-api-contracts.md` | ApiError、DTO、28 个 Command、5 个事件、`pdf://` 协议、PDF Engine 接口 |
| `docs/13-ui-home-concept.md` | 主页空间转盘的唯一设计说明 |

规则：**契约优先于直觉**。契约没写的细节你可以自行决定并记录；契约写了的，不许改；契约有矛盾或缺失，报告「契约问题」，不要自作主张。

### D. 分层与依赖方向（硬约束）

```text
L4 Workspace（文献库/主页/全局搜索/设置）
L3 Reader Interaction（模式/缩放/导航/选择）
L2 PDF Engine（Document/PageProxy/RenderScheduler）
L1 IPC Client（invoke 封装/事件/错误映射）
L0 Rust Core（db/library/index/search/fs）
```

- 依赖只能自上而下；L2 不得 import L3/L4；L3/L4 不得 import `pdfjs-dist`；前端不得出现 SQL 或表名。

### E. 通用工程规范

1. TypeScript `strict: true`；禁止 `any`（必须时用 `unknown` + 收窄），禁止 `// @ts-ignore`。
2. Rust 禁止 `unwrap()`/`expect()`（测试代码与启动期常量除外）；禁止把 `anyhow` 字符串直接抛给前端。
3. 单文件超 600 行先拆分；单函数超 80 行先拆函数。
4. 错误必须显式处理：要么转换为 `ApiError`，要么 `warn!`/`console.warn` 并带上下文。静默吞错误视为缺陷。
5. 不写"自我描述"注释（`// 这里是循环`）；只写"为什么"（`// rowid 复用会串号，所以同事务删除`）。
6. 命名遵循 `docs/05-api-contracts.md` §9。
7. 不引入新的大型依赖（新增 runtime 依赖需在报告中说明理由与体积影响）。

## 3. 模块目标

交付 `src/reader/search/` ：给定查询串与一个"逐页文本提供者"，产出 `DocSearchHit[]`（页码 + 页内矩形 + 上下文），并在 M07 的页面层级上画出不拦截指针与选择的高亮，支持上一个/下一个与计数；1000 页文档首次搜索 P95 < 500ms（文本就绪前提下，测法见 §12）。

分解目标：

1. 中文不分词的字面子串匹配："分词的效" 这类片段能命中。
2. 归一化**等长**（大小写 / 全角→半角），因此字符索引可直接映射回矩形。
3. 跨 item / 跨行命中产出多个矩形（每行一个），不合并成一个大框。
4. 命中矩形与 M05 的 `items/text` 对齐规则一致（同一 `getItemRanges`）。
5. 高亮层 `pointer-events: none`，不拦截文本选择。
6. 空查询禁用且零扫描；超长文档增量扫描可取消。

## 4. 功能范围（必须完成）

### 4.1 文本提供者（唯一的取文本入口）

1. `createDocSearch(provider)`（03 §M08 第 113 行）：

```ts
export interface SearchTextProvider {
  readonly pageCount: number;
  getPageText(pageNo: number): Promise<TextContentHandle | null>;   // null = 该页文本暂不可得
}
```

2. 实际接线由 M07 完成（内部实现：经 `RenderScheduler.getPageState(pageNo)` 命中 textContent 缓存即用，否则 `DocumentHandle.getPage(pageNo).getTextContent()`）。**M08 不得**直接 `openDocument`、不得自己创建调度、不得调用 `render()`。
3. `getPageText` reject 或返回 `null` → 该页跳过并计入 `skippedPages`，继续下一页；`console.warn` 带 `pageNo`（不得静默吞掉，也不得整体失败）。

### 4.2 归一化规则表（等长是硬约束）

4. 归一化在"查询串"和"页面文本"上**用同一函数** `normalizeForKey(s)`（`src/reader/search/normalize.ts`），逐码点产出**等长**结果：

| 原码点 | 归一化为 | 是否等长 | 理由 |
|---|---|---|---|
| ASCII `A–Z` | 加 0x20 转小写 | 是（1→1） | 大小写不敏感检索 |
| 全角 ASCII `U+FF01–U+FF5E` | 减 0xFEE0 得半角 | 是（1→1） | 中文输入法常打出全角标点/字母 |
| 全角空格 `U+3000` | `U+0020` | 是（1→1） | 中文排版常见 |
| 中文标点（`，。；：！？（）《》`） | **不折叠** | — | 无通用一对一映射，折叠会造成索引错位或误命中 |
| 半角空格、其它 CJK、其它字符 | 原样保留 | 是（1→1） | — |

5. **禁止**使用 `String.prototype.normalize("NFKC"/"NFKD")`：它会把 `ﬁ` 展开为 `fi`、把全角形式批量改写，**改变码点数量**，使命中索引与 `items` 偏移错位（这是本模块最容易踩的坑）。若要用 `normalize("NFD")`，必须先逐码点断言长度不变，否则一律不用。
6. 断言保护：`normalizeForKey(s).length === s.length` 必须逐页校验一次；违反则 `console.warn` 并跳过该页（同时累加内部错误计数），绝不"带错继续"。
7. 查询串处理：`trim()` 后为空 → `enabled = false`、结果为 `[]`、**provider 调用次数为 0**（不扫描）。非空则保留内部空格作为字面量（字面量子串天然跨空格）。
8. 首版只支持**字面量子串**；不支持正则、通配符、布尔表达式、整词匹配（见 §5）。

### 4.3 扫描与命中拼装

9. 逐页扫描：对第 i 页取 `TextContentHandle`，令 `N = normalizeForKey(text)`、`Q = normalizeForKey(query)`，用 `indexOf(Q, from)` 循环取全部出现位置，区间 `[start, start + Q.length)`。因归一化等长，该区间**直接**就是原文索引区间。
10. 每页命中上限 `MAX_HITS_PER_PAGE = 200`；全文档上限 `MAX_HITS_TOTAL = 5000`；达到上限置 `truncated = true` 并停止追加（页数统计仍继续，用于"已扫描页数"展示）。
11. 跨 item / 跨行：`text` 按契约 R1 构造（item 间无分隔符、**行间单个 `'\n'`**），因此命中可以跨 item 边界；用 `itemStarts` 定位每个 item 的区间，命中区间若包含某个 `'\n'` 则视为跨行命中，高亮按行拆成两段；拼装时必须按 item 区间拆分（§4.4），**不得**假定"一个命中落在一个 item 内"。
12. 增量与可取消：每处理 8 页 `await yieldToUi()`（`new Promise(r => setTimeout(r, 0))`），并检查 `AbortSignal.aborted`；支持 `cancel()`。每页完成即回调 `onBatch(hits)`，UI 可以先显示前几页结果，不等全文档扫完。
13. 扫描序号：新查询启动时 `++runId`，旧 run 的回调必须被丢弃（用 runId 比对），否则会出现"上一个查询的结果混进当前列表"。

### 4.4 命中 → 页 + 页内矩形（必须与 M05 对齐）

14. 命中结构（内部类型，输出给 M07 / 搜索面板）：

```ts
export interface DocSearchHit {
  pageNo: number;              // 1-based
  start: number; end: number;  // 页内 text 的字符区间，[start, end)
  rects: Array<{ x: number; y: number; w: number; h: number }>; // 页内 CSS px（已乘当前 scale）
  snippet: string;             // 命中前后各 40 字符 + 省略号
}
```

15. item 区间来源：**必须**复用 M05 的 `getItemRanges(items)`（`src/pdf-engine/text-content.ts`），**不得**在本模块重写前缀和。对齐规则：`text === items.map(i => i.str).join("")`、item 区间 = `str.length` 前缀和（见 05 模块 Prompt §4.5 第 22–23 条）。
16. 每个 item 与命中求交：`is = max(hit.start, item.start)`、`ie = min(hit.end, item.end)`，`ie > is` 才生成矩形：

```text
x0 = item.x + (is - item.start) / item.str.length * item.width
x1 = item.x + (ie - item.start) / item.str.length * item.width
y  = item.y
h  = item.height
rect = { x: x0 * scale, y: y * scale, w: (x1 - x0) * scale, h: h * scale }
```

17. 坐标约定：M05 的 `TextItem` 是"页内 scale=1、左上原点、y 向下"（05 §7 第 291 行 + 05 模块 Prompt §4.5 第 21 条）。因此**乘 scale 只在本模块做一次**；M07 拿到 rects 后不得再乘。
18. 跨行/跨 item 命中 → **多个矩形**（每个 text run 一个），禁止合并成一个外接矩形（会把行间空白也覆盖成高亮）。矩形按 `y` 升序、同 `y` 按 `x` 升序输出（便于"下一个"逐个定位）。
19. `snippet`：从 `text` 取 `[max(0, start-40), min(text.length, end+40))`，首尾被截断时补 `…`；**不做**分词、不改变原始字符（注意：这与 M11 的 `GlobalSearchHitDto.snippet` 语义不同——那是 Rust 侧产物，见 05 §2 第 133–137 行，两者不得混用类型）。
20. 与 M05 的一致性门禁：本模块的 `hit-rect.test.ts` 与 M05 的 `text-content.test.ts` 必须用**同一份 fixture**（同一 `items` 数组字面量），断言"同一命中在同一 item 上得到同一矩形"。fixture 路径固定 `src/reader/search/__tests__/fixtures/text-items.ts`，M05 的实现变更必须能让本模块测试失败——这是跨模块对齐的探针。

### 4.5 高亮 DOM 层

21. 高亮层挂在 M07 的 `PageSlot` 内（M07 提供插槽，见 07 模块 Prompt §4.1 第 1 条），是页面之上的绝对定位覆盖层：`position: absolute; inset: 0; pointer-events: none;` —— **必须** `pointer-events: none`，否则会挡住文本选择（§13 第 6 条验收项）。
22. 每个矩形一个元素，用 `transform: translate(x, y)` + 设置宽高，**不用** `left/top` 逐帧写入（避免重排）；元素带 `data-search-hit` 与 `data-hit-index` 便于测试计数。
23. 命中状态：`active`（当前上一个/下一个选中的）与普通命中用不同 class 区分，**只允许改样式**，不得调换 DOM 顺序去实现"置顶"。
24. 高亮元素**不得**包含文本内容（空 `div`），否则会被复制进选择文本。

### 4.6 上一个 / 下一个 / 计数

25. 顺序：按 `(pageNo, start)` 字典序；`next()` / `prev()` 循环（末项的下一个回到首项）。
26. 跳转：`next/prev` 必须调用 `ReaderApi.goToPage(pageNo, { highlightRanges: [[start, end]] })`（`docs/05-api-contracts.md` §7 第 331 行），并把命中设为 `active`。滚动是否居中属 M07 的显示取向（其待确认项），本模块不实现滚动。
27. 计数：`currentIndex / total`；扫描未完成时 UI 显示"total+"（形式待确认），`state === "scanning"` 也是公开状态之一。
28. 空态与错误态：`enabled === false`（空查询）→ 不显示计数、不显示"未找到"；`skippedPages > 0` → 在报告与 UI 上给出"部分页面文本不可用"的事实（文案待确认）。

### 4.7 useDocSearch()

29. Hook 返回：`{ query, setQuery, state, enabled, hits, total, currentIndex, next, prev, goToIndex, truncated, skippedPages, cancel }`；`state: "idle" | "scanning" | "ready" | "error"`（03 §M08 第 113 行要求的 `useDocSearch()`）。
30. `setQuery` 防抖 250ms（避免每敲一个字就全文档扫描）；防抖窗口内再次输入必须 `cancel()` 上一次 run。

## 5. 非目标（明确不做）

1. **不做库级检索**（M11：FTS5 + jieba 分词 + bm25 排序），不 `invoke("search_global")`。
2. **不用 FTS5、不写索引、不读写数据库**（M03/M09/M10/M11 职责）。
3. 不自己提取文本（只用 `SearchTextProvider`）；不 import `pdfjs-dist`；不调用 `render()`。
4. 不支持正则、通配符、布尔、近似搜索、拼音/形近字容错、跳词匹配。
5. 不实现"搜索面板"的视觉与布局（面板外观属 M07/M14 的视觉待确认项）；本模块只提供 hook + 高亮层。
6. 不做结果导出、不做命中统计报表、不改进度或书签。
7. 不做跨文档的"搜不到就搜全库"联动（编排属 M14）。
8. **不得自行确定视觉方案**：代码里只允许 class 名与 `var(--…)` 引用，不得写死色值。例外（**已由 D21 冻结，照此实现**）：普通命中 = `background: var(--lg-hit-bg)` 无描边；当前命中 = `background: var(--lg-hit-active-bg)` + `outline: 1px solid var(--lg-hit-active-border)`，`outline-offset: 0`；三套主题的对应值见 `docs/15-theme-tokens.md` §2/§5。仍然待确认的只有搜索面板形态与字段（D22）与文案（D28）。

### 本模块的【待你确认】清单（不得自行决定，实现留 `TODO(ui-confirm)`）

1. 普通命中的高亮样式（底色、透明度、是否加描边）。**推荐**：半透明暖黄、无描边；具体值由你定。
2. 当前命中（active）与普通命中的区分方式（更饱和底色 / 描边 / 轻微放大）。
3. 高亮在浅色/深色/纸色主题下是否用不同令牌（本模块只引用 `ThemeTokens` 变量名，令牌值属 M13）。
4. ~~结果面板形态与位置~~ → **D22 已拍板**：**右侧窄抽屉**，宽 `360px` 全高，可折叠；每项一行「页码 + 上下文片段」，当前项高亮；`Ctrl+F` 唤起、`Esc` 关闭、`↑`/`↓` 或 `F3`/`Shift+F3` 上下切换。抽屉与 M11 的居中浮层位置错开，不得复用同一容器。
5. 扫描中"total+"与"部分页面文本不可用"的提示文案与形态。
6. 是否需要"区分大小写"开关（若需要，归一化函数增加开关参数；默认不区分）。

## 6. 架构约束

- **允许依赖**：`src/pdf-engine` 的 `TextContentHandle` / `TextItem` / `getItemRanges`（类型 + 复用函数）、`src/render` 的类型（只读）、M07 的 `ReaderApi`（**通过参数注入**，不 import 其实现文件）、`src/contracts` 的 `ApiError`。
- **禁止依赖**：`pdfjs-dist`、`src-tauri/**`、任何 SQL/FTS 概念、M11 的 `search_global` 命令与 `GlobalSearchHitDto`、M12/M13 的实现（主题只用变量名）。
- **与 M05 的对齐是硬约束**：`text` 拼接规则与 `getItemRanges` 只能有**一份实现**（在 M05）。若发现规则不够用（例如 M05 插入了分隔符），**必须**回报「契约缺口」等 Lead 决定，**不得**在本模块造一份"差不多的"偏移表。
- **与 M07 的边界**：滚动、居中、页面层级、文本层都由 M07 提供；本模块只输出 rects 与 highlightRanges。
- **状态归属**：搜索状态（query/hits/currentIndex/state）归本模块 hook；阅读状态（mode/scale/currentPage）归 M07 的 `ReaderProvider`。两者不得互相写对方的 state。
- **不负责清单**：库级检索、索引、文本提取、滚动定位、面板视觉、主题令牌。

## 7. 输入与输出

| 输入来源 | 数据形态 | 触发时机 |
|---|---|---|
| 用户 | 查询串（原始，未归一化） | 输入框键入（250ms 防抖） |
| M07 | `SearchTextProvider`（`pageCount` + `getPageText`） | 每个扫描页 |
| M05 | `TextContentHandle { items, text }`、`getItemRanges(items)` | 归一化与矩形映射 |
| M06/M07 | 当前 `scale`、`ReaderApi.goToPage` | 矩形换算、命中跳转 |

| 输出目标 | 数据形态 | 消费方 |
|---|---|---|
| M07（页面层级） | 高亮矩形（页内 CSS px，已乘 scale） | `HighlightLayer` 渲染 |
| M07 | `goToPage(pageNo, { highlightRanges })` | 上一个/下一个跳转 |
| M07 / 搜索面板 | `DocSearchHit[]`、`total/currentIndex/state` | 结果列表与计数 |
| M15 | 搜索耗时打点（`tookMs`） | 性能基线 |

## 8. 接口契约

**契约内（本模块不自造同名类型；来源见 `docs/05-api-contracts.md`）**：

| 类型/接口 | 行号 | 关系 |
|---|---|---|
| `TextContentHandle` | 286–289 | 输入（`items/text`） |
| `TextItem` | 291 | 输入（矩形来源） |
| `ReaderApi` / `goToPage` | 327–333（331） | 跳转出口（`highlightRanges` 形状） |
| `GlobalSearchHitDto` / `GlobalSearchResultDto` | 133–141 | **不得复用**：那是 M11 的库级结果类型，语义不同 |
| `ApiError` | 34–39 | 单页取文本失败的记录形态（detail 带 pageNo） |

**模块新增内部接口（需在报告 §8 声明）**：

```ts
// src/reader/search/index.ts
export function createDocSearch(provider: SearchTextProvider): DocSearch;
export interface SearchTextProvider {
  readonly pageCount: number;
  getPageText(pageNo: number): Promise<TextContentHandle | null>;
}
export interface DocSearch {
  run(query: string, opts?: { signal?: AbortSignal;
    onBatch?: (hits: DocSearchHit[]) => void }): Promise<DocSearchRunResult>;
  cancel(): void;
}

// src/reader/search/types.ts
export interface DocSearchHit { pageNo: number; start: number; end: number;
  rects: Array<{ x: number; y: number; w: number; h: number }>; snippet: string }
export type DocSearchState = "idle" | "scanning" | "ready" | "error";
export interface DocSearchRunResult { hits: DocSearchHit[]; total: number;
  truncated: boolean; skippedPages: number; tookMs: number }

// src/reader/search/normalize.ts（纯函数，可测）
export function normalizeForKey(s: string): string;
export function isLengthPreserving(s: string): boolean;

// src/reader/search/highlight-layer.tsx
export interface HighlightLayerProps {
  pageNo: number;
  rects: Array<{ x: number; y: number; w: number; h: number }>;
  activeRectIndex: number | null;
}

// src/reader/search/use-doc-search.ts
export function useDocSearch(provider: SearchTextProvider, api: ReaderApi): UseDocSearchResult;
```

## 9. 数据结构

- `DocSearchHit`：见 §4.4 第 14 条；`pageNo` 1-based；`start/end` 是**原始 text** 的字符索引（因归一化等长，与归一化索引相同）。
- `rects`：页内 CSS px、已乘 `scale`；`x/y` 为矩形左上角；空矩形不允许存在。
- `DocSearchRunResult`：`truncated`（触达 §4.3 上限）、`skippedPages`（取文本失败或长度不一致的页数）、`tookMs` = 起止 `performance.now()` 差值。
- `UseDocSearchResult`：见 §4.7 第 29 条；`enabled === query.trim().length > 0`。
- 常量（`src/reader/search/config.ts`）：`MAX_HITS_PER_PAGE = 200`、`MAX_HITS_TOTAL = 5000`、`SNIPPET_RADIUS = 40`、`PAGES_PER_YIELD = 8`、`QUERY_DEBOUNCE_MS = 250`。
- 与数据库的关系：**无**。本模块不出现任何表名/列名（02 §2 第 58 行）。

## 10. 文件组织

```text
src/reader/search/
  index.ts              # 公开出口：createDocSearch / 类型 / HighlightLayer / useDocSearch
  types.ts              # DocSearchHit / DocSearchState / RunResult / Provider
  normalize.ts          # 等长归一化（逐码点）+ 长度保持校验
  matcher.ts            # indexOf 循环、上限、跨 item 拆分（纯逻辑，可测）
  hit-rect.ts           # item 区间 × 命中 → 矩形（复用 M05 getItemRanges）
  snippet.ts            # 上下文窗口与省略号
  scan.ts               # 逐页扫描、yield、AbortSignal、runId 丢弃
  highlight-layer.tsx   # pointer-events:none 的高亮覆盖层
  use-doc-search.ts     # 状态机 + 250ms 防抖 + next/prev/goToIndex
  config.ts             # 5 个上限/常量
  __tests__/
    fixtures/text-items.ts   # 与 M05 共用的 items fixture
    normalize.test.ts
    matcher.test.ts
    hit-rect.test.ts
    scan-cancel.test.ts
    highlight-layer.test.tsx
    perf-1000-pages.test.ts
```

## 11. 实施步骤

1. 落 `normalize.ts` + `normalize.test.ts`：先写 10 条归一化向量（大小写、全角字母、全角标点、全角空格、emoji、`ﬁ` 连字），断言**每条**都满足长度不变。
2. 落 `matcher.ts`（纯逻辑）+ `matcher.test.ts`：中文子串、跨 item、上限 `truncated`、空查询零扫描。
3. 落 `hit-rect.ts` + 共用 fixture：断言"单 item 命中 1 矩形 / 跨 item 命中 2 矩形 / 跨行两矩形的 y 不同"。
4. 落 `scan.ts`（yield + AbortSignal + runId）+ `scan-cancel.test.ts`：取消后不再追加结果、旧 run 的回调被丢弃。
5. 落 `highlight-layer.tsx` + `highlight-layer.test.tsx`：`pointerEvents === "none"`、元素数 === rects 数、无文本内容。
6. 落 `use-doc-search.ts`：防抖、next/prev 循环、`goToPage(pageNo, { highlightRanges })` 调用断言（用 fake `ReaderApi`）。
7. 落 `perf-1000-pages.test.ts`：1000 页合成 provider，跑 20 轮取 P95（测法见 §12）。

## 12. 测试要求

**命令**：`npx vitest run src/reader/search --environment jsdom`；`npx tsc --noEmit`。本模块无 Rust 代码。

单元：

- 正常路径：单页单 item 命中 → 1 个矩形，`rect.x` 与手算值误差 < 0.01px。
- 正常路径：中文子串 "分词的效" 命中（文本含 "本文讨论中文分词的效果与局限"），`start/end` 精确。
- 边界：跨 item 命中 → 2 个矩形，且 `rects[0].y !== rects[1].y`（两行）。
- 边界：查询串比所有文本都长 → 0 命中、`state === "ready"`、不抛错。
- 边界：空查询（`""` / 全空格）→ `enabled === false`、provider 调用次数 === 0、hits 为空。
- 边界：触达 `MAX_HITS_PER_PAGE` → `truncated === true` 且该页矩形相关的命中数 === 200。
- 归一化：`normalizeForKey("ＡＢＣ")` → `"abc"`；`normalizeForKey("ABC")` → `"abc"`；两者长度均 === 3；含 `ﬁ` 的串长度不变。
- 错误路径：某页 `getPageText` reject → `skippedPages === 1`、其余页命中正常、`console.warn` 一次带 pageNo。
- 取消：扫描 40 页中途 `cancel()` → 不再有 `onBatch` 回调。
- 竞态：连续 `run("a")` / `run("ab")` → 最终结果只含 "ab" 的命中（runId 生效）。
- 高亮层：3 个 rect → 3 个元素，全部 `pointer-events: none`，`textContent === ""`。

性能（1000 页，测法必须写进测试注释）：

- 合成 provider：1000 页 × 每页 1500 字符中文文本，命中均匀分布；先全量 warm 一次（模拟文本已缓存）再计时。
- 每轮 `performance.now()` 计时，跑 20 轮取 P95，断言 < 500ms，打印 P95 / 中位数 / 机器说明。
- 该目标是"文本已就绪"前提下的搜索耗时；若文本未提取，耗时为取文本主导，报告中必须分开如实记录（未测就写「未验证」）。

## 13. 验收标准

1. `npx vitest run src/reader/search` 全绿；`npx tsc --noEmit` 无错。
2. **跨行命中矩形覆盖两行**：fixture "本文讨论中文分词" + "的效果与局限"，查询 "分词的效果" → `rects.length === 2`，两矩形 y 不同、各自 x 区间落在对应行内（打印两矩形坐标）。
3. **中文子串命中**：查询 "分词的效"（不分词、非整词）命中且 `total === 1`。
4. **全角/半角与大小写归一**：`ＡＢＣ` ↔ `abc` 互相命中；`ABC` ↔ `abc` 互相命中；含 `ﬁ` 的文本归一化后长度不变（断言）。
5. **1000 页首次搜索 P95 < 500ms**：`perf-1000-pages.test.ts` 断言通过，报告附 P95 实值与机器配置；未达则如实记录瓶颈（不得改阈值了事）。
6. **高亮不拦截选择**：高亮层全部元素 `getComputedStyle().pointerEvents === "none"` 且 `textContent === ""`（不污染复制文本）；真实选择行为另附一条人工步骤说明（jsdom 不做命中测试）。
7. 空查询：provider 调用次数 === 0（spy 断言）。
8. 与 M05 对齐：`hit-rect.test.ts` 使用 `fixtures/text-items.ts`，该 fixture 同时被 M05 的 `text-content.test.ts` 使用（一致性由同一份数据保障）。
9. 隔离性：`grep -rn "pdfjs-dist|search_global|page_fts" src/reader/search` 无命中。
10. 【待你确认】六条在报告 §6 逐条列出，且 `grep -rn "TODO(ui-confirm)" src/reader/search` 的命中数与涉及点一致。

## 14. 交付报告

### I. 交付报告格式（必须逐项填写）

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

### H. 禁止事项（任一项出现即视为交付失败）

1. 修改其他模块的文件或接口契约（见 03 的文件归属矩阵）。
2. 引入未经批准的架构变更或新的大型依赖。
3. 为通过验收而伪造实现、硬编码返回值、把未实现功能写成已完成。
4. 删除或破坏已有测试；降低既有断言以"通过"。
5. 长时间保留 mock 数据源而不接真实接口。
6. 越界实现其他模块职责（宁可返回"需要 M0x 提供"也不要自己造）。
7. 用 `display:none` 等手段"隐藏"本该完全不渲染的节点。

### 本模块补充禁令

1. **不得**使用 `normalize("NFKC"/"NFKD")` 或任何会改变码点数量的归一化（会让命中索引与矩形错位）。
2. **不得**在本模块重写 `items→text` 的偏移计算；必须调用 M05 的 `getItemRanges`，规则不够用就报「契约缺口」。
3. **不得**把跨行命中合并成一个外接矩形冒充"高亮"。
4. **不得**给高亮层加任何接收指针的属性（`pointer-events` 必须为 `none`），也不得让高亮元素包含文本。
5. **不得**用 `search_global` / FTS5 / 数据库代替当前文档搜索（那是 M11）。
6. **不得**自己调 `render()` / `openDocument` 或自取 PDF 字节；文本只来自 `SearchTextProvider`。
7. **不得**写死高亮配色与面板样式，一律 `TODO(ui-confirm)`。
