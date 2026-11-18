# 模块 M06：render-scheduler

> 依赖前置：M05 pdf-engine（`DocumentHandle` / `PageHandle` / `RenderTaskHandle` 已可用）；被依赖方：M07 reader-interaction、M08 doc-search。
> 归属层：L2；并行组：E（`M05 → M06 → M07 → M08` 串行，见 `docs/03-module-boundaries.md` §3 第 197–198 行）。

## 1. 模块身份

M06 是阅读链的"中央调度室"：它把「用户在哪」（模式 + 缩放 + 滚动位置）翻译成「谁需要被渲染、按什么顺序、用多少预算、什么时候取消」，并且**独占** canvas 与文本内容的缓存所有权（D08，见 02 §11 第 298 行）。它不解析 PDF（M05），不画界面（M07），不响应用户手势（M07）。
它在数据流里的位置：M07 → `setViewport()` → M06 计算可见页/预取窗口/优先级 → 向 M05 索页与渲染 → 广播 `PageRenderState` → M07 只为 `ready` 页挂 canvas。React 组件从不自己发起 `page.render()`（02 §5 第 180 行）。

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

交付一个与 React 完全解耦的 `src/render/` ：给定 `ViewportState` 与 `DocumentHandle`，它按预算并发渲染可见页与预取页、取消过期任务、按字节 LRU 管理 canvas、并把 `PageRenderState` 批量广播给订阅者；`dispose()` 后不残留任何任务或 canvas 引用。

分解目标：

1. 可见页集合计算是纯函数、二分 O(log n)，N=500 页、1920×1080 下单次 < 1ms。
2. 渲染并发永不超过 `maxConcurrent`（默认 2）。
3. 缩放/出窗口/换文档/卸载四种情形的取消行为与 §4.4 矩阵逐条一致。
4. canvas LRU 以字节计（`w*h*4`，`w` 已含 dpr）并保护可见页；文本内容 LRU 独立。
5. 每个调度 tick 只广播一次状态快照，订阅者读到的是不可变快照。
6. `dispose()` 幂等，之后 `getEngineStats` 等价物（`getStats()`）归零。

## 4. 功能范围（必须完成）

### 4.1 布局偏移与可见页集合（纯函数，无副作用）

1. 输入 `ViewportState`（`docs/05-api-contracts.md` §7 第 306–310 行：`mode/scale/scrollTop/viewportHeight/viewportWidth/pageGeometries`，index 0 = 第 1 页）。
2. 纵向偏移（连续模式，单位 **CSS px**）：
   - `pageH_i = pageGeometries[i].heightPt * scale`
   - `offset[0] = 0`；`offset[i] = offset[i-1] + pageH_{i-1} + gap`
   - `gap` 来自 `RenderLayout`（`src/render/layout.ts`），数值属视觉待确认项；**算法必须对任意 `gap >= 0` 正确**，测试里用 `gap = 8` 写死（测试给死值不违反 UI 纪律）。
   - 说明：`scale` 是"每 point 多少 CSS px"，与 `devicePixelRatio` **无关**；dpr 只影响 canvas 像素，dpr 乘法由 M05 在 `render()` 内完成（05 §7 第 276–277 行）。本模块绝不乘 dpr 参与布局。
3. 可见页：在 `offset` 上二分求"最后一个 `offset[i] <= scrollTop` 的 i"（越界时 clamp 到 `[0, n-1]`），再从该页向后推进到 `offset[i] + pageH_i > scrollTop + viewportHeight` 为止，得到 `[firstVisible, lastVisible]`（含端点，0-based）。
4. 单页模式（`mode === "single"`）：`firstVisible === lastVisible ===` 由 `scrollTop` 反查到的页（同一二分），不加额外状态字段。
5. 预取窗口：`[firstVisible - prefetchPages, lastVisible + prefetchPages]`，clamp 到 `[0, n-1]`。
6. 每次 `setViewport(v)` 重算；若 `v.pageGeometries` 引用、`scale`、`mode`、`scrollTop`、`viewportHeight` 全部未变 → 直接 return（不做任何工作、不广播）。
7. 该计算必须是**导出的纯函数** `computeVisibleRange(v, layout): VisibleRange`，M07 需要同一口径时 import 它而不是重写（§8 内部接口）。

### 4.2 优先级打分

8. 分数公式（默认权重为常量，集中在 `src/render/priority.ts`）：

