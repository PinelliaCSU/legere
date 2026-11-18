# 模块 M14：workspace-shell（应用外壳与主页空间转盘）

> 依赖前置：M02（`call` / `subscribe` / 全部 DTO）；可直接使用 M11 `GlobalSearchPanel`、M12 `BookmarkList`、M13 `useTheme`。
> 被依赖方：M15 integration-release（端到端与性能基线在此模块上跑）。
> 归属层：L4 React（`src/workspace/**` + `src/ui/**`）；并行组：第三批汇聚（03 §3 第 201 行）。

## 1. 模块身份

M14 是应用的门面与编排层，分两块互不重叠的职责：
(A) **应用外壳**——路由（`home` / `library` / `reader` / `settings`）、布局骨架、面板编排、全局快捷键、错误与空态容器；(B) **主页空间转盘**——把用户亲自设计的空间概念（docs/13-ui-home-concept.md）实现为 `<HomeSpace/>`，含环几何、旋转、焦点书、键盘可达性。
它不查库、不渲染 PDF、不定义主题色；数据经 L1 `call`，视觉参数来自 M13 令牌或【待你确认】清单。

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

一句话：**四个路由可切换且切换不重建 PDF 文档；主页空间转盘在 N=0/1/2/12/60 五档下都不崩、隐藏弧不生成 DOM、拖拽期间 React 渲染次数为 0。**

分解目标：
1. `AppShell` + `useRouter()` 落地，四个路由与「进入阅读器需要 documentId」的约束生效。
2. 面板编排：浮层搜索（M11）、侧栏（Outline 只读）、书签（M12）、索引进度条（`index://progress`）互不抢焦点。
3. 全局快捷键集中一处，13 文档已冻结的 4 个绑定先落地，其余进 §7 待确认。
4. `<HomeSpace/>` 的空间模型、交互状态机、数据契约、性能边界与 13 文档逐字一致。
5. 数据源可在 mock 与真实之间切换，切换只改一处工厂函数。
6. 错误与空态容器按 `ApiError.code` 分组，不解析 `message`。

## 4. 功能范围（必须完成）

### 4.1 (A) 应用外壳

A1. 路由：`Route = "home" | "library" | "reader" | "settings"`；`useRouter()` 暴露 `{ route, documentId, navigate, back }`。`navigate("reader", { documentId })` 缺 `documentId` 时拒绝并 `console.warn`，不进入 reader。
A2. 布局骨架：三段式 = 顶栏 / 主区 / 底栏 + 一个浮层挂载点（Portal）。组件命名自定，**不含任何尺寸数值**。
A3. 面板编排（同时最多 1 个浮层 + 1 个侧栏）：浮层搜索复用 M11 `GlobalSearchPanel`；侧栏展示 Outline（来自 M05 `getOutline()` 的只读数据，05 §7 第 261 行）与文内搜索（M08）；书签位复用 M12 `BookmarkList` 与 `useBookmarks`；索引进度条订阅 `index://progress`（payload = `IndexStatusDto`，05 §4 第 217 行）并在 `queued + running == 0` 时收起。
A4. 快捷键总表（集中在 `useGlobalHotkeys()`，禁止组件内散落 `addEventListener("keydown")`）：
   | 动作 | 绑定 | 来源 |
   |---|---|---|
   | 旋转一格并把焦点书移到可见弧中央 | `←` / `→` | 13 §3 第 76 行（已冻结） |
   | 打开当前聚焦书 | `Enter` | 13 §3 第 77 行（已冻结） |
   | 从阅读器返回主页 / 取消聚焦 | `Esc` | 13 §3 第 80 行（已冻结） |
   | 关闭动效（无惯性、直接跳位） | `prefers-reduced-motion` | 13 §3 第 81 行（已冻结） |
   | 打开搜索浮层 / 书签面板 / 设置 / 切到 library | 【待你确认】 | §7.3 A-1 |
