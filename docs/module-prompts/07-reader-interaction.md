# 模块 M07：reader-interaction

> 依赖前置：M06 render-scheduler（`RenderScheduler` + `computeVisibleRange` 已可用）、M05 的文本层适配器（`PdfTextLayerFactory` 或 `buildTextSpans`）；被依赖方：M08 doc-search、M14 workspace-shell。
> 归属层：L3（React）；并行组：E（`M05 → M06 → M07 → M08` 串行，见 `docs/03-module-boundaries.md` §3 第 197–198 行）。

## 1. 模块身份

M07 是阅读界面的"骨与关节"：它拥有滚动容器、页面占位、缩放与导航、文本选择与复制、快捷键、阅读进度的节流保存与恢复；它是 M06 的**唯一视口输入方**，也是 M05 文本层唯一的 DOM 承载者。它不渲染 PDF（M06 调度、M05 出图），不搜索（M08），不存书签（M12），不定主题令牌（M13）。
在数据流里：用户手势/滚动 → M07 算 `ViewportState` → M06 `setViewport` → 订阅 `PageRenderState` → 只为 `ready` 页把 canvas 挂进占位 → 进度变化节流 1s 交给持久化端口。

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

交付一个 `src/reader/` React 组件族 + `ReaderProvider/useReader()`：同一 `DocumentHandle` 支持连续滚动与单页翻页两种模式（模式切换不重载文档）、缩放带锚点、跳页、文本可选可复制、快捷键可用、进度节流保存并在首屏渲染前完成恢复，且卸载后无残留监听。

分解目标：

1. 两种模式共用同一 `DocumentHandle` 与同一 `RenderScheduler`，切模式只改视口。
2. 只为 M06 广播出来的页建占位，`ready` 且 scale 匹配才挂 canvas（M07 不自己发 `render()`）。
3. 进度恢复发生在首次 `setViewport` 之前（无第 1 页闪烁）。
4. 25%–400% 缩放下锚点位移 < 2px。
5. 文本选择可复制，且复制内容不含任何 UI 文本。
6. 卸载后订阅/监听/定时器计数归零。

## 4. 功能范围（必须完成）

### 4.0 外壳契约（D15/D17/D18/D19 已由用户拍板，照此实现，不得再问）

| 项 | 已定结论 |
|---|---|
| 控件形态 | **完全无工具栏**。左、右各一枚 40px 圆形悬浮按钮，垂直居中、距视口左右边各 24px；点击就地展开为**竖排**控件组，再次点击或点空白处收起 |
| 左侧按钮组 | 导航：上一页 / 下一页 / 跳页输入 / 目录（PDF Outline） |
| 右侧按钮组 | 视图：缩放 − / 缩放比例 / 缩放 + / 模式切换（连续 ↔ 单页）/ 搜索入口 / 加书签 |
| 隐藏策略 | 按钮默认 60% 不透明度，鼠标进入该侧 80px 内升到 100%；2s 无操作回落到 60%。**不做自动整体隐藏**（否则无条时控件会彻底消失） |
| 阅读区留白 | 上下 `32px`（`--lg-space-6`）、左右随容器自适应 |
| 页间距 | 连续模式 `pageGap = 12px`（`--lg-space-3`）；单页模式无间距 |
| 页容器 | `1px solid var(--lg-page-border)` + 极淡阴影，`border-radius: 0` |
| 单页长页对齐 | **顶部对齐**（不居中、不按 scrollRatio 偏移） |
| 快捷键为主入口 | 所有按钮组内的动作都必须有快捷键与键盘可达路径（按钮可用 Tab 聚焦、Enter 触发） |

| 页码指示（D16） | 视口**底部居中**半透明胶囊：`{page} / {total}`，底色 `--lg-bg-elevated` + 60% 不透明、文字 `--lg-fg-secondary`、`--lg-radius-sm`；翻页或滚动时淡入 100%，静止 **2s** 后淡到 **30%**；悬停恢复 100% |

