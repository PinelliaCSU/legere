# 模块 M05：pdf-engine

> 依赖前置：M02 contracts（`ApiError`、`src/contracts/*`、IPC 客户端）；被依赖方：M06 render-scheduler。
> 归属层：L2；并行组：E（`M05 → M06 → M07 → M08` 串行，见 `docs/03-module-boundaries.md` §3 第 197–198 行）。

## 1. 模块身份

M05 是全项目**唯一允许 import `pdfjs-dist`** 的模块（硬规则见 `docs/02-system-architecture.md` §2 第 57 行；类型归属见 `docs/05-api-contracts.md` §7 第 252 行注释）。它把 pdfjs-dist 的 Display API 收敛成 7 个稳定类型（`PdfEngine` / `DocumentHandle` / `PageHandle` / `TextContentHandle` / `OutlineNode` / `PdfMetadata` / `RenderTaskHandle`），向上只回答三件事：文档生命周期、某页的几何与文本、某页在给定 scale 下的 canvas。
它不决定"渲染哪一页"（属 M06），不绘制任何 UI（属 M07），不读本地文件（字节只经 `pdf://` 协议，见 02 §3 第 109 行）。它同时是 D03（Rust 侧第二套文本提取实现）对齐的参照物（02 §11 第 293 行）。

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

交付一个 `src/pdf-engine/` 目录：其他模块只能经由 `src/pdf-engine/index.ts` 拿到 `DocumentHandle` / `PageHandle`，且该目录之外 grep 不到任何 `pdfjs-dist` 引用。

分解目标：

1. `openDocument({ url, docId })` 能打开 `pdf://doc/{id}?v=...`（不自己读文件、不传 `data` 字节）。
2. `DocumentHandle` 五个成员全部可用，`dispose()` 幂等（连调 2 次只 `destroy` 1 次，次数可观测）。
3. `PageHandle.render()` 返回可取消的 `RenderTaskHandle`：`cancel()` 后 promise 以 `E_CANCELED` 结束，且不产生未捕获拒绝。
4. `getTextContent()` 的 `text`/`items`/`itemStarts` 三者严格自洽（契约 R1：item 间无分隔符、行间单个 `'\n'`；`itemStarts` 可 slice 回原文），供 M08 做命中→矩形映射。
5. `getOutline()` 把 pdfjs dest 解析成 `pageNo: number | null`；解析失败不抛错、不拿 1 兜底。
6. 三类 pdfjs 异常归一化为 `E_PDF_CORRUPT` / `E_PDF_ENCRYPTED` / `E_PDF_NO_TEXT`（映射表见 §4.7）。
7. V-01 结论落成适配层：`src/pdf-engine/adapter/` 之外不出现 pdfjs 类型。

## 4. 功能范围（必须完成）

### 4.1 PdfEngine.openDocument

1. 签名严格按 `docs/05-api-contracts.md` §7 第 253–255 行：`openDocument(src: { url: string; docId: number }): Promise<DocumentHandle>`。
2. 实现路径：用 pdfjs 的 `getDocument({ url })` 得到 loading task，await 其 promise 得到文档代理。**禁止**传 `data: Uint8Array`（字节只经 `pdf://` + Range，02 §3 第 109 行）；**禁止**在 engine 内做任何 `fetch`。
3. 除 `url` 外的 pdfjs 加载参数：一律不填。只有在 V-01 抄录中确认存在、且 V-07 测出问题的参数才允许加，并在报告 §5 记录"参数名 + 证据 + 效果"。
4. 打开失败必须 reject 一个 `ApiError` 形状的错误（形态见 §4.7），**不得**把 pdfjs 异常对象抛给调用方。

### 4.2 DocumentHandle