A5. 错误容器 `<ErrorSurface error={ApiError}>`：按 `code` 分组文案，`retriable === true` 才给「重试」；`E_DB` 触发只读降级顶栏（04 §5 第 169 行）；**禁止**按 `message` 分支（02 §10 第 283 行）。`detail` 只在调试面板显示。
A6. 空态容器 `<EmptyState title hint action/>`：主页空态由 B 组决定，library 与搜索各自给容器、不共用文案常量。
A7. 订阅生命周期：所有 `subscribe` 句柄在卸载时取消（05 §4 第 224 行），集中在 `useIpcSubscriptions()`；去重交由 M02 `ipc.ts`，本模块不另造总线。
A8. 不重建文档：`reader → library → reader` 回同一 `documentId` 时不得重新 `openDocument`；本模块**不得**在路由切换时调用 `dispose()`（05 §7 第 263 行：`dispose` 幂等但语义是文档生命周期结束）。验收见 §13 第 9 条。

### 4.2 (B) 主页空间转盘（docs/13-ui-home-concept.md 的转写，参数与判据不得丢失）

B1. **空间模型**（原文 13 §2 第 18-50 行）：

```text
                    环中心 c = (cx, cy)
                                  ▲ 书脊长轴沿半径方向
                                  │
        ┌──────── 可见弧段 visibleArc ────────┐
        │   θ_i = base + i·Δ , Δ = 360°/N      │
        │   位置 p_i = c + R·(cos θ_i, sin θ_i)│
        │   旋转 rot_i = θ_i + 90°             │
        └──────────────────────────────────────┘
                    隐藏弧段：角度存在，DOM 不创建
```

参数表（**结构参数冻结，数值全部待你确认**）：

| 参数 | 含义 | 契约 | 数值 |
|---|---|---|---|
| `N` | 参与环排布的书目数量 | 由数据源决定，不设上限；超出可见弧的书不挂载 | 运行时 |
| `R` | 环半径（px） | `R = 0.34 × min(vw, vh)` | **0.34（D01 已定）** |
| `c` | 环心 | 相对视口中心偏移 | **dx=0、dy = -4% 视口高（D01 已定）** |
| `Δ` | 相邻书脊角距 | `Δ = 360° / max(N, 12)`（少书时不挤在一起） | 该下限 12【待你确认】 |
| `visibleArc` | 可见弧角度 | 只有 `abs(normalize(θ_i - base)) ≤ visibleArc / 2` 的书挂载 | **200°（D02 已定）** |
| `spineH` | 书脊长度 | `spineH = 0.42 × R` | **0.42（D03 已定）** |
| `spineW` | 书脊宽度 | 固定 28px | **28px（D03 已定）** |
| 深度映射 | 远近感 | `t = (sin θ_i + 1) / 2`；`scale = lerp(sMin, 1, t)`；`opacity = lerp(oMin, 1, t)`；`zIndex = round(t × 1000)` | sMin/oMin【待你确认】 |
| 层叠 | 相邻书脊在前景处重叠（图中可见两根书脊重叠） | 允许重叠，以 `zIndex` 决定压盖 | 重叠策略【待你确认】 |

B2. **绝对约束**（违反即缺陷，原文 13 §2 第 46-50 行）：
   (a) 隐藏弧段内的书**不生成任何 DOM 节点**（不是 `display:none`、不是 `visibility:hidden`、不是 `opacity:0`），因此也不可能被 Tab 聚焦或被读屏软件读到；(b) 旋转是**唯一**驱动书脊进出的机制，不允许「分页」式整体替换布局；(c) 布局只用 `transform`（`translate3d` + `rotate` + `scale`）与 `opacity`，不触发布局回流。

B3. **交互状态机**（原文 13 §3 第 52-83 行）：

```text
      ┌──────────┐  拖拽/滚轮/方向键   ┌──────────┐
      │  idle    │ ─────────────────▶ │ rotating │
      └──────────┘                    └──────────┘
           ▲                               │ 松开/惯性耗尽
           │  无惯性                       ▼
           └──────────────────────────  idle(settled)
                                          │ 点击书脊 / Enter
                                          ▼
                                     focused(选中某书)
                                          │ 再次点击 / Enter / 双击
                                          ▼
                                   opening(进入阅读器过渡)
                                          │ 过渡结束
                                          ▼
                                     route = reader
```