```text
visible = firstVisible <= i <= lastVisible
dist    = visible ? 0 : min(|i - firstVisible|, |i - lastVisible|)
score(i) = W_VISIBLE * (visible ? 1 : 0)
         + W_PROX    * (1 / (1 + dist))
         + W_WAIT    * min(waitedMs_i, 5000) / 5000
         - W_STALE   * (cachedScale_i !== null && cachedScale_i !== scale ? 1 : 0)
默认：W_VISIBLE = 100, W_PROX = 20, W_WAIT = 5, W_STALE = 2
```

9. `W_STALE` 是负项：一页已有旧 scale 的位图时，先渲染别的页能让用户更快看到"至少清晰的一屏"。
10. 平局按 `pageNo` 升序，保证调度确定性（可断言）。
11. 队列按分数降序取任务；**不抢占**正在渲染的任务——取消只由 §4.4 矩阵触发。
12. 排序每次入队/出队后重算（队列长度 ≦ 预取窗口大小，成本可忽略）；禁止用"每次 tick 全量重排 + O(n²) 扫全文档"。

### 4.3 RenderBudget

13. 默认值：`maxConcurrent = 2`（架构硬值，02 §9 第 274 行）、`cacheBytes = 268435456`（256 MiB）、`prefetchPages = 2`。
14. `setBudget(Partial<RenderBudget>)`：`maxConcurrent` 夹取到 `[1, 4]`（>4 无收益且放大内存峰值），非法值 `console.warn` 并保留旧值；`cacheBytes` 夹取到 `>= 64 MiB`；`prefetchPages` 夹取到 `[0, 8]`。
15. 预算变化后立即重算队列与 LRU；`cacheBytes` 调小时同步逐出到新预算的 80%。
16. 256 MiB 与 prefetchPages = 2 是**可运行默认值**（不是视觉值）：报告中说明取值理由（单页 1920×1080@dpr2 ≈ 33 MB/页，256 MiB ≈ 7 页满分辨率）。`prefetchPages` 属体验取向 → 见 §5 待确认清单，推荐 2。

### 4.4 取消触发矩阵（逐条实现，逐条验收）

| 触发 | 取消 | 保留 | 附加动作 |
|---|---|---|---|
| 页移出预取窗口 | 该页 `queued`/`rendering` 任务 | 已 `ready` 位图（交给 LRU） | 状态回 `idle` 并计入本次 tick 的脏页 |
| `scale` 变化 | 所有 `scale !== 新 scale` 的 `queued`/`rendering` | 其它 | 旧 scale 的 `ready` 位图立即失效（不入 LRU，直接释放） |
| `setDocument` 换文档或传 `null` | 全部 | 无 | 顺序：先取消 → 再释放 canvas → 再清 text 缓存 |
| `dispose()` | 全部 | 无 | 幂等，见 §4.8 |
| `mode` 变化（continuous ↔ single） | 仅预取窗口外页（由第 1 行自动命中） | 可见页 | scale 不变则不重渲染 |
| 订阅者卸载（React 组件 unmount） | **不取消任何任务** | 全部 | 只 `unsubscribe`（§6 所有权规则） |

### 4.5 Canvas LRU（字节预算）

17. 键 `pageNo`，值 `{ canvas, scale, bytes, lastUsed }`；一页只保留一个 scale 的位图（换 scale 即覆盖）。
18. `bytes = canvas.width * canvas.height * 4`。`canvas.width` 已含 dpr，因此等价于 `w*h*dpr²*4`，**代码里不得再乘 dpr**（重复相乘会导致预算虚高 4 倍，是本模块最常见的 bug）。
19. 逐出目标：降到 `cacheBytes × 0.8`（滞回，避免每帧抖动）；逐出顺序 `lastUsed` 升序，同 `lastUsed` 时 `pageNo` 升序。
20. 可见页受保护：逐出时跳过 `firstVisible..lastVisible`；若只剩可见页仍超 100% 预算 → 允许超额并 `console.warn` 一条（带 `bytes` 与 `visibleBytes`），**不得**为省钱逐出可见页。
21. 逐出后置 `canvas.width = 0; canvas.height = 0` 并断开引用。该做法是否真的让 WebView 归还后备存储需按 V-07（02 §1 第 36 行）测量：用「重复渲染 200 页后 `performance.memory.usedJSHeapSize` 或任务管理器内存不单调增长」判定；未测前保留代码并在报告标「未验证」。

### 4.6 TextContent LRU（独立淘汰）