5. `readonly docId`：等于入参 `docId`，不被 pdfjs 覆盖。
6. `readonly pageCount`：文档就绪后一次性读取并冻结为常量（不是每次访问都问 pdfjs）。
7. `getPage(pageNo)`：1-based；`pageNo < 1 || pageNo > pageCount` → reject `E_INVALID_ARG`（05 §1 第 46 行）；命中 §4.4 缓存直接返回同一个 `PageHandle` 实例；未命中则取页并包成 `PageHandle`。
8. `getOutline()`：失败、返回 `null` 或结构异常一律返回 `[]`（05 §7 第 261 行），叶子节点 `children` 为 `[]`，不得为 `undefined`。
9. `getMetadata()`：字段缺失 → `null`（05 §7 第 262 行）；`creationDate` 原样转字符串（若是日期对象用 `toISOString()`），不猜、不本地化、不补默认值。
10. `dispose()`：幂等。首次执行顺序固定为「取消全部活动 renderTask → 清 `PageProxy` 缓存 → 销毁文档代理」；进入 disposing 后所有方法立即 reject `E_CANCELED`（**不得**抛非 `ApiError`）。内部维护 `destroyCallCount` 计数，测试可读。

### 4.3 PageHandle

11. `readonly pageNo`、`readonly geometry: PageGeometry`（`widthPt / heightPt / rotation`，05 §7 第 273 行）。宽高取 **scale=1** 的未缩放值，单位为 PDF point；`rotation` 归一化到 `0 | 90 | 180 | 270`，遇到其它值取最近的 90 倍数并 `console.warn` 一条带 `docId/pageNo`。
12. `getTextContent()`：惰性取值 + LRU（§4.5）。同一页重复调用必须返回**同一对象引用**（便于 M08/M06 做身份比较）。
13. `render(req)`：**同步返回** `RenderTaskHandle`（05 §7 第 270、281–284 行），内部异步执行。canvas 由 engine 用 `document.createElement("canvas")` 创建：像素宽高 = `floor(viewport.width * req.scale * devicePixelRatio)` 与同法高度；`scale × dpr` 的乘法**只在此处做一次**（05 §7 第 276–277 行注释）。
14. engine 不设置 canvas 的 `style`（CSS 尺寸由 M06/M07 决定）；resolve 后不得继续持有该 canvas 引用。
15. `req.backgroundColor` 透传给 pdfjs；`req.clipBox` 若该版本 render 参数不支持，则降级为整页渲染并在报告标注「clipBox 未生效」——**不得**用 crop 后手工拼接像素冒充。
16. 取消语义：`cancel()` 立即调用底层 renderTask 的 cancel；对底层 promise 预先挂一个 `.catch(() => {})` 吞掉 pdfjs 的"渲染取消"异常，再由 engine 自己的 promise reject `{ code: "E_CANCELED", retriable: false }`。取消不是错误，不 `console.error`（`console.debug` 一次即可）。

### 4.4 PageProxy 缓存

17. LRU，键为 `pageNo`，上限 `pageCacheLimit`（默认 10，常量放 `src/pdf-engine/config.ts`，测试可直接改）。命中即置 MRU。
18. 淘汰时**不**调用任何 page 级 cleanup：连调 `destroy` 未到，资源仍属文档；是否需要在淘汰时 cleanup 必须由 V-07 内存测量结论决定，未测前保持不调用并在报告写明「未验证」。
19. 缓存不得跨文档存活：`dispose()` 清空。

### 4.5 TextContentHandle