**仍未定（不得自行发明）**：首次使用的发现性提示形态（无工具栏时"控件在哪"需要一次引导，见 docs/16-copy-deck.md §8）。

### 4.1 DOM 骨架（结构可定，样式不得定）

1. 结构（类名仅为示意，实现可改名，但**层级与职责不可变**）：

```text
<ReaderProvider document={DocumentHandle} progress={ProgressDto|null} port={ProgressPort} onRequestExit>
  <ReaderSurface data-reader-surface>          唯一滚动容器（overflow-y: auto）
    <PageSlot data-page-no={n} style={{height: pageH(n)}}>   高 = geometry.heightPt * scale
      <canvas/>                                  ← M06 的只读位图（state==="ready" 且 scale 匹配时挂载）
      <HighlightLayer/>                          ← M08 注入（pointer-events: none）
      <TextLayerHost/>                           ← M05 文本层适配器挂载点
    </PageSlot>
  </ReaderSurface>
  ...（工具栏 / 页码指示 / 侧栏：形态全部待确认）
</ReaderProvider>
```

2. 全应用阅读区只有**一层**滚动容器 `ReaderSurface`；内部不得再有可滚动元素（避免滚动事件源分裂）。模态面板若需滚动，必须挂到 `ReaderSurface` 之外。
3. `PageSlot` 集合 = M06 `subscribe` 快照里的 key 集合（即预取窗口内的页）。**不得**自己另算一套可见页集合；需要可见页口径时 import M06 的 `computeVisibleRange()`（§8）。
4. 连续模式：所有 slot 按 `pageNo` 竖直排列，位置由 slot 高度自然堆叠（不用绝对定位算 y）。
5. 单页模式：同一个 `ReaderSurface`，只渲染当前页的 slot；其余 slot 不创建（不是隐藏）。
6. **模式切换**：`setMode(m)` 只做三件事——改状态、重算 `ViewportState`、`scheduler.setViewport` 一次；**禁止**重建 `DocumentHandle`、**禁止**再次 `openDocument`（02 §5 第 178 行）。
7. 页高公式与 M06 完全一致（`geometry.heightPt * scale`，加 `layout.gap` 时同样取自 `RenderLayout`）；在 `src/reader/layout-math.ts` 里**调用** M06 的导出口径，不复制公式实现。

### 4.2 滚动 → 视口

8. `scroll` 事件用 rAF 合并：一帧内多次滚动只发一次 `setViewport`；卸载时必须 `cancelAnimationFrame`。
9. `ViewportState` 构造：`mode`、`scale`、`scrollTop `=` ReaderSurface.scrollTop`、`viewportHeight/Width` = 容器 `clientHeight/clientWidth`（用 `ResizeObserver` 更新，卸载 `disconnect`）、`pageGeometries` = 由 `DocumentHandle.getPage(i).geometry` 一次性收集后缓存（打开文档后收集一次，模式切换不重收集）。
10. 几何收集必须容错：`getPage(i)` reject 时用前一页几何兜底并 `console.warn`（带 `pageNo`），不得让整个阅读器白屏。

### 4.3 缩放（含锚点）

11. `setScale(s, anchor?)`：`s` 夹取到 `[0.25, 4]`；`anchor` 形如 `{ pageNo, ratioX, ratioY }`（`docs/05-api-contracts.md` §7 第 330 行），缺省时用"视口中心所在页 + 中心比例"作为锚点。
12. 锚点算法（两次都用同一份 offset 表，实现放 `src/reader/zoom-anchor.ts`，纯函数可测）：

```text
p  = offset(pageNo - 1) + ratioY * pageH(pageNo - 1)          // 缩放前锚点的文档纵向位置
p' = offset'(pageNo - 1) + ratioY * pageH'(pageNo - 1)        // 用新 scale 重算的同一位置
scrollTop' = clamp(scrollTop + (p' - p), 0, totalHeight' - viewportHeight)
```