22. 独立缓存实例，键 `pageNo`，条目上限 `textCacheEntries = 30`；不参与 `cacheBytes` 字节预算（理由：文本体积与像素无关，且 M08 搜索依赖它，需要比 canvas 更长的留存期）。
23. 只缓存 `TextContentHandle` 的对象引用（由 M05 保证同页同引用），本模块不复制 `items`。
24. 淘汰顺序同 §4.5 的 LRU 规则；与 canvas 缓存互不影响。

### 4.7 PageRenderState 广播

25. 内部状态机：`idle → queued → rendering → ready | error`（`docs/05-api-contracts.md` §7 第 297 行）。`ready` 时 `canvas` 与 `textContent` 非空、`scale` 等于当时请求的 scale；`error` 时 `error` 为 `ApiError`。
26. **批量提交**：一个调度 tick 内累积 `dirtyPages: Set<number>`，tick 结束（调度循环同步返回前）只调用一次 `flush()`：构造**全新的** `ReadonlyMap<number, PageRenderState>` 快照（不得原地修改上一份 Map），然后依次调用每个 handler；单个 handler 抛错必须 try/catch + `console.warn`，不得中断其它订阅者。
27. `subscribe(cb)` 返回 `unsubscribe`；同一个 `cb` 重复注册只保留一份（去重）；subscribe 时**不**立即回调（初值由 `getPageState` 取），避免订阅时机不同导致状态不同步。
28. `getPageState(pageNo)` 返回该页当前状态或 `undefined`；返回对象必须与快照中的对象是同一引用（不可变，调用方不得改）。
29. 广播频率上限：即使一 tick 内多页完成也只广播一次；不允许每页各自回调（否则 M07 的 React 渲染次数会爆）。

### 4.8 dispose 与全量释放

30. `dispose()` 幂等，顺序固定：①停止调度循环 ②取消全部活动 `RenderTaskHandle` ③释放 canvas 缓存（逐项 `width=0`）④清 text 缓存 ⑤清订阅者 ⑥置 `disposed = true`。
31. 之后 `setViewport / setDocument / setBudget / getPageState` 全部 no-op，`subscribe` 返回空函数，`getStats()` 返回全零。
32. 不得在 dispose 里调用 `DocumentHandle.dispose()`（所有权属外部，见 §6）。

## 5. 非目标（明确不做）

### 5.0 已由 Lead 裁决的技术参数（**不再询问，按此实现**）

**T16**（明细见 `docs/14-ui-decision-register.md` §1，与契约 R5 配套）：

1. **允许 LOD 预览**：新 scale 的清晰位图就绪前，允许以旧 scale 位图拉伸顶替（`PageRenderState.scale` 保留旧值，消费方不得判定为失败）。
2. **> 200% 时禁止拉伸预览**：超过 200% 只允许在清晰位图就绪后显示，避免让人误判分辨率（此时可出现短暂空白占位，占位外观不属本模块）。

1. **不解析 PDF、不 import `pdfjs-dist`**；不自己 `fetch`。
2. **不做 DOM 布局与样式**：不创建页面容器、不写 CSS、不决定页间距/背景/阴影；`RenderLayout.gap` 只是参与偏移计算的输入。
3. **不处理用户手势**（滚轮、缩放快捷键、拖拽、键盘）——M07。
4. 不做文本层、不做选择、不做搜索匹配（M07/M08）。
5. 不做跨文档缓存、不做缩略图生成、不做离屏预渲染成图片文件。
6. 不做"渲染完成回调"式的单页 API；对外只有 `subscribe` + `getPageState` 两种读法。
7. 不读写数据库、不发 IPC、不碰 zustand。
8. **不得自行确定视觉方案**：任何颜色、间距、层级、动效一律 `TODO(ui-confirm)`；`layout.ts` 里的默认值只允许存在一个"能跑"的占位值并在文件顶部注释 `TODO(ui-confirm)`。

### 本模块的【待你确认】清单（不得自行决定）

1. 页间距 `RenderLayout.gap` 的取值（连续模式）。**推荐**：占位值 8，最终值由你定；本模块的算法对任意非负值成立，因此不阻塞实现。
2. 预取页数 `prefetchPages` 的默认值。**推荐 2**（前后各 2 页）；代价是峰值内存与并发占用上升。改它只影响 `setBudget` 默认参数，不影响算法。
3. 页面未 `ready` 时的占位外观（是否显示骨架/空白/上一张模糊图）——本模块只提供 `state`，**外观由你定**，M07 实现。
4. 缩放到某一页时是否允许"先用旧 scale 位图拉伸顶替"。**推荐**：不允许（拉伸糊图比空白更干扰阅读），但这是体验取向，请拍板。