20. `items: TextItem[]`，字段名以 `docs/05-api-contracts.md` §7 第 291 行为准：`str / x / y / width / height / fontSize`。（`docs/03-module-boundaries.md` §M05 第 81 行写作 `w,h`，与 05 冲突，按 05 实现并在报告 §9 记为契约问题。）
21. 坐标系：**以该页 scale=1 视口左上角为原点、y 轴向下**，单位与 point 等值。由 pdfjs item 的 `transform` 换算，起始公式：`x = t[4]`、`yTop = viewportHeightPt - (t[5] + t[3])`、`width = item.width`、`height = item.height`、`fontSize = sqrt(t[2]^2 + t[3]^2)`。该公式**必须**用一次性探针验证（把 5 个 item 的矩形描边画到同页 canvas 上目视比对文字位置），结论与偏差写进报告 §5；不通过则以实测值修正公式，不得留模糊描述。
22. `text` 构造规则（**契约 R1，已裁决，按此实现**）：item 之间**不插入任何分隔符**；**跨行处插入单个 `'\n'`**。换行判据必须确定性：`|y_i - y_prev| > fontSize_i * 0.5` 视为换行（y 为行顶，坐标系见第 21 条）。不得用「任何空白差异都换行」这类模糊判据，否则 M08 的跨行高亮不可复现。
23. 必须输出 `itemStarts: number[]`（与 `items` 等长，`text.slice(itemStarts[i], itemStarts[i]+items[i].str.length) === items[i].str`）。这是 R1 新增的契约字段，M08 依它把命中区间映射回 TextItem。禁止省略该字段或用「消费方自己前缀和」的方式绕过。
24. 便捷封装 `getItemRanges(items)` 与之等价（内部由 `itemStarts` 派生），可导出给 M08 复用；但**契约字段是 `itemStarts`**，`getItemRanges` 只是糖，两者不一致时以 `itemStarts` 为准并视为缺陷。
24. 页内 items 为空：返回 `{ items: [], text: "" }`，**不抛错**（无文本页必须能正常进入 M06/M07 的渲染路径）。

### 4.6 OutlineNode 映射

25. 输出 `OutlineNode[]`（`{ title, pageNo, children }`，05 §7 第 293 行）。
26. `pageNo` 解析：dest → 目标 → 页索引 → +1 得到 1-based 页码；方法名以 V-01 抄录为准。任一步失败（命名目标未解析、索引越界、异常抛出）→ `pageNo: null` + 一条 `console.warn`（带 title）。**禁止**用 1 或 0 兜底。
27. `title` 原样保留（含空串），不生成"未命名"之类文案（文案属 UI 层）；递归深度上限 32，超限截断并 warn。
28. 排序与层级原样保留 pdfjs 顺序，不重排。

### 4.7 错误归一化映射表

29. engine 对外抛出的错误一律是 `ApiError` 形状（`code / message / detail / retriable`，05 §1 第 34–39 行）。

| 触发点 | pdfjs 侧现象（以 V-01 抄录的类名与 `name` 为准） | 归一化 code | retriable |
|---|---|---|---|
| `openDocument` | 结构损坏 / 无效交叉引用表 / 解析抛错 | `E_PDF_CORRUPT` | false |
| `openDocument` | 需要密码（`PasswordException` 一类） | `E_PDF_ENCRYPTED` | false |
| `openDocument` | URL 取不到字节（404/协议错误） | `E_IO` | true |
| `getPage` / `getTextContent` | 该页结构异常 | `E_PDF_CORRUPT`（detail 带 `docId/pageNo`） | false |
| `render` | 非取消原因的 reject | `E_PDF_CORRUPT`（detail 带页号与 scale） | false |
| `render` | 被 `cancel()` | `E_CANCELED` | false |
| 文档可打开但无可提取文本 | 见第 30 条 | `E_PDF_NO_TEXT` | false |

30. `E_PDF_NO_TEXT`（05 §1 第 53 行"可打开但无可提取文本"）的判定落点：engine 不因空 items 抛错（第 24 条），改为提供内部接口 `documentHasText(handle, samplePages?)`（默认采样第 1、2 页与中间 1 页，任一页 items 非空即 `true`）。返回 `false` 时由调用方（M07）展示"无文本"提示并携带 `code: "E_PDF_NO_TEXT"`。**不得**在 `openDocument` 里做全页扫描（会拖垮打开时间）。
31. 所有 `console.warn`/`console.error` 必须带 `{ docId, pageNo?, op }` 上下文；禁止空 catch。