13. 缩放后槽位高度按新 scale 重排；旧 scale 的 canvas 立即摘除（`state.scale !== scale` 时不挂），避免拉伸糊图（该项与 M06 待确认第 4 条绑定，若 M06 的结论是"允许旧图顶替"，这里改为保留但标记 `data-stale`）。
14. 缩放触发源：`Ctrl` + 滚轮（监听必须 `{ passive: false }` + `preventDefault`，否则 WebView 会缩放整个页面）、快捷键、UI 控件（控件形态待确认）。手势/控件的**存在**是本模块职责，**外观**不是。

### 4.4 跳页

15. `goToPage(pageNo, opts?)`：clamp 到 `[1, pageCount]`；单页模式改当前页；连续模式 `scrollTo({ top: offset(pageNo-1) + 1 })`（+1 抵消二分开区间）；`opts.highlightRanges` **原样转交** M08（M07 自己不做高亮，不解析区间）。
16. 跳页后 100ms 内不得再被"恢复到上次位置"逻辑覆盖（用一个 `suppressRestoreUntil` 时间戳；这是防抖而非视觉项）。

### 4.5 文本选择与复制

17. 文本层由 M05 的适配器挂进 `TextLayerHost`（路径 A：`PdfTextLayerFactory.attach`；路径 B：用 `buildTextSpans` 自建 span）。M07 决定容器、层级与样式，**不决定**文本抽取逻辑。
18. 选择层不能挡住 canvas 渲染：canvas 必须保持可见（不得 `opacity: 0` / `visibility: hidden` / `display: none`），文本层与高亮层背景透明，`HighlightLayer` 与 canvas 均 `pointer-events: none`，指针事件由 `ReaderSurface` 与文本层处理。
19. 文本层容器 `user-select: text`；所有非文本 UI（工具栏、页码指示、按钮、面板）必须带 `data-ui` 与 `user-select: none`，确保浏览器原生选择不会把 UI 文本选进去。
20. `getSelectionText()`：取 `window.getSelection()`；若 `anchorNode` 或 `focusNode` 不在 `ReaderSurface` 内 → 返回 `""`；否则返回 `toString().trim()`。**禁止**自定义文本拼接（避免与光标位置/跨页顺序错位）。
21. 不拦截 `copy` 事件，不自己写剪贴板；跨页选择按浏览器默认行为。

### 4.6 快捷键（键位表见下，采纳与否待确认）

22. 键位集中为常量 `DEFAULT_KEYMAP`（`src/reader/keymap.ts`），便于后续用户改键；监听挂在 `ReaderSurface`（`tabIndex=0`）而非 `window`，避免抢输入框焦点；焦点在 `input`/`textarea`/`contenteditable` 内时一律不响应。

| 动作 | 建议键位 | 说明 |
|---|---|---|
| 下一页 / 上一页（单页模式） | `ArrowRight` / `ArrowLeft` | 连续模式下改为滚动一屏的 1/8 |
| 滚动一屏 | `Space` / `Shift+Space` | 连续模式为主；有文本选择时不拦截 |
| 首页 / 末页 | `Home` / `End` | 直接 `goToPage(1 / pageCount)` |
| 放大 / 缩小 / 重置 | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | 重置回 100% |
| 打开搜索（M08） | `Ctrl+F` | 只发出 `onRequestSearch()`，不实现搜索 |
| 复制选择 | `Ctrl+C` | 浏览器默认，不拦截 |
| 返回（不退出全屏/不打断选择） | `Esc` | 仅在无文本选择时 `onRequestExit`（与 13 §3 第 80 行 `Esc` 返回主页不冲突，路由归 M14） |

23. 所有键位处理必须 `preventDefault` 只在被自身消费时调用；未命中映射的按键一律放行。

### 4.7 进度节流保存与恢复