## 6. 架构约束

- **允许依赖**：`src/pdf-engine` 的公开类型（`DocumentHandle/PageHandle/RenderTaskHandle/TextContentHandle/PageGeometry`）与 05 §7 的调度类型；`src/contracts` 的 `ApiError`。
- **禁止依赖**：`react` / `react-dom` / 任何 `.tsx` / 任何 zustand store / `src/reader/**` / `src/workspace/**` / `pdfjs-dist` / `src-tauri/**`（02 §2 第 56–58 行）。本模块必须能在纯 Node + jsdom 下被 vitest 完整测试。
- **canvas 所有权归 scheduler**（D08，02 §11 第 298 行）：
  1. 每个 `<canvas>` 元素由 scheduler 创建（经 M05 的 `render()`）并**只由 scheduler 释放**（LRU 逐出 / 换文档 / dispose）。
  2. React 只拿**只读引用**：可以读 `state.canvas`、把元素 append 进占位节点、设置 CSS 尺寸；**禁止**改写 `canvas.width/height`、禁止在其上 `getContext("2d")` 绘制、禁止调用 `toDataURL`。
  3. 组件卸载**不得取消别人的任务**：因为任务从不属于组件。卸载只做 `unsubscribe()` 与 DOM 摘除；canvas 元素摘除后仍归 scheduler 的 LRU 管理，可被重新挂载。
- **类型唯一来源**：`PageState/PageRenderState/ViewportState/RenderBudget/RenderScheduler` 由 M05 落在 `src/pdf-engine/types.ts`（05 §7 第 252、297–321 行）。本模块**只 import、不重定义**；若 M05 未落地这些类型，向 Lead 报「契约缺口」，**不得**在 `src/render` 建同义类型。
- **不负责清单**：PDF 解析、DOM/样式、手势、搜索、索引、持久化。
- **文件归属**：本模块只写 `src/render/**`（03 §4 第 223 行）；`src/pdf-engine/**` 属 M05 不可改。

## 7. 输入与输出

| 输入来源 | 数据形态 | 触发时机 |
|---|---|---|
| M07 | `setViewport(ViewportState)` | 滚动（rAF 节流后）、缩放、模式切换、跳页 |
| M07/M14 | `setDocument(DocumentHandle \| null)` | 打开 / 切换 / 关闭文献 |
| 配置 | `setBudget(Partial<RenderBudget>)` | 启动装配、设置项变化 |
| M05 | `getPage()` / `render()` / `getTextContent()` 的结果 | 调度过程中 |
| M05 | `DocumentHandle.dispose()` 后的失效状态 | 关闭文献 |

| 输出目标 | 数据形态 | 消费方 |
|---|---|---|
| M07 | `PageRenderState` 快照（`ReadonlyMap<number, PageRenderState>`） | 决定为哪些 pageNo 建占位、哪个挂 canvas |
| M07 | `getPageState(pageNo)` | 首次挂载取初值 |
| M08 | `computeVisibleRange()` 导出的可见页口径 | 判断搜索命中页是否已加载文本 |
| 日志 | 结构化 `console.debug/warn`（带 `docId/pageNo/bytes/scale`） | 诊断与验收计数 |

## 8. 接口契约

**契约内（逐字实现，`docs/05-api-contracts.md` §7）**：

| 类型 | 行号 | 本模块责任 |
|---|---|---|
| `PageState` | 297 | 五态字符串字面量 |
| `PageRenderState` | 298–304 | 状态对象字段与语义 |
| `ViewportState` | 306–310 | 输入模型（含 `viewportWidth`） |
| `RenderBudget` | 312 | `maxConcurrent/cacheBytes/prefetchPages` |
| `RenderScheduler` | 314–321 | 六个方法签名与幂等语义 |

**模块新增内部接口（需在报告 §8 声明，03 §5 第 234 行）**：

```ts
// src/render/index.ts
export function createRenderScheduler(): RenderScheduler;
export function computeVisibleRange(v: ViewportState, layout: RenderLayout): VisibleRange;

export interface VisibleRange { first: number; last: number; prefetchFirst: number; prefetchLast: number }

export interface RenderLayout { gap: number }   // TODO(ui-confirm) 数值

// 仅测试与诊断（不导出到 L3 的使用路径，命名带 __ 前缀）
export interface SchedulerStats {
  activeTasks: number; queued: number; readyPages: number;
  canvasBytes: number; textEntries: number; subscribers: number; disposed: boolean;
}
```