### 4.8 适配层隔离（`adapter/`）

32. `src/pdf-engine/adapter/` 是全项目**唯一** `from "pdfjs-dist"` 出现处；其它文件只 import `adapter/pdfjs-adapter.ts` 暴露的 `PdfjsPort` 窄接口（§8）。
33. `adapter/pdfjs-types.ts` 只写"从该版本 d.ts 抄录的窄接口"，**不得** `export * from "pdfjs-dist"` 或 re-export 上游类型 —— 否则 pdfjs 类型会顺依赖图泄漏到 L3/L4。
34. 便于测试：`PdfjsPort` 可注入 fake，因此 §12 的绝大多数用例不需要真实 PDF 文件；真实 PDF 只用于 §13 的 3 个样本断言。
35. `package.json` 中 pdfjs-dist 写**精确版本**（无 `^`），版本号与 V-01 结论一起写进报告 §1。

## 5. 非目标（明确不做）

### 5.0 已由 Lead 裁决的技术参数（**不再询问，按此实现**）

**T12**（明细见 `docs/14-ui-decision-register.md` §1）：

1. **加密 PDF 不做密码框**：遇到需要密码的文件，`openDocument` 直接以 `E_PDF_ENCRYPTED` 失败，并给出契约文案（`docs/16-copy-deck.md §1`）。不得实现密码输入、不得尝试空密码重试后静默继续。
2. **旋转页按 PDF 自带 `rotation` 渲染**（`PageGeometry.rotation` 原样用于 `getViewport`），**不提供**手动旋转入口、不做旋转状态持久化。

1. **不决定渲染哪些页、不排优先级、不设并发上限**——那是 M06（03 §M06 第 86 行）。
2. **不画 UI**：不创建页面容器、不定位文本层、不定留白/背景/页码指示/工具栏。engine 只 createElement canvas 与（可选）把文本层挂进调用方给的容器。
3. **不读本地文件、不 fetch**：字节来源只有 `pdf://doc/{id}?v=`（05 §6 第 243 行）。
4. 不做注释层 / AnnotationLayer / 表单 / 签名 / 编辑（02 §11 D02 第 292 行、master_plan §3.2）。
5. 不做 OCR，不做无文本页的替代文本生成（D11）。
6. 不做页缩略图、不做页面旋转交互（只读返回 rotation）。
7. 不做全文检索匹配（M08）、不写索引（M09）、不读数据库。
8. 不缓存跨文档资源（无全局文档缓存）。
9. **不得自行确定视觉方案**：任何颜色、尺寸、间距、动效一律留 `TODO(ui-confirm)`，不得在 engine 里写死像素值或色值（`RenderRequest.backgroundColor` 由调用方传入，engine 默认传 `undefined`）。例外（**已由 D20 冻结，照此实现**）：TextLayer 文字**完全透明**（`color: transparent`）仅用于选择；层级 z 顺序为 canvas 0 < TextLayer 10 < 高亮层 20 < 阅读器界面 30，数值取自 `docs/15-theme-tokens.md` §5。

### 本模块的【待你确认】清单（不得自行决定，留 `TODO(ui-confirm)`）

1. 文本层实现路径（V-01 结论出来后二选一）：A 用 pdfjs 的 TextLayer 类直接挂载；B 自绘绝对定位 span 复用 `buildTextSpans()`。**推荐 A**（少一套自研排版与选择精度维护），若 A 在该版本无稳定签名或选择复制验证不通过则回退 B。
2. canvas 的默认背景（`backgroundColor` 缺省值）：穿 `undefined` 让 pdfjs 用其默认，还是显式白色/纸色——涉及主题观感，需你拍板。
3. 文本层容器的层级与透明色是否由 engine 提供默认值：本 Prompt 建议 engine 完全不管，交 M07；若你希望 engine 提供一个"可用的默认文本层样式"，请确认。

## 6. 架构约束