24. 采集：`currentPage`（可见页第一页）、`scrollRatio = scrollTop / max(1, totalHeight - viewportHeight)`（夹取到 `[0,1]`）、`zoom = scale`、`mode`，组装成 `ProgressDto`（`docs/05-api-contracts.md` §2 第 105–108 行，`updatedAt` 用 `new Date().toISOString()`）。
25. 节流：任一字段变化后启动/复用 **1000ms** 定时器，窗口结束提交一次；`beforeunload`、切换文档、组件卸载前必须 **flush** 最后一次（"节流不丢最后一次"是硬要求）。
26. 持久化**不在本模块**：通过注入的 `ProgressPort `=`{ load(documentId): Promise<ProgressDto|null>; save(p: ProgressDto): Promise<void> }` 完成；默认实现由 M12 用 `progress_get`/`progress_save` 提供，M14 负责装配。M07 **禁止**直接 `invoke` 这两个命令。
27. 恢复：`ReaderProvider` 挂载时先取 `progress`（props 或 `port.load`），在**首次** `setViewport` 之前完成：`mode = progress.mode`、`scale = progress.zoom`（夹取 25%–400%）、`scrollTop = offset(pageNo-1) + scrollRatio * (pageH(pageNo-1) - viewportHeight)`（clamp `>= 0`）。因此不存在"先渲染第 1 页"的渲染序列。
28. 恢复失败（`port.load` reject 或 `null`）→ 从第 1 页、100%、连续模式开始，`console.warn` 一条带 `documentId`，不阻塞首屏。

### 4.8 ReaderApi 与 Provider

29. 实现 `ReaderApi`（`docs/05-api-contracts.md` §7 第 327–333 行）：`mode/scale/currentPage/pageCount` 只读 + `setMode/setScale/goToPage/getSelectionText`。
30. `ReaderProvider` 持有 `RenderScheduler` 实例、`DocumentHandle` 引用、订阅、rAF 句柄、定时器；`useReader()` 从 context 取 `ReaderApi`（03 §M07 第 102 行）。
31. 与 scheduler 的桥接顺序（挂载）：`setDocument(handle)` → 收集 pageGeometries → 由进度算初值 → `setViewport(初值)` → `subscribe` → 渲染 slot。卸载顺序：`unsubscribe` → 取消 rAF/定时器/ResizeObserver/键盘监听 → flush 进度。**M07 不得调用 `scheduler.dispose()` 或 `handle.dispose()`**（所有权见 §6）。

## 5. 非目标（明确不做）

### 5.0 已由 Lead 裁决的技术参数（**不再询问，按此实现**）

> 追加 **T12（页面热区部分）**：页间空隙与阅读区留白**不响应**点击/悬停事件（不实现"点空隙翻页"、不把留白当热区）。原因是误触翻页的代价高于便利性。（明细见 `docs/14-ui-decision-register.md` §1）

以下条目曾标为「待你确认」，但属技术参数且**已由 Lead 按官方文档与工程判断裁决**：**T14 T15 T16 T21** —— 明细与理由见 `docs/14-ui-decision-register.md` §1 对应行。实现时直接落该值，**不得**再当作待确认项停下来问；若你认为某条在本模块不成立，在交付报告 §9 提出并说明，不要自行改动。