## 9. 数据结构

- `VisibleRange { first, last, prefetchFirst, prefetchLast }`：0-based 闭区间。
- `OffsetTable`：由 `ViewportState` 派生的 `Float64Array`（长度 n+1），tick 内复用，不跨 `setViewport` 泄漏。
- `RenderJob { pageNo, scale, handle: RenderTaskHandle, startedAt, settled: boolean }`。
- `CanvasEntry { canvas, scale, bytes, lastUsed }`：`bytes = canvas.width * canvas.height * 4`。
- `TextEntry { handle: TextContentHandle, lastUsed }`。
- `PageRenderState`（契约）：内部维护为 `Map<number, PageRenderState>`，广播时转成新的 `ReadonlyMap` 快照。
- 状态迁移表（本模块内部约定，供测试断言）：

| 事件 | 迁移 | 附带 |
|---|---|---|
| 进入预取窗口且无缓存 | `idle → queued` | 入队 + 打分 |
| 获得渲染槽 | `queued → rendering` | `startedAt = performance.now()` |
| render promise resolve | `rendering → ready` | 写 `canvas/scale` + 入 LRU + 取 `textContent` |
| render reject（非取消） | `rendering → error` | 写 `error`（`ApiError`）+ `console.warn` |
| render 取消 | `rendering → idle`（或直接 `queued` 新 scale） | 不计入 error |
| 离开预取窗口 | `queued → idle` | 取消并释放（若 `rendering`） |
| LRU 逐出 `ready` 页 | `ready → idle` | 释放 canvas |

## 10. 文件组织

```text
src/render/
  index.ts               # 公开出口：createRenderScheduler / computeVisibleRange / 类型再导出
  scheduler.ts           # 调度循环、队列、槽位、广播入口（目标 < 300 行）
  viewport.ts            # 偏移前缀和 + 二分可见页（纯函数，无状态）
  priority.ts            # 打分函数 + 默认权重常量 + 平局规则
  budget.ts              # RenderBudget 归一化、夹取与滞回阈值
  canvas-cache.ts        # 字节 LRU（纯逻辑 + 释放钩子，不触碰 DOM 之外的东西）
  text-cache.ts          # TextContent LRU（条目上限）
  states.ts              # PageRenderState 构造、快照生成、脏页收集
  layout.ts              # RenderLayout（gap 占位值 + TODO(ui-confirm)）
  __tests__/
    fake-document.ts          # 实现 M05 的 DocumentHandle：可编程页数、慢渲染、可控取消
    viewport.test.ts          # 二分正确性 + 500 页性能
    priority.test.ts          # 打分与平局
    scheduler.concurrent.test.ts
    scheduler.cancel.test.ts
    scheduler.lru.test.ts
    scheduler.dispose.test.ts
    scheduler.broadcast.test.ts
```

## 11. 实施步骤

1. 落 `viewport.ts` + `viewport.test.ts`：先写 12 条纯函数用例（n=1、n=2、scrollTop 在页中间、scrollTop 超尾部、scale 极值、gap=0/8），再补 500 页基准测试（§12 第 3 条）。
2. 落 `priority.ts` + `states.ts`（纯数据），跑通打分与快照生成用例。
3. 落 `fake-document.ts` 与 `scheduler.concurrent.test.ts`：只做"入队→渲染→ready→广播"，断言并发上限。
4. 落取消矩阵（§4.4 六行逐行写用例）与 `scheduler.cancel.test.ts`。
5. 落 `canvas-cache.ts` / `text-cache.ts` 与 LRU 用例（含字节公式断言与可见页保护）。
6. 落 `scheduler.dispose.test.ts`：dispose 前后 `getStats()` 对比全零、双次 dispose 不抛错。
7. 接真实 M05（一次真实 PDF 冒烟）：打开样本 → setViewport → 等到 `ready` 至少 1 页 → 滚动 3 秒 → dispose，观察并发峰值与内存（V-07 相关结论写进报告）。

## 12. 测试要求

**命令**：`npx vitest run src/render`（含基准用例）；`npx tsc --noEmit`。本模块无 Rust 代码。

单元（全部用 `fake-document.ts`，不需要真实 PDF）：