- **允许依赖**：`src/contracts/*`（M02 的 `ApiError` 与类型）、`pdfjs-dist`（仅 `adapter/` 内）。
- **禁止依赖**：`src/render/**`、`src/reader/**`、`src/workspace/**`、`src-tauri/**`、任何 store（zustand）、任何 React（`react` / `react-dom` / `.tsx` 一律不出现在本模块）、任何 SQL/FTS 概念（02 §2 第 56–58 行）。
- **接口冻结**：`docs/05-api-contracts.md` §7 第 253–295 行的 7 个类型名与字段**一字不改**；本模块新增的内部接口必须在 §8 列出并在报告声明（03 §5 第 234 行）。
- **资源所有权**：`DocumentHandle` 由调用方（M14 打开、M07 持有引用）释放；engine 自己拥有的只有 `PageProxy` 缓存与适配层实例。`render` 产出的 canvas 在 promise resolve 时所有权转移给调用方，engine 不得再引用。
- **类型唯一出口**：`src/pdf-engine/index.ts` 是 L3/L4 唯一 import 路径；`index.ts` 只导出契约类型 + `createPdfEngine` + 明确列为跨模块内部接口的两个函数（`getItemRanges`、`documentHasText`、`buildTextSpans`）。
- **不负责清单**：渲染调度、UI 布局、搜索匹配、索引写入、文件读取、主题令牌。

## 7. 输入与输出

| 输入来源 | 数据形态 | 触发时机 |
|---|---|---|
| M07/M14（经 `document_url` 命令，05 §3 第 180 行） | `{ url: string; docId: number }` | 用户打开文献 |
| M06 | `RenderRequest { scale, backgroundColor?, clipBox? }` | 视口变化 / 页进入预取窗口 |
| M06/M08 | `getPage(pageNo)` / `getTextContent()` 调用 | 需要某页几何、文本或高亮坐标 |
| V-01 探针结论 | 文字记录（d.ts 抄录） | 开工第一步，先于任何编码 |

| 输出目标 | 数据形态 | 消费方 |
|---|---|---|
| M06 | `DocumentHandle` / `PageHandle` / `RenderTaskHandle` | 渲染调度 |
| M06 | canvas（经 `RenderTaskHandle.promise`） | 位图缓存与挂载 |
| M07 | `PageGeometry`、`PdfMetadata`、`OutlineNode[]` | 布局占位、目录面板 |
| M08 | `TextContentHandle.text` / `itemStarts`（契约 R1）+ `getItemRanges()` | 子串匹配与命中矩形 |
| M07 | `buildTextSpans()` 结果 | 自绘文本层（仅路径 B） |

## 8. 接口契约

**契约内（必须逐字实现，见 `docs/05-api-contracts.md` §7）**：

| 类型 | 行号 | 说明 |
|---|---|---|
| `PdfEngine` | 253–255 | 仅 `openDocument` 一个方法 |
| `DocumentHandle` | 257–264 | `docId/pageCount/getPage/getOutline/getMetadata/dispose` |
| `PageHandle` | 266–271 | `pageNo/geometry/getTextContent/render` |
| `PageGeometry` | 273 | `widthPt/heightPt/rotation` |
| `RenderRequest` | 275–279 | `scale/backgroundColor?/clipBox?` |
| `RenderTaskHandle` | 281–284 | `promise/cancel` |
| `TextContentHandle` | 286–289 | `items/text` |
| `TextItem` | 291 | `str/x/y/width/height/fontSize` |
| `OutlineNode` | 293 | `title/pageNo/children` |
| `PdfMetadata` | 294–295 | 6 个可空字符串字段 |
| `ApiError` / `ApiErrorCode` | 34–39 / 19–23（TS 29–32） | 错误形状与码值 |
| `DocumentSourceDto` | 103 | 上游 `url` 的来源 |

**模块新增内部接口（契约未定义，需在报告 §8 声明）**：