1. **不实现搜索**（M08）：不做命中匹配、不做高亮 DOM、不算矩形；只提供 `onRequestSearch()` 与把 `highlightRanges` 转交。
2. **不存书签**、不读写数据库、不 `invoke` 任何 Command（进度经注入端口）。书签属 M12。
3. **不定主题令牌**（M13）：颜色、背景、纸色光罩全部来自 `ThemeTokens` 注入；本模块不写死色值。
4. **不直接调 `page.render()`**、不 import `pdfjs-dist`、不持有 canvas 生命周期（02 §5 第 180 行）。
5. 不做目录树面板的取数逻辑（`getOutline()` 的消费界面属 M14 或后续模块，本模块只暴露 `outline` 数据与跳转回调）。
6. 不做缩略图、双页跨页视图、注释层、朗读。
7. 不做路由（`home/library/reader/settings` 属 M14）；`Esc` 只发回调。
8. **不得自行确定视觉方案**：留白、间距、工具栏形态、页码指示位置与样式、缩放控件形态一律 `TODO(ui-confirm)`；文本层透明度与层级 z 已由 D20 冻结（`docs/15-theme-tokens.md` §5），动效时长/曲线已由该文档 §6 冻结，且不得为"看起来完整"虚构一套视觉。

### 本模块的【待你确认】清单（不得自行决定，实现留 `TODO(ui-confirm)`）

1. ~~阅读区留白/页间距~~ → **D17 已拍板**：上下 `32px`、页间 `12px`（见 §4.0），且**必须与 M06 的 `RenderLayout.gap` 同源**（一处配置，由 M06 提供常量、M07 只消费，不得各写一份）。仍然待确认：
2. ~~工具栏形态与控件集~~ → **D15 已拍板**：完全无工具栏，左右悬浮 40px 圆按钮 + 竖排展开；左侧=导航（上/下页、跳页、目录），右侧=视图（缩放 −/比例/+、模式切换、搜索、加书签）。见 §4.0。
3. 页码指示的位置与形式（悬浮角标 / 底部条 / 输入框跳页）。
4. ~~文本层文字颜色与不透明度~~ → **D20 已拍板**：文字完全透明（`color: transparent`），只用于选择；不得用半透明灰（会与 PDF 字形重影）。见 `docs/15-theme-tokens.md` §5。
5. ~~层级 z-index 数值~~ → **D20 已拍板**：canvas 0 / TextLayer 10 / 高亮层 20 / 阅读器界面 30 / 浮层 100（顺序与数值都冻结，见 `docs/15-theme-tokens.md` §5）。
6. 快捷键表（§4.6 七行）是否采纳、是否需要 `Vim` 风格 `j/k`。**推荐**采纳现表并保留改键能力。
7. 缩放控件形态（无控件只靠快捷键 / 百分比输入 / 加减按钮）。
8. 无文本页（扫描件）的提示形态（本模块只按 `E_PDF_NO_TEXT` 决定"是否显示提示"，样式待定）。

## 6. 架构约束

- **允许依赖**：`src/render` 的公开出口（`RenderScheduler`、`computeVisibleRange`、`PageRenderState` 等类型）、`src/pdf-engine` 的公开类型与文本层适配器、`src/contracts` 的 `ProgressDto/ReadMode/ApiError`、`src/theme` 注入的 `ThemeTokens`（只读使用，不改）。
- **禁止依赖**：`pdfjs-dist`（02 §2 第 57 行）、任何 SQL/FTS 概念、`src/reader/search/**` 的实现（M08 反向依赖本模块）、`src/workspace/**`、`src-tauri/**`、M12 的持久化实现（只用 `ProgressPort` 接口）。
- **资源所有权**：
  1. `DocumentHandle` 与 `RenderScheduler` 由**外部**（M14 打开文献时）创建并释放；M07 只使用、只 `unsubscribe`。
  2. canvas 归 M06；M07 只 append/remove DOM 节点，不改 `width/height`、不绘制。
  3. 定时器/rAF/ResizeObserver/键盘监听归 M07，必须在卸载路径里显式清理。
- **状态归属**：`ReaderState { mode, scale, currentPage, pageCount, scrollTop }` 单一来源在 `ReaderProvider`（React state）；**不得**把同一状态同时放进 zustand 与 React state（M13/M14 需要读时通过 `useReader()`）。
- **不负责清单**：PDF 解析与渲染、搜索、书签存储、主题令牌、路由、IPC 调用。

## 7. 输入与输出