| 交互 | 行为 | 状态 |
|---|---|---|
| 水平拖拽 | `ringRotation += dx × dragGain`；松手按速度给惯性并指数衰减 | rotating |
| 鼠标滚轮 | 旋转（默认）或切换聚焦书（【待你确认】二选一） | rotating / focused |
| `←` / `→` | 旋转一格（`Δ`），并把焦点书移到可见弧中央 | focused |
| `Enter` | 打开当前聚焦书 | opening |
| 点击书脊 | 把该书旋转到中央并聚焦 | focused |
| 点击空白 | 取消聚焦 | idle |
| `Esc` | 从阅读器返回主页（若在 reader） | 路由 |
| `prefers-reduced-motion` | 关闭惯性与过渡动画（直接跳位） | 全局 |

焦点书定义：`θ` 最接近「正前方向」（图中为屏幕正下方，即 `+90°`）的那一本；焦点书显示标题/作者/进度信息（展示形式【待你确认】）。

B4. **内容与数据契约**（原文 13 §4 第 87-110 行）：

```ts
export interface HomeBook {
  documentId: number;
  fileName: string;
  title: string;              // 优先 pdfTitle，回退去扩展名的 fileName
  author: string | null;
  spineColor: string;         // 预设色板取色：hash(documentId) % palette.length
  pageCount: number | null;
  progress: { pageNo: number } | null;   // 契约 R20：来自 DocumentDto.progressPage，不要为此发 N 次 progress_get
  textState: TextState;       // **D12：书脊只显示书名，不得渲染任何状态标记**（无进度条/无灰点/无虚线）
}

export interface HomeDataSource {
  load(): Promise<HomeBook[]>;   // 首版：document_recent(limit) 失败则回退 document_list
}
```

数据源规则（首版）：
   1. 默认取「最近阅读」（`document_recent`，limit【待你确认】）；不足时用 `document_list`（按 added 倒序）补齐。
   2. 全部为空 → 空态：不渲染环，在环心位置显示「还没有文献」+【添加文献库】按钮（**D14 已定**，见 §7.2 第 9 条）。
   3. `N = 1` → 单本居中直立于正前，不旋转；`N = 2` → 两本对称分列；`N ≥ 3` → 进入环模型。
   4. mock 分支必须有明确标记 `__MOCK__`，真实接口就绪后**删除**，不得长期保留。

B5. **性能边界**（原文 13 §5 第 112-120 行）：

| 指标 | 门槛 | 测法 |
|---|---|---|
| 同时挂载的书脊 DOM 数 | `≤ ceil(visibleArc / 360 × N) + 2` | `document.querySelectorAll("[data-home-spine]").length` |
| 拖拽时主线程长任务 | 无 > 16ms 的长任务（N=60、1920×1080） | Performance 面板 / `PerformanceObserver` |
| 拖拽帧率 | ≥ 55fps（N=60） | rAF 采样 3 秒 |
| 旋转不触发 React 重渲染 | 拖拽过程中 React 组件 render 次数 = 0（用 rAF + CSS 变量 / 直接改 DOM transform） | 加计数断言 |
| 首次进入主页可交互时间 | < 300ms（N ≤ 60，无网络依赖） | 手工打点 |

B6. **与整体布局的关系**（原文 13 §6 第 122-127 行）：home 是入口路由，与 library / reader / settings 平级，不是阅读器的前置弹窗；从阅读器返回主页**保留上次 `ringRotation` 与聚焦书**（会话内），不重算初始角度；主页不承担库管理职责（增删库根、批量操作在 library 视图）。
B7. 每个书脊元素必须带 `data-home-spine` 属性（性能判据依赖它），且该属性只出现在**已挂载**的书脊上。

## 5. 非目标（明确不做）

### 5.0 已由 Lead 裁决的技术参数（**不再询问，按此实现**）

以下条目曾标为「待你确认」，但属技术参数且**已由 Lead 按官方文档与工程判断裁决**：**T18 T21** —— 明细与理由见 `docs/14-ui-decision-register.md` §1 对应行。实现时直接落该值，**不得**再当作待确认项停下来问；若你认为某条在本模块不成立，在交付报告 §9 提出并说明，不要自行改动。

