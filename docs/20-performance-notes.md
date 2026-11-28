# 20 · 打开速度（性能）记录

> 用户反馈：「书籍打开的时候速度很慢」。本文记录**已定位的原因**与**已做的优化**，以及下一步该测什么。

## 1. 已定位的三个原因

### 1.1 打开时串行解析全部页面几何（已修）

原实现：`for p in 1..=pageCount { await handle.getPage(p) }`，全部拿到才开始渲染。
300 页的 PDF = 300 次 `getPage` 串行，首屏要等全部完成。

**现在**：拿到第 1 页几何立即渲染首屏，其余按 20 页一批渐进补齐（`GEO_BATCH`）。

### 1.2 每个页槽都挂文本层（已修）

原实现：所有页槽挂载时各自 `getTextContent()`。300 页 = 打开瞬间 300 次文本提取 + 数百个 span。

**现在**：只有「当前页 ±2」挂文本层（`mountText`），滚出窗口即卸载并释放文本内容。

**随之而来的两个选择语义（v0.13 补）**：① 选区还落在这页的文本层里时不卸载，等
`selectionchange` 散开再卸 —— 否则拖选中途滚动会把选区连节点一起抽走，复制结果为空；
② 空层闸门改用「有可见字符的 item」而不是 `items.length` —— 扫描页与字体缺 Unicode
映射的页（pdfjs 只给出空串 item）不再挂一层透明、吃指针事件却选不出东西的容器。

### 1.3 渲染预算偏保守（已调）

`maxConcurrent` 2 → 3（首屏两页几乎同时到位）；`prefetchPages` 2 → 1（大文档不抢解析带宽）。

## 2. 尚未优化（下一步按实测决定）

| 候选 | 说明 | 预估收益 |
|---|---|---|
| 页几何按需（不预取全量） | 用第 1 页几何推算其余页高度，滚动到再校正 | 大文档打开几乎瞬时 |
| 文本层按需（滚动到才挂） | 现在已是 ±2 页，可收窄到 ±1 | 少量 |
| `pdf://` 直接 `mmap`/零拷贝 | 现在每次请求 `read_span` 开一次文件 | 中等 |
| 索引与阅读的 IO 竞争 | 索引任务与阅读同时读盘时，降索引并发 | 中等 |

## 3. 如何测量（下次给数据）

在 `ReaderView` 打开流程里打点：

```ts
const t0 = performance.now();
// openDocument / 第一页几何 / 首帧 canvas ready 各打一次
console.log("[open] url", t1 - t0, "first-geo", t2 - t1, "first-canvas", t3 - t2);
```

或在 Rust 侧看 `pdf:// 响应` 日志的 `elapsed`。
## 4. v0.13：已落地与量测

### 4.1 已落地（对应本文 §1-§3 的旧问题与上一轮调查报告）

| 项 | 位置 | 结论 |
|---|---|---|
| P0-1 调度准入与去重 | `src/render/scheduler.ts`（`inFlight` 占位 + `scheduleVersion`） | 并发上限现在覆盖 `getPage`/取文本阶段；同一页在在飞期间不会被第二次启动，句柄不再被覆盖（旧的 RenderTask 从此可取消） |
| P0-2 滚动 rAF 节流 + 几何去全量重算 | `src/reader/ReaderView.tsx`（`flush`）、`src/render/layout.ts`、`scheduler.ensureBoxes` | 每个 scroll 事件只记位置，计算与调度合并到下一帧；页盒子按「几何数组身份 + scale」缓存，滚动路径 O(1)；状态没变就不发订阅回调 |
| P0-3 文本缓存共用 | `scheduler.getTextContent/prefetchText`、`ReaderView` 的搜索与 `PageSlot` | 文本提取只剩一条路径，渲染/文本层/搜索共用同一份 LRU；切文档时代号校验防止旧书文本写进新书缓存 |
| P1-1 rangeChunkSize | `src/pdf-engine/engine.ts` | 64 KiB → 4 MiB（≤ RANGE_MAX_BYTES 8 MiB），见 §4.2-B |
| P1-2 pdf:// 句柄 + 最近段缓存 | `src-tauri/src/protocol/cache.rs`、`lib.rs` 协议处理器 | 句柄 ≤4 本、段 ≤16 MiB（单段 ≤8 MiB），`(size, mtime)` 指纹不符即重开 |
| P1-3 优先级打分 + 跳页保护 | `src/render/layout.ts`（`pageScore`）、`scheduler.pump` | 补上滚动方向偏好与缩放失配（docs/08 §3 公式与算例已在 `priority.test.ts` 复现）；`last-first > 30` 时跳过预取 |
| P2-1 空闲文本预取 | `src/render/idle-prefetch.ts` + 阅读菜单开关 | **默认关闭**；独立预算（每次空闲 ≤2 页、并发 1），只预取文本 |
| P2-2 阅读让位 | `src/reader/index-yield.ts` | 连续交互 >150ms → `index_pause {paused:true}`，空闲 1.5s 恢复；离开阅读器必定恢复 |