| 输入来源 | 数据形态 | 触发时机 |
|---|---|---|
| M14 | `document: DocumentHandle` | 打开文献 |
| M12（经 `ProgressPort`） | `ProgressDto \| null`（05 §2 第 105–108 行） | Provider 挂载 |
| M13 | `ThemeTokens` | 主题变化 |
| M06 | `PageRenderState` 快照 / `getPageState` | 每次调度 tick |
| M05 | `OutlineNode[]`、`PdfMetadata`、文本层适配器 | 目录面板、文本层挂载 |
| 用户 | 滚动、滚轮、键盘、选择 | 持续 |

| 输出目标 | 数据形态 | 消费方 |
|---|---|---|
| M06 | `setViewport(ViewportState)` | 滚动/缩放/模式切换/跳页 |
| M06 | `setDocument(handle)` / `subscribe` | 挂载桥接 |
| M08 | `ReaderApi`、`onRequestSearch()`、`goToPage(pageNo, { highlightRanges })` | 搜索面板与命中跳转 |
| M12（经 `ProgressPort`） | `ProgressDto`（1s 节流 + flush） | 进度持久化 |
| M14 | `ReaderApi`、`onRequestExit()` | 布局与路由 |

## 8. 接口契约

**契约内（逐字实现，`docs/05-api-contracts.md` §7）**：

| 类型 | 行号 | 本模块责任 |
|---|---|---|
| `ReaderApi` | 327–333 | 六个成员签名与语义（`setScale` 的 `anchor` 形状、`goToPage` 的 `highlightRanges`） |
| `ViewportState` | 306–310 | 构造并传给 M06 |
| `PageRenderState` / `PageState` | 297–304 | 消费（决定挂载与提示） |
| `ReadMode` | 67 | `"continuous" \| "single"` |
| `ProgressDto` | 105–108 | 采集、节流提交、恢复 |
| `ApiError` | 34–39 | 页面级错误的展示来源（只按 `code` 分支） |

**模块新增内部接口（需在报告 §8 声明）**：

```ts
// src/reader/reader-provider.tsx
export interface ReaderProviderProps {
  document: DocumentHandle;
  progress: ProgressDto | null;
  port: ProgressPort;
  onRequestExit?: () => void;
}
export function ReaderProvider(p: ReaderProviderProps): JSX.Element;
export function useReader(): ReaderApi;

// src/reader/progress-port.ts
export interface ProgressPort {
  load(documentId: number): Promise<ProgressDto | null>;
  save(p: ProgressDto): Promise<void>;
}

// src/reader/zoom-anchor.ts（纯函数，可测）
export function computeAnchorScroll(
  prev: { scrollTop: number; scale: number; pageOffset: number; pageHeight: number; ratioY: number },
  next: { scale: number; pageOffset: number; pageHeight: number; viewportHeight: number; totalHeight: number }
): number;

// src/reader/keymap.ts
export const DEFAULT_KEYMAP: Readonly<Record<string, ReaderAction>>;

// src/reader/reader-surface.tsx
export interface ReaderSurfaceProps { onRequestSearch?: () => void; highlightSlot?: (pageNo: number) => React.ReactNode }
```

## 9. 数据结构

- `ReaderState { mode: ReadMode; scale: number; currentPage: number; pageCount: number; scrollTop: number }`：Provider 内单一来源。
- `ProgressDto`（契约）：`documentId/pageNo/scrollRatio/zoom/mode/updatedAt` —— 采集映射见 §4.7 第 24 条，`updatedAt` 为 ISO 字符串。
- `PageSlotMeta { pageNo, height, top, mounted, state }`：由 `PageRenderState` + 页高派生，仅内部使用。
- `ZoomAnchor { pageNo: number; ratioX: number; ratioY: number }`：契约既有形状（05 §7 第 330 行），不新增字段。
- `ReaderAction`：`"nextPage" | "prevPage" | "scrollForward" | "scrollBack" | "firstPage" | "lastPage" | "zoomIn" | "zoomOut" | "zoomReset" | "search" | "exit"`。
- 状态与 DTO 的边界：本模块**不定义**任何与 04 的表结构相关的类型；进度只以 `ProgressDto` 出入。