1. 不实现任何数据查询：`document_recent` / `document_list` 归 M04，`search_global` 归 M11，`bookmark_*` 归 M12，`settings_*` 归 M13；本模块只调 `call`。
2. 不做页面渲染与滚动容器（M06 / M07）、不做文内搜索与高亮（M08）、不定主题令牌（M13）、不解析 PDF、不读 Outline 字节层（M05 只读数据）。
3. 不做库根的增删逻辑与扫描触发（数据归 M04；本模块只做按钮与状态编排）、不做窗口/托盘/多窗口、不做自动更新。
6. **不得自行确定任何未经用户拍板的视觉数值**：13 文档 §7 已明列 D01–D04 四条**已定值**（环半径 0.34、环心上移 4%、visibleArc 200°、书脊 0.42R×28px、竖排书名），这四条必须照此实现；其余视觉项（深度数值、重叠策略、滚轮语义、进入过渡形态、焦点书信息形态、空态形态、色板、背景与三主题关系）仍未定，不得自行选择。
7. 不使用 mock 数据源替代真实接口：真实接口就绪后必须删除 `__MOCK__` 分支（03 §3 第 205 行、13 §4 第 110 行）。
8. 不实现虚拟滚动、不做书脊内容的富文本排版（排版形态在 §7.2 第 2 条）。

## 6. 架构约束

- 允许依赖：M02（`call` / `subscribe` / DTO）、M11 的 `GlobalSearchPanel`、M12 的 `BookmarkList` + `useBookmarks`、M13 的 `useTheme` + `var(--lg-*)`、M07 的 `<ReaderView/>` 入口。
- 禁止依赖：`src/pdf-engine/**`、`src/render/**`（L4 不得 import L2，02 §2 第 56-57 行）；禁止任何 SQL 或表名；禁止在 `src/workspace/**` 内定义颜色常量（必须用 M13 令牌）。
- 状态归属：UI 状态（面板开合、`ringRotation`、焦点 `documentId`）归 zustand store；**旋转的逐帧值不进 React state**，直接写 DOM 的 transform 与 CSS 变量，只有 settled 后才把角度写回 store。
- 资源所有权：`DocumentHandle` 归 L2/L3；本模块只在路由里引用 `documentId`，不持有句柄、不调 `dispose()`。
- 契约缺口（需 Lead 裁定）：
  1. 13 §4 的 `HomeBook.progress.pageNo` 无法从 `DocumentDto` 取得（后者只有 `hasProgress`，05 §2 第 82 行）。首版实现：`load()` 内先 `document_recent({ limit })`，再对返回项并发 `progress_get({ documentId })`（`Promise.all`，`limit ≤ 60`）。若实测超过 13 §5 的 300ms 门槛，按 03 §5 第 234 行提「接口需求」，建议 `DocumentDto` 增补 `progressPageNo`（属契约变更，需 Lead 批准）。
  2. 03 §4 第 226-227 行把 `src/workspace/**` 与 `src/ui/**` 划归 M14，但**未登记** `src/workspace/home/**` 的下级拆分；本模块按 §10 目录落地，请在交付报告 §9 声明。

## 7. 输入与输出

| 输入来源 | 数据形态 | 触发时机 |
|---|---|---|
| M04（经 L1） | `DocumentDto[]`（`document_recent` / `document_list`） | 进入 home、`library://changed` 之后重拉 |
| M12（经 L1） | `ProgressDto | null`、`BookmarkDto[]` | home 取进度、书签面板 |
| M10（事件） | `IndexStatusDto`（`index://progress`） | 索引进度条 |
| M04（事件） | `library://changed` / `library://scan-progress` | 列表与主页刷新 |
| M13 | `useTheme()`、`var(--lg-*)` | 全局 |

| 输出目标 | 数据形态 | 消费方 |
|---|---|---|
| 路由层 | `route` + `documentId` | M07 / M11 / M12 / M13 的容器 |
| 主页 | `HomeBook[]` → 书脊 DOM（带 `data-home-spine`） | 用户 |
| M15 | 稳定性与性能验收目标 | 性能基线脚本 |

### 7.2 【待你确认】清单（原样转写 docs/13-ui-home-concept.md §7 第 129-142 行）

以下每一项都**不得由 Agent 自行决定**，实现时必须留 `TODO(ui-confirm)` 并在交付报告中列出问题：