```ts
// src/pdf-engine/factory.ts
export function createPdfEngine(opts?: PdfEngineOptions): PdfEngine;
export interface PdfEngineOptions { pageCacheLimit?: number }

// src/pdf-engine/text-content.ts
export interface ItemRange { index: number; start: number; end: number }
export function getItemRanges(items: TextItem[]): ItemRange[];   // 由 itemStarts 派生的便捷封装；契约字段是 itemStarts

// src/pdf-engine/text-probe.ts
export function documentHasText(
  handle: DocumentHandle,
  samplePages?: number[]
): Promise<boolean>;

// src/pdf-engine/adapter/pdfjs-adapter.ts（窄接口，测试注入用）
export interface PdfjsPort {
  loadDocument(url: string): Promise<PdfjsDoc>;
  createCanvas(w: number, h: number): HTMLCanvasElement;
  readonly devicePixelRatio: number;
}

// src/pdf-engine/adapter/text-layer-adapter.ts（V-01 决定返回值是否为 null）
export interface PdfTextLayerFactory {
  attach(container: HTMLElement, content: TextContentHandle,
         viewport: { width: number; height: number }, scale: number): () => void;
}
export interface TextSpanBox { str: string; left: number; top: number;
  width: number; height: number; fontSize: number }
export function buildTextSpans(items: TextItem[], scale: number): TextSpanBox[];
```

## 9. 数据结构

- `PageGeometry { widthPt: number; heightPt: number; rotation: 0|90|180|270 }`：scale=1、单位 pt；M06 用 `heightPt × scale` 算布局高度，M07 用它算占位高度（同一公式，不得各自实现第二份）。
- `TextItem { str; x; y; width; height; fontSize }`：见 §4.5 第 20–21 条；坐标原点左上、y 向下。
- `TextContentHandle { items: TextItem[]; text: string }`：`text === items.map(i => i.str).join("")`（可断言）。
- `OutlineNode`：树，`children` 永不为 `undefined`。
- `PdfMetadata`：7 个字段（`title/author/subject/keywords/producer/creator/creationDate`），全部 `string | null`。
- 内部：`PageCacheEntry { pageNo, handle, lastUsed }`；`RenderJobRecord { pageNo, scale, task, startedAt, canvas }`；`EngineStats { destroyCallCount, activeRenderTasks, pageCacheSize }`（`getEngineStats()` 仅供测试与日志，不导出到 L3）。
- **契约问题（需在报告 §9 记录）**：`docs/03-module-boundaries.md` §M05 第 81 行把 TextItem 写成 `{ str, x, y, w, h, fontSize }`，`docs/05-api-contracts.md` §7 第 291 行是 `width/height`。以 05 为准；建议 Lead 修 03 的笔误。

## 10. 文件组织

```text
src/pdf-engine/
  index.ts                  # L3/L4 唯一出口：契约类型 + createPdfEngine + 3 个跨模块内部函数
  factory.ts                # createPdfEngine，装配 adapter 与缓存上限
  engine.ts                 # openDocument 实现与错误归一化入口
  document-handle.ts        # DocumentHandle 五成员，dispose 幂等与 destroy 计数
  page-handle.ts            # PageHandle：geometry / getTextContent / render(cancel)
  page-cache.ts             # PageProxy LRU（纯逻辑，可单测）
  text-content.ts           # items→text（item 间无分隔符、行间 '\n'）+ itemStarts + getItemRanges
  text-probe.ts             # documentHasText 采样判定
  outline.ts                # OutlineNode 映射与 pageNo 解析（失败 → null）
  metadata.ts               # getMetadata 字段收敛（缺失 → null）
  errors.ts                 # pdfjs 现象 → ApiError 映射表（唯一实现）
  config.ts                 # pageCacheLimit 等常量
  adapter/
    pdfjs-adapter.ts        # 唯一持有 pdfjs 实例的文件，实现 PdfjsPort
    pdfjs-types.ts          # 从 d.ts 抄录的窄接口（不 re-export 上游类型）
    text-layer-adapter.ts   # V-01 结论落地：路径 A 工厂 / 路径 B 纯数据 span
    PDFJS-ADAPTER-NOTES.md  # V-01 抄录原文与判定结论（必须提交）
  __tests__/
    fake-pdfjs-port.ts        # 可编程 fake：页数、异常、慢渲染、取消
    document-lifecycle.test.ts
    errors.test.ts
    text-content.test.ts
    outline.test.ts
    render-cancel.test.ts
```