## 10. 文件组织

```text
src/reader/
  index.ts                 # 公开出口：ReaderProvider / useReader / ReaderApi 类型
  reader-provider.tsx      # 状态单一来源、桥接 scheduler、订阅与清理（目标 < 200 行）
  reader-surface.tsx       # 唯一滚动容器、rAF 合并、ResizeObserver、键盘监听挂载
  page-slot.tsx            # 占位 + canvas 挂载 + HighlightLayer 插槽 + TextLayerHost
  text-layer-host.tsx      # 调用 M05 文本层适配器（路径 A/B），只负责容器与清理
  zoom-anchor.ts           # 锚点滚动纯函数
  layout-math.ts           # 复用 M06 computeVisibleRange/页高口径，不复制公式
  keymap.ts                # DEFAULT_KEYMAP + 事件→动作解析（纯函数）
  progress-collector.ts    # ProgressDto 采集 + 1s 节流 + flush
  selection.ts             # getSelectionText 的 contains 判定与 trim
  reader.css.ts            # 仅结构必需样式；视觉值一律 TODO(ui-confirm)
  __tests__/
    mode-switch.test.tsx       # 断言 openDocument 只调一次
    progress-restore.test.tsx  # 断言渲染序列首项是第 200 页
    zoom-anchor.test.ts        # 25%–400% 位移 < 2px
    selection.test.tsx         # 复制文本不含 UI 文本
    teardown.test.tsx          # 卸载后监听/定时器计数为 0
```

## 11. 实施步骤

1. 落 `layout-math.ts` + `zoom-anchor.ts` 与各自单测（纯函数先行，无 React）。
2. 落 `reader-provider.tsx` 的挂载桥接（setDocument → 几何收集 → 进度初值 → setViewport → subscribe）与 `mode-switch.test.tsx`：用 fake scheduler + fake handle，断言 `openDocument`/`getDocument` 调用计数 === 1。
3. 落 `reader-surface.tsx` + `page-slot.tsx`：滚动 rAF 合并、只为快照 key 建 slot、`ready` 且 scale 匹配才挂 canvas。
4. 落 `text-layer-host.tsx` + `selection.ts` + `selection.test.tsx`：文本层挂载、`user-select` 行为、`getSelectionText` 边界（选择在外部 → `""`）。
5. 落 `keymap.ts` + 键盘用例（焦点在输入框时不响应、未映射键不 `preventDefault`）。
6. 落 `progress-collector.ts` 与 `progress-restore.test.tsx`：断言首个 `setViewport` 已带第 200 页与恢复 scale，且首个被渲染的模拟页号 === 200。
7. 接真实 M05/M06 集成冒烟：打开样本、连续滚 10 秒、缩放 25%↔400%、切模式两次、卸载，观察并发、内存与监听清空。

## 12. 测试要求

**命令**：`npx vitest run src/reader --environment jsdom`；`npx tsc --noEmit`。本模块无 Rust 代码。

单元/组件（jsdom + fake scheduler，不需要真实 PDF）：