1. 环半径/环心与视口的比例、可见弧角度、书脊长宽比与宽度。
2. ~~书脊内容排版~~ → **D04 / D12 已定**：竖排书名且**仅书名**（无作者、无页数、无进度条、无未索引/无文本标记）。**A4 已定（悬停 tooltip 文案）：作者、阅读进度。**
3. 色板：具体色值集合（图中为橄榄绿/棕/紫/沙黄/灰绿）；是否引入封面取色（需要读 PDF 首页 → 属 M05 能力，首版建议不做）。
4. ~~深度数值~~ → **D07 已定**：远端 `scale 0.86`、`opacity 0.55`，近端 1.0；**不加**模糊/描边/阴影。
5. ~~重叠与遮挡~~ → **D08 已定**：**允许压盖**，靠前压靠后，`zIndex` 由深度决定；不做最小角距避让、不加分离描边。
6. ~~滚轮语义~~ → **D09 已定**：滚轮 = **旋转转盘**（与拖拽同轴，一格约 12°）。
7. ~~进入过渡形态~~ → **D10 已定**：书脊沿自身长轴抽出并放大，**220ms** 后切到阅读器。
8. ~~焦点书信息~~ → **D11 已定**：环心**下方**居中一行，书名 + 作者 + 「读到第 {page} / {total} 页」。
9. ~~空态形态~~ → **D14 已定**：**不渲染环**，在环心位置显示「还没有文献」+【添加文献库】按钮；文案见 docs/16-copy-deck.md §2。
10. 背景与整体视觉基调（与 light / dark / paper 三主题的关系）。

### 7.3 本模块额外待确认（外壳部分）

A-1. 全局快捷键绑定：打开搜索浮层、书签面板、设置、切换 library 的具体按键（是否 `Ctrl+K` 类约定）。
A-2. 路由是否映射到可回退的历史栈（`back()` 是否出现在 UI 中）；索引进度条的位置、是否可折叠、`no_text` / `failed` 计数是否在条上直显。
A-3. ~~首次使用的发现性提示~~ → **A3 已拍板：「不做引导。」** 不实现任何引导层、气泡、遮罩、高亮提示；首次进入主页与阅读器均直接可用。
A-4. ~~书脊悬停 tooltip 文案~~ → **A4 已拍板：「作者、阅读进度。」** 见 `docs/16-copy-deck.md §6`；缺作者时只显示阅读进度。
A-5. ~~索引失败的逐条原因展示~~ → **A5 已拍板：「给出提示即可。」** `<EmptyState/>`/`<ErrorBanner/>` 只渲染一处汇总提示（文案见 `docs/16-copy-deck.md §3`「索引失败」行），**不做逐条原因列表或详情面板**。

## 8. 接口契约

```ts
// src/workspace/home/data-source.ts —— HomeBook / HomeDataSource 见 13 §4（本 Prompt §4.2 B4）
export interface HomeDataSource { load(): Promise<HomeBook[]> }
export function createHomeDataSource(): HomeDataSource;   // 唯一 mock/真实切换点

// src/workspace/home/HomeSpace.tsx
export interface HomeSpaceProps {
  dataSource: HomeDataSource;          // 由父层注入，组件内部不再 new
  ringRotation?: number;               // 受控入口；缺省时用内部会话角度
  onOpenBook(documentId: number): void;// 只在 opening 状态结束时调用
  onAddLibrary?(): void;               // 空态的「添加文献库」引导，未定形态前传 undefined
}

// src/workspace/router.ts
export type Route = "home" | "library" | "reader" | "settings";
export function useRouter(): {
  route: Route;
  documentId: number | null;
  navigate(route: Route, opts?: { documentId?: number }): void;
  back(): void;
};

// src/workspace/AppShell.tsx —— 无 props：一切状态来自 useRouter() 与 store
export function AppShell(): JSX.Element;
```

**mock 工厂唯一改动点**：`src/workspace/home/data-source.ts` 的 `createHomeDataSource()`。接真实数据源时**只允许改这个文件的一处分支**（把 `createMockHomeDataSource()` 换成 `createIpcHomeDataSource()` 并删除 `__MOCK__` 分支），`<HomeSpace/>` 与其余文件零改动（13 §8 第 7 条判据）。任何新增 mock 分支都必须带 `__MOCK__` 字面标记。

## 9. 数据结构