## 11. 实施步骤

1. **V-01 门禁（先于任何编码）**：在目标版本上执行并抄录，写进 `adapter/PDFJS-ADAPTER-NOTES.md`：
   - `node -p "require('pdfjs-dist/package.json').version"`（记录精确版本）
   - `Select-String -Path node_modules/pdfjs-dist/types/src/display/api.d.ts -Pattern "getDocument|numPages|getTextContent|getOutline|getMetadata|cleanup|getPageIndex|getDestination" -Context 0,4`
   - `Select-String -Path node_modules/pdfjs-dist/types/src/display/text_layer.d.ts -Pattern "class TextLayer|constructor|interface TextLayerParameters|renderTextLayer" -Context 2,10`
   判据：若存在可实例化的 TextLayer 类且构造参数能提供 container + 文本内容 + viewport → **路径 A**；若该类缺失或签名与容器/文本不匹配 → **路径 B**（自绘绝对定位 span，用 `buildTextSpans()`）。
   回退条件（写进 NOTES）：A 在版本升级后签名变化、或 A 下"选中并复制到的文本"与 `TextContentHandle.text` 不一致超过人工可接受范围 → 回退 B，并在报告记录差异样本。
   落点：NOTES 文件存在，含版本号、两类签名原文、判定结论与回退条件；此时尚未写任何 engine 代码。
2. 落 `types.ts` + `index.ts`：把 05 §7 第 253–321 行**全部**类型落成编译通过的 `types.ts`（含 `PageState/PageRenderState/ViewportState/RenderBudget/RenderScheduler`，理由见 05 §7 第 252 行把它们放在同一文件）；`npx tsc --noEmit` 通过。
3. 落 `adapter/pdfjs-adapter.ts` + `fake-pdfjs-port.ts`：`document-lifecycle.test.ts` 用 fake 跑通"打开→getPage→dispose→再打开"，断言 destroy 次数与缓存清空。
4. 落 `page-handle.ts` 与 `render-cancel.test.ts`：fake 的 render 返回可控 task，断言 `cancel()` 后 promise reject 码为 `E_CANCELED`、无 unhandledRejection。
5. 落 `text-content.ts` + `outline.ts` + `text-probe.ts`：`text-content.test.ts` 断言「item 间无分隔符、行间单个 '\n'」与 `itemStarts` 的 slice 可逆性（对 20 个随机 item 序列）；`outline.test.ts` 断言解析失败得到 `null`。
6. 落 `errors.ts` 与真实样本冒烟：3 个真实 PDF（正常 / 损坏 / 加密或扫描件）各跑一次打开，打印归一化 code。
7. 路径 A/B 实现 `text-layer-adapter.ts`（按步骤 1 结论只实现被选中的那条，另一条留函数骨架 + `TODO(ui-confirm)`，并在报告说明未实现原因）。

## 12. 测试要求

**命令**：`npx vitest run src/pdf-engine`（TS）；`npx tsc --noEmit`（类型门禁）。本模块无 Rust 代码。

单元（fake `PdfjsPort`，不需要 PDF 文件）：