- 正常路径：挂载 → 首个 `setViewport` 的 `mode/scale/scrollTop` 与 `ProgressDto` 派生值一致。
- 模式切换：`setMode("single")` 后 `setViewport` 调用一次、`openDocument/getDocument` 计数仍为 1、`DocumentHandle.getPage` 未被重新请求（缓存命中）。
- 边界：`goToPage(0)` / `goToPage(pageCount+1)` 被 clamp；`setScale(0.01)` → 0.25，`setScale(99)` → 4。
- 边界：`progress === null` → 第 1 页、100%、continuous；`progress.zoom = 0` → 夹取到 0.25。
- 错误路径：`getPage(i)` reject → 该 slot 用前一页高度兜底，界面不抛异常，`console.warn` 一次。
- 缩放锚点：scale 从 0.25 → 4（分 6 步），每步断言锚点所在文档点在屏幕上的位移 < 2px（用 `computeAnchorScroll` 的返回值与容器几何算出）。
- 选择：构造跨两个 slot 的选择 → `getSelectionText()` 含正文且不含 `data-ui` 文本；选择在 surface 外 → ""。
- 键盘：焦点在 `<input>` 内按 `ArrowRight` → 页码不变；未映射键 → `preventDefault` 未被调用（spy 断言）。
- 清理：卸载后 `rafHandles === 0`、`timers === 0`、`observers === 0`、`listeners === 0`、scheduler 未 dispose（用 spy 断言 `dispose` 调用次数为 0）。

集成（真实 M05/M06，样本缺失时标「未验证」）：

- 300 页样本打开 → 进度伪装到第 200 页 → 记录 `render` 请求序列，断言第一个 `pageNo` 是 200 或 199（±1 容忍相邻预取），**不含**第 1 页。
- 连续滚 10 秒 + 缩放 6 次：无未捕获异常、无 `console.error`、`activeTasks` 峰值 ≤ 2。

## 13. 验收标准

1. `npx vitest run src/reader` 全绿；`npx tsc --noEmit` 无错。
2. **模式切换不重载文档**：连续↔单页各切 3 次，`openDocument` / pdfjs `getDocument` 的调用计数 === 1（测试打印计数）。
3. **进度恢复无闪烁**：恢复到第 200 页时，渲染请求序列的第一个页号 ∈ {199, 200}，且序列中不含第 1 页（断言打印前 5 个页号）。
4. **缩放锚点稳定**：25% → 400% 六步缩放后锚点位移 < 2px（逐步打印位移）。
5. **选择可复制且不含 UI 文本**：`getSelectionText()` 的结果不含页码指示/工具栏文案；含 `data-ui` 的最小用例必须为 `""` 或纯正文。
6. **卸载无残留**：拉起的 rAF/定时器/ResizeObserver/键盘监听计数全为 0；scheduler 与 handle 的 `dispose` 调用次数为 0（所有权归 M14）。
7. 页 slot 集合 === M06 快照 key 集合（同一次 tick 内断言相等）。
8. 单页模式下 DOM 中 `[data-page-no]` 数量 === 1（不是隐藏，是未创建）。
9. 隔离性：`grep -rn "pdfjs-dist" src/reader` 无命中；`grep -rn "page.render(" src/reader` 无命中。
10. 【待你确认】八条在报告 §6 逐条列出，代码中对应位置有 `TODO(ui-confirm)` 标记（`grep -rn "TODO(ui-confirm)" src/reader` 命中数 ≥ 待确认条目涉及点数）。

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

1. **不得**在模式切换、缩放或跳页路径上重建 `DocumentHandle` / 重新 `openDocument` —— 那是阅读器最严重的一类缺陷。
2. **不得**在组件里调用 `page.render()`、`getTextContent()` 之外的 M05 渲染能力，也不得 import `pdfjs-dist`。
3. **不得**在 `src/reader` 内实现搜索匹配、高亮矩形计算或书签持久化（M08 / M12 职责）。
4. **不得**直接 `invoke` `progress_save` / `progress_get` 或任何 Command；进度只经 `ProgressPort`。
5. **不得**调用 `scheduler.dispose()` / `DocumentHandle.dispose()`（所有权属 M14），也不得在卸载时取消 M06 的任务。
6. **不得**写死任何视觉数值（留白、颜色、z-index、动效）；一律 `TODO(ui-confirm)`。
7. **不得**用 `window` 级键盘监听抢键（必须在 `ReaderSurface` 内且跳过输入控件）。