- 消费的 DTO（不新增、不改）：`DocumentDto`（05 §2 第 74-83 行）、`ProgressDto`（105-108）、`BookmarkDto`（110-114）、`IndexStatusDto`（116-122）、`GlobalSearchPageDto`（143-146）、`ApiError`（34-39）、`TextState`（66）。
- 本模块自有内部类型：`HomeBook`、`HomeDataSource`（13 §4）、`Route`（§8）、`HomeRingState { base: number; focusedId: number | null; phase: "idle" | "rotating" | "focused" | "opening" }`；几何纯函数 `angleToPosition(θ, R, c) -> { x, y, rotation }`、`depthOf(θ) -> t`、`isMounted(θ_i, base, visibleArc) -> boolean`、`deltaFor(N) -> Δ`。

## 10. 文件组织

```text
src/workspace/
  AppShell.tsx            # 外壳：三段式布局 + 路由分发
  router.ts               # Route 类型、useRouter、路由表
  hotkeys.ts / subscriptions.ts   # useGlobalHotkeys：唯一键盘入口；useIpcSubscriptions：统一订阅与清理
  layout/{AppFrame.tsx,StatusBar.tsx,IndexProgressBar.tsx}   surfaces/{ErrorSurface.tsx,EmptyState.tsx}
  panels/{SearchOverlay.tsx,Sidebar.tsx,BookmarkDock.tsx}   # 只编排，内容组件来自 M11/M12/M08
  library/LibraryView.tsx  # 列表视图（排序/过滤走 DocumentQuery，05 §2 第 94-101 行）
  home/
    HomeSpace.tsx          # 容器：只挂载可见弧、注入 transform
    home-geometry.ts       # 纯函数：角度/位置/深度/挂载判定（可单测）
    ring-rotation.ts / use-home-interaction.ts   # 拖拽/滚轮/惯性/对 2π 取模，直接改 DOM
    FocusedBookInfo.tsx / HomeEmptyState.tsx   # 焦点书信息位（D11 已定）+ 空态（D14 已定：不画环）
    data-source.ts         # createHomeDataSource：唯一切换点
    mock-data-source.ts    # 【__MOCK__】真实接口就绪后删除
    home-geometry.test.ts / ring-rotation.test.ts / HomeSpace.test.tsx
src/ui/   # 无状态基础组件（03 §4 第 227 行），不得含业务逻辑：Button.tsx / IconButton.tsx / Dialog.tsx / ScrollArea.tsx
```

## 11. 实施步骤

1. 外壳与路由：`AppShell` + `useRouter` + 四个空路由页，`navigate("reader")` 无 id 被拒。
2. 空态：`<EmptyState/>` + 主页空态容器（不渲染环）。
3. `HomeDataSource` 假数据：`mock-data-source.ts`（`__MOCK__`）+ `createHomeDataSource`，`<HomeSpace/>` 打印 `N`。
4. 转盘几何：`home-geometry.ts` 纯函数 + 单测；按可见弧判定挂载，`data-home-spine` 计数 ≤ 上限公式。
5. 旋转交互：`ring-rotation.ts` 直接改 DOM transform，拖拽/滚轮/键盘共用同一角度源，角度对 `2π` 取模。
6. 焦点书：焦点判定（`+90°` 最近）、`focused` 状态、信息位组件（内容按 D11：书名 + 作者 + 「读到第 {page} / {total} 页」）。
7. 键盘与无障碍：`←`/`→`/`Enter`/`Esc`/`prefers-reduced-motion`；非挂载书脊不可聚焦（因为不存在）。
8. 接真实数据源：`createIpcHomeDataSource` 用 `document_recent` → 回退 `document_list` → 并发 `progress_get`；删除 `__MOCK__` 分支。
9. 面板编排：搜索浮层、侧栏、书签、索引进度条；订阅清理；`ErrorSurface` 接 `library://scan-progress` 的 `error` 字段。

## 12. 测试要求