- 正常路径：openDocument → pageCount 正确 → getPage(1) 返回几何 → dispose → 再次 openDocument 成功。
- dispose 幂等：连调 3 次 `dispose()`，`destroyCallCount === 1`；dispose 后 `getPage(1)` reject `E_CANCELED`。
- 边界：`getPage(0)` / `getPage(pageCount + 1)` → `E_INVALID_ARG`；1 页文档 `getPage(1)` 正常。
- 边界：空 items 页 `getTextContent()` 返回 `{ items: [], text: "" }` 且不抛错。
- 边界：outline `dest` 非法 / 越界 / 抛异常三种输入 → `pageNo: null`，不抛错。
- 错误路径：打开抛"需要密码"类异常 → `E_PDF_ENCRYPTED`；打开抛结构异常 → `E_PDF_CORRUPT`。
- 错误路径：render 中途 cancel → `E_CANCELED`；测试进程内 `unhandledRejection` 计数为 0。
- 对齐（R1）：`itemStarts.length === items.length`；每个 `i` 满足 `text.slice(itemStarts[i], itemStarts[i] + items[i].str.length) === items[i].str`；`itemStarts` 严格递增；插入的 `'\n'` 只出现在换行判据成立处。

集成（3 个真实样本，路径 `fixtures/pdf/{ok,corrupt,no-text}.pdf`；样本缺失时本条标「未验证」）：

- 3 份样本的 `pageCount` 与注入 `PdfjsPort` 直接读到的页数逐一致。
- 损坏样本 → `E_PDF_CORRUPT`，进程无崩溃、无未捕获异常。
- 样本首页 `getTextContent()` 的 item 矩形与页面文字肉眼对齐（探针脚本把矩形描到 canvas 上，一页一图）。

## 13. 验收标准

1. `npx vitest run src/pdf-engine` 全绿；`npx tsc --noEmit` 无错。
2. §12 的 8 条单元用例每条有对应 test 名，`--reporter=verbose` 输出可见。
3. 生命周期无泄漏：打开 / 连关 3 次 / 换文档共 6 次操作后，`getEngineStats()` 返回 `{ destroyCallCount: 6, activeRenderTasks: 0, pageCacheSize: 0 }`。
4. 损坏 PDF：`openDocument` reject，`error.code === "E_PDF_CORRUPT"`；同一测试内 `process.on("unhandledRejection")` 计数为 0。
5. `getTextContent()`：`text.length === sum(items[i].str.length)` 且等值断言通过（3 个样本各一页）。
6. `render().cancel()` 后 promise reject 码为 `E_CANCELED`，且 100ms 内无 `console.error`（用 spy 断言）。
7. 3 个样本的 `pageCount` 与 pdfjs 自身读到的页数一致（同一测试内两路取值对比）。
8. 隔离性：`grep -rn "pdfjs-dist" src` 的命中行**全部**位于 `src/pdf-engine/adapter/` 内（附命令输出）。
9. `adapter/PDFJS-ADAPTER-NOTES.md` 存在，含版本号、两类签名抄录、路径判定与回退条件。
10. 本模块目录内 `grep -rn "react\|zustand\|\.tsx"` 无命中（除 NOTES 里的说明文字）。

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

1. **不得**在 `src/pdf-engine/adapter/` 之外 import `pdfjs-dist`（含"只 import 类型"）。
2. **不得**在 `openDocument` 里传 `data: Uint8Array` 或自己 `fetch` 字节 —— 那等于绕开 `pdf://` + Range（D01）。
3. **不得**在 engine 内决定渲染页集合、并发数、优先级或是否预取（M06 职责）。
4. **不得**在 engine 内写任何像素/色值默认样式（`TODO(ui-confirm)` 处理），也不得创建页面容器或布局 DOM。
5. **不得**把 pdfjs 的异常对象、`name` 字符串或堆栈直接抛/透给调用方；必须经 §4.7 映射表。
6. **不得**为让 outline 好看而把解析失败的 `pageNo` 兜底成 1 或 0。
7. **不得**用"重试 N 次"掩盖损坏 PDF：`E_PDF_CORRUPT` 直接失败，不重试。