### 4.2 量测数据

测量脚本：`node scripts/bench/run.mjs`（`scripts/bench/`，产物写 `.tmp/bench/results.json`）。
样本：300 页 / 9600 行 / 830,775 字符 / 10,723,520 B。

**A. 文内搜索的文本提取成本**（等价模型测量：脚本内分别建模「旧路径 = 每次搜索全量重提取」与「新路径 = 字节预算 LRU」，不调用 `src/render` 的代码）

| 路径 | 说明 | 中位耗时 |
|---|---|---|
| 旧·首轮 | 300 页全量 `getPage` + `getTextContent` | 667.5 ms |
| 旧·二轮 | 同上（第 2 次搜索仍全量重提取） | 583.7 ms |
| 新·首轮 | 全量提取 + 写入 64 MiB 字节预算 LRU | 628.9 ms |
| 新·二轮 | 全部命中，不再调用 `getTextContent` | 1.2 ms |

每页匹配本身 4.13 ms/轮。把匹配成本加回两侧：**第二次同类搜索 587.8 ms → 5.3 ms（约 111×）**；
首次搜索成本不变（同一份提取只做一次，测得差异在噪声内）。旧实现浪费的正是「第二次及以后」。

**B. rangeChunkSize**（本地 Range 服务器，8 MiB/响应上限）

| 配置 | 请求数 | 总字节 | 首屏 |
|---|---|---|---|
| 64 KiB（默认） | 157 | 20,922,752（195.1%） | 229.2 ms |
| 4 MiB | 4 | 21,447,040（200.0%） | 160.1 ms |

隔离到纯 range 路径：165 请求 / 11,116,736 B / 248.5 ms → 4 请求 / 11,116,736 B / 141.2 ms。
两条结构事实（决定了这个值的适用范围）：① pdf.js 首个请求是**无 Range 的整文件 GET**（`pdf.mjs:13481-13502`），Range 能力在首个响应后才推断，所以 8 MiB 上限不约束首次传输；② 进入 range 路径的门槛是 `contentLength > 2 × rangeChunkSize`（`pdf.mjs:13391`）——4 MiB 只对 >8 MiB 的文档生效。

**C. disableAutoFetch**（打开后 3 秒窗口）

| 配置 | 请求数 | 传输字节 | 首屏 |
|---|---|---|---|
| `false`（当前默认） | 155 | 20,791,680（193.9%） | 264.3 ms |
| `true` + `disableStream: true` | 165 | 11,051,200（103.1%） | 324.1 ms |

**结论：不启用。** 它省的是「重复的那一份」（11.05 MB ≈ 样本整文件本身），挡不住首个整文件 GET；代价是首屏 +22.6%、请求数 +6%。
B/C 的请求数与字节两次整跑偏差 ≤1.3%；耗时列 ±20%（测量期间宿主 CPU 100%，同配置三次重复本身 ±5%）。

### 4.3 打包（本机）

`pnpm tauri build` 在 Windows 上会分别调 NSIS 与 WiX 3.14 出安装包（NSIS → `*-setup.exe`，WiX → `*.msi`）。
工具链缓存在 `%LOCALAPPDATA%\tauri\{NSIS,WixTools314}`：NSIS 已在本机可用；WiX 首次由 tauri 自己下载，
在慢网下会以 `timeout: global` 失败，此时先用浏览器/Invoke-WebRequest 取
`wix314-binaries.zip` 解压到 `%LOCALAPPDATA%\tauri\WixTools314`（需 `candle.exe` 在根部）再重试即可离线打包。

## 5. P2-3 评估结论：把渲染搬出主线程（本轮**不落地**）

结论：**不做**。不是做不到，而是「收益未量化 + 契约会破」两条都还没解决。

### 5.1 现状（代码事实）
- 解析已经在独立线程：`src/pdf-engine/engine.ts:18-20` 用 Vite 的 `?url` 导入 `pdf.worker.min.mjs` 并设置 `GlobalWorkerOptions.workerSrc`。
- 渲染仍在主线程：`PageHandleImpl.render()` 在主线程 `document.createElement("canvas")`（`engine.ts:121`）、取 2D 上下文（`:130`）、`page.render({ canvasContext, viewport, canvas })`（`:135`）。
- pdfjs 6 确有 worker 侧渲染通道：`class RendererWorker`（`node_modules/pdfjs-dist/build/pdf.mjs:15492`），但 `isAvailable` 要求设置 `GlobalWorkerOptions.rendererSrc`（`pdf.mjs:15526-15527`）——本项目从未设置。