纯逻辑（vitest，必须有）：
- `deltaFor(N)`：N=0 守卫（不参与环）；N=1/2 特殊分支；N=12 → 30°；N=60 → 6°；N<12 时按 `max(N,12)` 得 30°。
- `normalize(θ)`：`-10° → 350°`；`370° → 10°`；`720° → 0°`。
- `isMounted`：边界 `abs(normalize(θ - base)) == visibleArc / 2` 判为挂载（闭区间），超出 1° 判为不挂载；`depthOf`：`sin θ = 1` → t=1、`sin θ = -1` → t=0。
- 挂载上限：`N ∈ [0,1,2,12,60]` × base 取 12 个角度，断言渲染数 ≤ `ceil(visibleArc/360 × N) + 2`。

组件（`@testing-library/react` + jsdom）：
- `N = 0` 渲染空态且 `[data-home-spine]` 计数 = 0；`N = 1` 单本不旋转；`N = 2` 两本分列；`N = 12` / 60 挂载数符合上限。
- 键盘：`←` 使 `base` 变化一格 `Δ`；`Enter` 触发 `onOpenBook` 且参数 = 焦点书 `documentId`；`Esc` 取消聚焦；拖拽不触发 render：用 `<Profiler onRender>` 计数，模拟 3 秒 `pointermove` 序列（`fireEvent` 循环）后计数 = 0。
- `matchMedia("(prefers-reduced-motion: reduce)")` 桩为 `true` → 松手后角度直接等于目标值（无惯性）。
- 数据源切换：`createHomeDataSource()` 返回对象满足 `HomeDataSource`；全仓搜索 `__MOCK__` 仅出现在 `mock-data-source.ts`。
## 13. 验收标准

**先逐条搬入 docs/13-ui-home-concept.md §8 的 8 条：**
1. `N = 0 / 1 / 2 / 12 / 60` 五档均不崩、不重叠成糊、可键盘操作。
2. 隐藏弧段 DOM 数为 0（用 `data-home-spine` 计数验证）。
3. 拖拽 3 秒期间无 React 重渲染、无 >16ms 长任务、≥55fps（N=60）。
4. 旋转离开再回到同一角度，书脊位置确定一致（无累积漂移：角度对 `2π` 取模）。
5. `prefers-reduced-motion` 下无惯性动画。
6. 数据源为空时走空态，不渲染空环。
7. `HomeDataSource` 可在 mock 与真实实现间切换，切换只改一处工厂函数。
8. 交付时列出 §7.2 十条的当前实现取值与待确认问题。

**本模块补充：**
9. 路由切换不重建 PDF 文档实例：`reader` → `library` → `reader` 回同一 `documentId` 时，`openDocument` 调用计数不变（用 spy 断言），且本模块未调用 `dispose()`。
10. 五档 `N ∈ {0,1,2,12,60}` 各有截图或断言：截图存 `artifacts/home/n-{0,1,2,12,60}.png`；无截图能力时必须是测试断言（挂载计数 + 无异常抛出）；且 `document.querySelectorAll("[data-home-spine]").length ≤ ceil(visibleArc / 360 × N) + 2` 在 N=12 与 N=60 各验证 12 个不同 `base`。
11. 拖拽 3 秒期间 React 渲染次数 = 0（`<Profiler>` 计数断言），且旋转只写 `transform` / `opacity`（断言无 `left`/`top`/`width` 变化，不发生回流）；`npx tsc --noEmit` 0 错误；`src/workspace/**` 内无颜色字面量（grep `#[0-9a-fA-F]{3,6}` 与 `rgba?(` 自查，命中即缺陷）、无 `any`、无 `@ts-ignore`。

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

1. 不得用 `display:none` / `visibility:hidden` / `opacity:0` / `aria-hidden` 让隐藏弧的书「不渲染」——隐藏弧必须**不创建 DOM**（13 §2 第 48 行、_shared-context §H 第 87 行）。
2. 不得把 `ringRotation` 放进 React state 驱动逐帧重渲染（必须直接改 DOM transform / CSS 变量）。
3. 不得用「分页」式整体替换布局实现书脊进出（旋转是唯一机制）。
4. 不得自行确定 §7.2 十条中的任何数值，也不得自行选择进入阅读器的过渡形态。
5. 不得在本模块内实现数据查询（尤其是最近阅读排序与 FTS 检索），不得直连 SQLite 或出现表名。
6. 不得把 `<HomeSpace/>` 做成阅读器的前置弹窗，或让 `home` 依赖 `reader` 的挂载（13 §6 第 124 行）。