- 正常路径：n=10 视口高 800、页高 1000 → 可见 `[0,0]`；scrollTop=1000 → `[1,1]`；视口高 2500 → `[0,2]`。
- 边界：n=1；`scrollTop` 为负 → clamp 到 0；`scrollTop` 超过总高 → 取最后一页；`scale = 0.25` 与 `4` 各一例。
- 边界：`pageGeometries` 长度与 `DocumentHandle.pageCount` 不一致 → 取二者较小值并 `console.warn`（不崩溃）。
- 错误路径：render reject → 该页 `error` 且带 `ApiError`；其它页继续渲染，不整批失败。
- 取消路径：对 1 页发起渲染后立即 `setViewport` 到远离它的位置 → 断言该任务是 `cancel()` 过且状态回 `idle`。
- 并发断言：3 秒快速滚动模拟（每 16ms 改一次 scrollTop），断言任一时刻 `activeTasks <= maxConcurrent`，且总渲染次数 > 10（证明确实有调度）。
- 缩放断言：scale 1 → 2 后，旧 scale 的任务全部 cancel，新任务全部 `scale === 2`。
- LRU 断言：`cacheBytes = 64 MiB`、单页 33 MB → 最多留 2 页；逐出非可见页后重入可见区 → 该页被重新 `render()`（用 fake 的 render 调用计数）。
- 文本 LRU：`textCacheEntries = 30`，请求 40 页后条目数为 30 且淘汰的是最久未用的 10 页。
- 广播断言：一 tick 内 3 页 ready → 订阅者只被调用 1 次，快照里 3 页都是 `ready`；订阅者抛错不影响第二个订阅者。
- dispose 断言：dispose 后 `getStats()` 全零；`setViewport` 不抛异常；`unsubscribe` 返回函数可安全重复调用。

集成/性能：

- 500 页可见页计算基准：`computeVisibleRange` 跑 1000 次取中位数，断言 < 1ms（`1920×1080`、n=500、gap=8）。测试内打印实测值，机器差异导致失败时以实测值 + 机器配置写报告，**不得**放宽阈值了事。
- 真实 PDF 冒烟（样本缺失时标「未验证」）：并发峰值 ≤ 2、首屏 1 页 `ready` 时间、dispose 前后 `activeTasks` 归零。

## 13. 验收标准

1. `npx vitest run src/render` 全绿；`npx tsc --noEmit` 无错。
2. **快速滚动 3 秒并发不超上限**：模拟用例内 `activeTasks` 采样峰值 `<= maxConcurrent === 2`（测试打印峰值，附输出）。
3. **缩放取消旧任务 + 新 scale 生效**：scale 1→2 后所有在飞任务被 cancel，最终 `ready` 页的 `state.scale === 2`（断言 `PageRenderState.scale`）。
4. **LRU 逐出后重入可见区能重渲**：逐出后把该页重新滚回可见区，fake 的 `render` 调用计数 +1，最终状态 `ready`。
5. **dispose 后无残留**：`getStats()` 返回 `{ activeTasks: 0, queued: 0, readyPages: 0, canvasBytes: 0, textEntries: 0, subscribers: 0, disposed: true }`；连续 `dispose()` 两次不抛错。
6. **500 页 / 1920×1080 可见页计算 < 1ms**：基准用例中位数断言通过（附实测数字）。
7. 取消矩阵六行各有对应 test 名，`--reporter=verbose` 可见；"订阅者卸载不取消任务"一条必须有独立用例（卸载后任务继续跑到 `ready`）。
8. 广播合并：一 tick 三页完成 → 订阅者调用次数为 1。
9. 隔离性：`grep -rn "pdfjs-dist\|react\|zustand" src/render` 无命中（除测试注释外）。

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

1. **不得**在 `src/render/**` 内 import `pdfjs-dist`、React、zustand 或任何 `.tsx` 组件；本模块必须在无 React 的 vitest 环境下跑通全部用例。
2. **不得**让 React 组件持有或释放 canvas：canvas 生命周期只归 LRU / 换文档 / dispose 三处。
3. **不得**在 `bytes` 计算里再乘 `devicePixelRatio`（`canvas.width` 已含 dpr）。
4. **不得**为"看起来不卡"而删掉取消逻辑或把 `maxConcurrent` 偷偷改大（>4 需架构批准）。
5. **不得**原地修改已广播的 `PageRenderState` 对象或其 Map（订阅者会读到半更新状态）。
6. **不得**因组件卸载、页面隐藏（`visibilitychange`）而取消其它订阅者的任务；节流只能在调度侧做。
7. **不得**自己重定义 05 §7 的调度类型——归 M05 的 `src/pdf-engine/types.ts`，缺了报「契约缺口」。