### 5.2 落地的代价（逐条对应代码）
1. **契约变更**：`RenderTaskHandle.promise` 承诺 `Promise<HTMLCanvasElement>`（`src/pdf-engine/types.ts:46-49`，docs/05 §7）。worker 渲染回来的是帧 / `ImageBitmap`，改类型会波及至少三处：
   - `scheduler.canvasCache` 存 `{ canvas, scale }`（`src/render/scheduler.ts:61`）与逐出时的 `patch(pageNo, { canvas: null })`（`scheduler.ts:371-380`）；
   - 字节记账 `canvasBytes()` 按 canvas 像素尺寸估算（`src/render/layout.ts:193`，调用点 `scheduler.ts:327`）；
   - React 挂载点 `CanvasHost` 直接 `host.appendChild(canvas)`（`src/reader/ReaderView.tsx:1112-1117`）。
2. **收益未量化**：docs/08 §4 的「单页 12–40ms」自标为待固化估算；docs/08 §11 的 longtask 观测脚本在本仓库还没跑过（本文 §3 记录「打点数据还没收集」）。

### 5.3 满足这些前置条件后再评估
1. 用 300 页 / 100MB 真实样本按 docs/08 §11 采 `longtask` 与滚动帧率；
2. 若渲染在 longtask 中占比 < 30%，直接放弃（瓶颈在布局/合成而不是栅格化）；
3. 真要动，先只改 `RenderTaskHandle` 的返回契约并在 docs/05 §13 登记 R 记录，再改 scheduler 与 ReaderView —— 三处不要同时改。

## 6. 本轮未做项（诚实清单）

| 项 | 状态 | 原因 / 前置条件 |
|---|---|---|
| 位图空闲预取 | 未做（只做文本） | 一页位图 17.2–30.6 MiB（docs/08 §5 第 110-124 行），会直接吃掉 `cacheBytes` 的约 14 页额度，把「可见页被逐出」的风险推高；文本预取的单页成本 ≈183 KB（§6 第 143 行），风险低两个数量级。理由写在 `src/render/idle-prefetch.ts` 头注释。 |
| 文档常驻预加载（P2-2 的产品部分） | 占位 | 产品参数未定（常驻几本 / 内存上限）。`src/settings/perf-prefs.ts` 的 `PRELOAD_DOC_MAX_LIMIT = 0` 使解析恒为 0；阅读菜单显示「未启用」并标注 (待补充)。落地前还要明确 `setDocument` 的释放语义（docs/05 §13 R4）。 |
| 渲染移出主线程（P2-3） | 未做 | 见 §5。 |
| `pdf://` 路径复用的残余风险 | 已记录 | 缓存按 `document_id` 复用路径，命中条件是 `(size, mtime)` 一致（`src-tauri/src/protocol/cache.rs:140-170`）。若库扫描把该记录改指向「另一个仍存在、且 size/mtime 恰好相同」的文件，本次不会察觉。可选收敛：命中路径上加 30s TTL 的一次查库复核（会摊薄「不查库」的收益）。 |

## 7. 阅读器图块与连续搜索实测

文本缓存按 64 MiB 的估算预算在写入时淘汰，计入拼接文本、各文本项字符串、坐标及偏移数组。页渲染状态仅持有位图，可见文本层和活跃选区在需要时持有文本。绘制任务直接查询位图缓存，文本提取由选择、搜索和预取共用。

在设备像素下，面积不超过 1024²、最长边不超过 2048 的页面使用单块。更大的页面按 1024 × 1024 栅格直接绘制，先请求与视口相交的块，再预取一圈。新比例尚未覆盖的可见区域可显示旧比例位图。位图预算为 256 MiB，当前可见图块和仍在补图的可见区域所需旧图块受保护。

运行 `node scripts/bench/search.mjs` 可复测。基准使用项目生成的 300 页中英文 PDF、PDF.js 文本提取、正式调度器的文本缓存和正式文内搜索函数。每个配置重新打开文档，顺序搜索三个词，六轮交替 A/B 顺序。表中是每词完整扫描的中位毫秒数，未计入窗口绘制。两种配置逐页核对命中区间与摘要。

| 查询 | 命中数 | 仅原文缓存 | 同时缓存规范化文本 |
|---|---:|---:|---:|
| viewport | 1136 | 1552 | 1453 |
| cache | 1182 | 159 | 2 |
| range request | 15 | 158 | 1 |

保留每份打开文档独立的 8 MiB 轻量搜索缓存。该样本最终估算占用 1,755,750 字节。缓存保存规范化文本及原文偏移发生变化的位置；只有命中页需要原文生成摘要或定位。可复现的收益集中在换词后的查询。首轮同时包含 PDF.js 的惰性解析和文本提取。
