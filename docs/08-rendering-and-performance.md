# 08 · 渲染与性能（M06 Render Scheduler）

> 依据：02 §9 第 274 行（前端渲染并发默认 2）、02 §5 第 178 行（模式切换共享同一 `PDFDocumentProxy`）、03 §2 M06 卡第 84–93 行、05 §7 第 306–321 行（`ViewportState`/`RenderBudget`/`RenderScheduler`）。归属 `src/render/**`（03 §4 第 223 行）。
> 单位约定：`pt` = PDF point，`css` = 页面 CSS 像素，`dev` = 设备像素（`dev = css × dpr`）；`pageGeometries[i]` 对应第 `i+1` 页（05 第 309 行）。视觉数值一律不在本文档给值，见 §12。

## 1. 页几何与布局模型

```text
swap(i)   = rotation(i) % 180 !== 0                          # rotation 见 05 第 273 行
w_i       = (swap ? heightPt : widthPt) × scale
h_i       = (swap ? widthPt : heightPt) × scale
canvasW_i = ceil(w_i × dpr),  canvasH_i = ceil(h_i × dpr)     # 位图尺寸，进 §5 预算
```

**连续模式 top 偏移（前缀和，O(1) 查询）**：

```text
padding, pageGap  = 见 §12（视觉待确认）
H(1) = 0;  H(i) = H(i-1) + h_{i-1}^{scale=1}      # 只存 scale=1 的高度前缀和
top_i    = padding + (i-1) × pageGap + scale × H(i)
bottom_i = top_i + h_i
totalH   = 2 × padding + Σ h_i + (n-1) × pageGap
```

关键点：`H(i)` 以 **scale = 1** 存储，缩放时只换乘数、不重建数组 —— 缩放重排是 O(1) 公式替换，只有换文档才重算 `H`。

**缩放后重排**（`k = s'/s`）：`h_i' = k·h_i`，`top_i' = padding + (i-1)·pageGap + s'·H(i)`。即 `padding`/`pageGap` **不参与缩放**，只有页内容按 `k` 伸缩。单测须断言：`scale` 翻倍后相邻两页仍恰好相隔 `pageGap`（否则放大时页间距一起变大，产生视觉漂移）。

**单页模式居中**（只渲染第 `p` 页，容器仍可滚动以看长页）：

```text
offsetX = max(0, (viewportWidth  - w_p) / 2)
offsetY = max(0, (viewportHeight - h_p) / 2)        # h_p > viewportHeight 时取 0
totalH  = padding + h_p + padding;   top_p = padding + offsetY
```

**DOM 策略（避免重排）**：外层 `position:relative; height:totalH`；每页绝对定位 `top:0` 并用 `transform: translate3d(offsetX, top_i, 0)` 定位；尺寸变化只写 `width/height`。滚动路径上禁止读 `offsetTop/offsetHeight`（§8）。

## 2. 可见页计算（O(log n) 二分）

```text
# tops[]、bottoms[] 单调递增；ε 取 0.5px 防边界抖动
first = lowerBound(bottoms, scrollTop + ε)            # 第一页：底部越过视口顶
last  = upperBound(tops, scrollTop + vh - ε) - 1      # 最后一页：顶部未超视口底
visible = (first > last) ? ∅ : [first, last]           # ∅ = 视口落在 pageGap 空隙

lowerBound(a,x): lo=0,hi=len; while lo<hi { mid=(lo+hi)>>1; a[mid]<x ? lo=mid+1 : hi=mid } return lo
upperBound(a,x): 同上，条件改为 a[mid]<=x
```

复杂度：每帧两次二分，n = 1200 时约 22 次比较，可忽略；`tops/bottoms` 由 §1 公式按当前 scale 取值，不建数组。

**预取窗口**：`[first-k, last+k]` clamp 到 `[0,n-1]`，`k = RenderBudget.prefetchPages`（05 第 312 行），默认 2。**跳页保护**：若 `last-first > 30`（`goToPage` 或极小窗口），本轮只渲染 `visible`、跳过预取，下一帧稳定后补。

## 3. 优先级打分

```text
d_i    = |center_i − (scrollTop + vh/2)| / vh ,  center_i = top_i + h_i/2
dir_i  = 1 if (center_i − (scrollTop + vh/2)) × scrollSign > 0 else 0     # 在滚动方向前方
cur_i  = 1 if i == currentPage else 0
miss_i = |log2(cachedScale_i / scale)|        # 无缓存时取 missMax
score_i = w1·d_i − w2·dir_i − w3·cur_i + w4·miss_i                        # 越小越优先
```

| 权重 | 默认 | 含义 | 为什么是这个量级 |
|---|---|---|---|
| `w1` | 1.0 | 距离 | 基准项，`d` 已归一化 |
| `w2` | 0.5 | 方向偏好 | 半页提前量：让下一屏领先同距离的上一屏 |
| `w3` | 0.8 | 当前页 | 略小于一页距离：优先当前页但不压制「下一步要看的」 |
| `w4` | 2.0 | 缩放失配 | 重渲一页 12–40ms，远贵于布局距离差，故最大 |
| `missMax` | 3 | 无缓存替代值 | 等价 `log2(8)`：最坏失配也不压过当前页之外的强偏好 |

调参位置：`src/render/scheduler/priority.ts` 的单一常量 `PRIORITY_WEIGHTS`；改动必须同步本表与算例，单测只断言**排序结果**（`priority.test.ts`），不断言分数绝对值。

**算例**（`vh=800`，视口中心 400，`s=1.5`，向下滚动）：页 A 中心 100、缓存 1.0 → `0.375 + 2×0.585 = 1.545`；页 B 中心 700、缓存 1.5、在前方 → `0.375 − 0.5 = −0.125`；页 C 中心 1400、缓存 1.5、在前方 → `1.25 − 0.5 = 0.75`。排序 B ≺ C ≺ A：先补当前屏下方，再更下方，最后才重渲缩放失配的上方旧页。

## 4. 并发与取消

**并发默认 2**（02 §9 第 274 行）。依据：单页渲染主线程占用约 12–40ms（待 §11 埋点固化），2 并发可在 16.7ms 帧窗口外错峰；实测 `maxConcurrent=3` 时会出现主线程 longtask 连击。

**缩放期间降到 1**：缩放会连续触发 `setViewport`，2 个高分辨率 canvas 同时进合成队列＝单帧双倍像素上传 → 掉帧。降为 1 后每帧最多一个新位图。判据：缩放期间 rAF 间隔 p95 < 20ms。恢复：最后一次 `setViewport` 后 200ms 无新请求 → 回 2。

| 触发 | 动作 | 期望结果 |
|---|---|---|
| 页滚出 `visible ∪ prefetch` | `cancel()` | 回 `"idle"`；若已有旧位图则保留旧 `"ready"` 作为 LOD 预览 |
| `setViewport` 的 `scale` 变化 | 取消所有 scale 不匹配的 `"rendering"` | 不写 `error`，置 `"queued"` 重排 |
| `setDocument(null)` | 取消全部 | 队列清空，`getPageState` 无值 |
| 组件卸载 / `dispose()` | 取消全部 + 归还 canvas | 无残留 renderTask（05 第 320 行） |
| 逐出目标正在渲染中 | **不取消**，逐出跳过该页（§5） | 防「刚画好就扔」 |
| `goToPage` | 取消新窗口外全部 | 新窗口立即排队 |

**`renderTask.cancel()` 的已知异常**：取消后 `promise` 以「渲染已取消」类异常拒绝（类名/异常名待 V-01 抄录）。唯一正确形状：

```ts
task.promise.then(c => commit(pageNo, c))
  .catch((e: unknown) => {
    if (isRenderCancellation(e)) return restoreState(pageNo, "idle");   // 不写 error、不 console.error
    commit(pageNo, null, errorMap.toApiError(e));                        // 05 第 303 行 error 字段
  });
```

三条禁令：取消不得当失败写 `PageRenderState.error`；取消路径不得 `console.error`；`cancel` 后不得再向该 canvas 绘制（已分配的 canvas 归还池并标 `dirty`，复用前 `clearRect`）。

## 5. Canvas 缓存

```text
bytes_i = canvasW_i × canvasH_i × 4 = ceil(w_i×dpr) × ceil(h_i×dpr) × 4      # RGBA8
```

**三个典型页尺寸实算**（A4 = 595×842 pt）：

| 场景 | scale | dpr | 位图 | 字节 | ≈ MiB |
|---|---|---|---|---|---|
| 概览 | 1.0 | 1 | 595 × 842 | 595×842×4 = 2,003,960 | 1.91 |
| 常规阅读 | 1.5 | 2 | 1,785 × 2,526 | 1,785×2,526×4 = 18,035,640 | 17.20 |
| 高倍细读 | 2.0 | 2 | 2,380 × 3,368 | 2,380×3,368×4 = 32,063,360 | 30.58 |

**LRU 容量换算**（`RenderBudget.cacheBytes` 建议默认 268435456 = 256 MiB）：

| 单页 | 可存页数 | 实算 |
|---|---|---|
| 1.91 MiB | ≈ 134 | 268435456 / 2003960 = 133.9 |
| 17.20 MiB | ≈ 14 | 268435456 / 18035640 = 14.9 |
| 30.58 MiB | ≈ 8 | 268435456 / 32063360 = 8.4 |

结论：`cacheBytes` 必须按**字节**配置而非页数——同一份「20 页」配置在 1.0 与 2.0 缩放下相差 17 倍内存。

```text
protect = visible ∪ prefetch ∪ {状态为 "rendering" 或 "queued"}     # 当前可见页绝不逐出
while usedBytes > cacheBytes:
  cand = LRU 中 lastVisibleTs 最小的页
  if cand ∉ protect: evict(cand)   # 归还 canvas、通知 M05 清理该页（06 §6）、usedBytes -= bytes
  else: break                      # 只剩受保护页，记 warn 与 usedBytes 后放弃逐出
```

预算不足时的降级顺序：① 跳过预取 → ② 只保留 `visible` → ③ 若单页仍超预算，按 `min(scale, sqrt(cacheBytes/(w·h·dpr²·4)))` 降级渲染并 `console.warn`（记录需求字节与实际字节）。可见页被逐出＝白页闪烁，视为缺陷。选择/高亮只依赖 TextLayer（06 §2），故逐出 canvas 不破坏选中态。

## 6. TextContent 缓存

成本：每页 items 按中文论文 600–1500 条估，单 item ≈ 180 B（1 串 + 6 number，V8 粗估，须按 §11 堆快照校准 ±50%）；`text` 串按 04 §8 第 196 行取 1.5–4 KB/页。

```text
page_bytes ≈ 1000 × 180 B + 3 KB ≈ 183 KB
上限 200 页 → 200 × 183 KB ≈ 36.6 MB                 # 对应 §9 预算的 40MB 一格
```

上限默认 200 页，调参位置 `src/render/cache/text-content-lru.ts` 的 `MAX_TEXT_PAGES`。

**为什么与 canvas 分开淘汰**：canvas 因缩放频繁全量失效（§4），而 `TextContent` 在 scale=1 空间（06 §4）与缩放无关。共用 LRU 会让每次缩放连带丢文本，M08 的搜索/高亮反复重取——这是「搜索时卡」的典型成因。**失效条件仅两处**：`dispose()`，或 `setDocument` 收到不同 `docId`。

## 7. 缩放锚点稳定性

```text
输入: 旧 scale s、scrollTop S、鼠标视口内 vy、新 scale s'
1. 文档坐标      Y = S + vy
2. 页与页内比例   i = 满足 top_i ≤ Y < bottom_i 的页（§2 二分）;  r = (Y − top_i)/h_i
3. 新页顶        top_i' = padding + (i-1)×pageGap + s'×H(i)
4. 反解滚动      S' = top_i' + r × (s'/s) × h_i − vy
水平方向:        Sx' = (Sx + vx) × (s'/s) − vx        # 连续模式无水平间隙
```

无鼠标时 `vy = viewportHeight/2`、`vx = viewportWidth/2`；单页模式退化为保持 `(pageNo, r)`，`S' = r×h'−vy`。

**算例**：842pt 页、`padding=0, pageGap=0`（仅为算例简化）、`s=1, S=1000, vy=400` → `Y=1400` → `i=2`（覆盖 842–1684）、`r=0.6627`；`s'=1.5` → `top_2'=1263`、`S'=1263+0.6627×1263−400=1700.0`；用等价式 `Y×(s'/s)−vy = 1400×1.5−400 = 1700` 复核一致。

**顺序**：算几何（纯函数）→ 写 `scrollTop` → `setViewport` → 请求渲染。禁止「先设 scrollTop 再量 `getBoundingClientRect`」（强制同步布局）。**验收式**：`|缩放后鼠标处文档坐标 − 缩放前| ≤ 0.5px`，单测固定页顶/页中/页底三个锚点。

## 8. 滚动与 rAF 节流

监听：容器上 `scroll`/`wheel`/`touchmove` 一律 `{ passive: true }`（本项目不靠它们阻止默认行为）；`scroll` 回调只写 `pendingScrollTop`，不计算不渲染。

```ts
let raf = 0;
function onScroll(ev: Event): void {
  pendingScrollTop = (ev.target as HTMLElement).scrollTop;
  if (!raf) raf = requestAnimationFrame(flush);
}
function flush(): void {
  raf = 0; const s = pendingScrollTop;
  const { first, last } = computeVisible(s);            // §2 纯计算，不碰 DOM
  applyLayout(s);                                       // 只写 transform
  scheduler.setViewport({ mode, scale, scrollTop: s, viewportHeight, viewportWidth, pageGeometries });
  if (userScrolling) scheduleProgressSave(s);           // 1000ms 尾随，归 M07/M12
}
```

**避免 layout thrash 的四条做法**：① 读写在时间上分离——一帧内先把 `scrollTop/clientHeight` 各读一次存局部变量，再进入纯写阶段；② 滚动路径禁止 `offsetTop/offsetHeight/getBoundingClientRect`，尺寸用 §1 公式算；③ 只写 `transform`/`opacity`（与 13 §2 绝对约束 3 一致），尺寸改动集中在同一写阶段；④ 滚动路径不加 `will-change`（页多会图层爆炸），仅在缩放期间临时提升被缩放的 1–2 页。

**节流参数**：滚动本身不节流（每帧一次才不掉页）；进度保存 1000ms 尾随；缩放合并 1 帧 + 100ms 尾随（保证最后一次一定落地）。

## 9. 性能预算表

| 指标 | 预算 | 打点（§11） |
|---|---|---|
| 首屏可读（首屏 3 页 / 100MB 中文论文） | **< 800ms** | `first-readable` |
| 滚动帧率 | **≥ 55 fps**（帧预算 1000/55 = 18.18ms） | `scroll-frame` |
| 缩放首帧响应 | **< 100ms** | `zoom-first-frame` |
| 内存峰值（含缓存） | **< 900MB** | `mem-peak` |
| 退出阅读后回落 | 2s 内 **< 600MB** | `mem-after-dispose` |

**首屏 800ms 分解**（加总 = 800；任一项超支从余量扣）：

| 阶段 | ms | 打点 |
|---|---|---|
| `document_url` invoke（05 §3 第 180 行） | 40 | `ipc.document_url` |
| `pdf://` 首段字节（受 V-06/V-07 约束） | 120 | `pdf.first-byte` |
| `getDocument` 头部解析 | 180 | `pdf.get-document` |
| 第 1 页 `getPage` + 渲染（scale 1.5, dpr 1） | 140 | `pdf.render.page` |
| TextLayer 挂载 | 60 | `pdf.text-layer` |
| 布局 + 首次绘制 | 80 | `layout.first-paint` |
| 余量（第 2、3 页填充与抖动） | 180 | — |

**内存 900MB 分解**（加总 896 ≤ 900）：

| 项 | MB | 说明 |
|---|---|---|
| WebView2 空壳基线 | 130 | 进程工作集，不可压 |
| JS 堆（React + 契约层 + 应用态） | 120 | — |
| canvas 缓存 | 256 | §5 的 `cacheBytes` 默认值 |
| TextContent 缓存 | 40 | §6 的 200 页上限 |
| pdfjs 解析/解码缓冲（含 worker 侧） | 200 | 终值由 V-07 实测替换 |
| Rust 侧（SQLite page cache + 提取缓冲） | 150 | 后台索引常驻 |
| **合计** | **896** | 距 900 仅 4MB → 上调 `cacheBytes` 前必须重测本表 |

**回落路径**：`dispose()` 链（06 §5 第 1–3 步）300ms 内返回 → canvas 置 0 尺寸（06 §6）、文本缓存清空、文档代理 `destroy`；2s 是留给 WebView2 回收位图与 V8 增量 GC 的窗口。判据：< 600MB 且 `document.querySelectorAll("canvas").length === 0`。

**缩放首帧 < 100ms 的做法**：不清空当前 canvas，先施加 `transform: scale(k)` 作预览（模糊但位置正确），清晰图完成后原地替换并复位。副作用「短暂模糊」是否接受见 §12 第 4 条。

## 10. 与后端索引的资源竞争

| 资源 | 前端（阅读） | 后端（索引） | 来源 |
|---|---|---|---|
| 并发 | `maxConcurrent = 2` | `spawn_blocking` 信号量 2，每批 8 页后 yield | 02 §9 第 272、274 行 |
| 让位 | 靠自身取消机制 | 每批间检查 `index_pause` 与「是否出现 `priority < 当前`」 | 02 §9 第 277 行（无中断、无锁） |
| DB | 只读 + 进度短事务 | 一事务 8 页批提交，目标 < 30ms | 04 §2 WAL + `busy_timeout = 5000` |

CPU 峰值最多 4 个重任务（2 + 2）。**建议编排（跨模块，需 Lead 定归属，M06 不得直接调后端 Command，见 02 §2）**：由 M07/M14 在「用户连续交互 > 150ms」时调 `index_pause`（05 §3 第 187 行）、空闲 1.5s 后 resume——150ms/1.5s 防抖动，避免后端反复停在批边界空转。

**验证「索引时滚动不掉帧」**：① 备 ≥500 篇库，打开 100MB 样本，`index_rebuild_all`（05 第 188 行）触发全库重建；② 30s 内每 200ms 滚 200px，同时用 rAF 记录 `performance.now()` 差值；③ 判据：帧间隔 p95 ≤ 18.18ms、丢帧率（>25ms 帧占比）≤ 1%、longtask ≤ 5 次/10s、`index://progress` 间隔 ≥ 250ms（05 第 217 行）；④ 对照组：`index_pause({paused:true})` 后同脚本，两组 p95 差 ≤ 2ms 即认定「索引不影响滚动」。

## 11. 测量方法

| 打点名 | 起点 | 终点 |
|---|---|---|
| `ipc.document_url` | `call("document_url")` 前 | 返回 |
| `pdf.first-byte` | `openDocument` 进入 | 首个字节可用（adapter 内打点） |
| `pdf.get-document` | `getDocument` 调用 | 文档代理就绪 |
| `pdf.render.page` | `render()` 调用 | `promise` resolve |
| `pdf.text-layer` | `mount()` 调用 | DOM 挂载完成 |
| `layout.first-paint` | 首次 `setViewport` | 下一帧 rAF 回调 |
| `first-readable` | `openDocument` 进入 | 首屏 3 页均 `state === "ready"` |
| `zoom-first-frame` | `setScale` 调用 | 预览 transform 生效后的下一帧 |
| `mem-peak` / `mem-after-dispose` | 阅读开始 / `dispose()` 后 2s | 内存读数 |

```js
new PerformanceObserver(list => { for (const e of list.getEntries()) report("longtask", e.duration); })
  .observe({ type: "longtask", buffered: true });

const gaps = []; let prev = performance.now();
(function loop(now){ gaps.push(now - prev); prev = now;
  if (gaps.length < 1800) requestAnimationFrame(loop);
  else report("frame", { p95: quantile(gaps, .95), dropped: gaps.filter(g => g > 25).length / gaps.length }); })(prev);
```

**内存读取（按可用性降级）**：① `performance.memory.usedJSHeapSize` —— WebView2 可能不可用或精度截断，启动时先探测再降级；② `performance.measureUserAgentSpecificMemory()` —— 需 COOP/COEP，本项目未开启，通常走不通，仅记录；③ DevTools 堆快照三次比较趋势（校验 §6 的 183KB/页 与 06 §6 泄漏判据）；④ 进程工作集（最贴近 §9 口径）：

```powershell
Get-Process msedgewebview2 | Measure-Object WorkingSet64 -Sum | Select-Object @{n='MB';e={[math]::Round($_.Sum/1MB,1)}}
```

判据：读 100MB 样本时 < 900，`dispose()` 后 2s < 600。注意 `msedgewebview2` 可能被其它应用共享 → 先记基线，用差值判定。

## 12.【待你确认】与契约缺口

**【待你确认】**（M06 不得自取值，实现留 `TODO(ui-confirm)`）：

1. `pageGap`（相邻页间距）数值及其换算基准（px 还是 rem）。
2. `padding`（阅读容器上下留白）数值；单页/连续模式是否不同。
3. 页容器是否加阴影/描边/圆角，缩放时是否保持恒定视觉厚度。
4. 缩放期间是否接受「短暂模糊的放大预览」（§9 首帧策略依赖它；若要求清晰后才显示，100ms 预算需放宽）。
5. 缩放档位：固定档还是连续缩放，是否允许超过 2.0 倍。
6. 单页模式下长页（`h_p > viewportHeight`）纵向对齐：顶部对齐还是垂直居中。
7. 页间空隙是否响应点击（如点击空隙翻页）。

**契约缺口（Lead 已裁决，见 05 §11 修订记录）**：

1. ~~`RenderBudget` 无默认值~~ → **R3 已冻结**：2 / 268435456(256 MiB) / 2。本文档 §2、§5 沿用。
2. ~~`RenderScheduler` 缺换文档释放接口~~ → **R4 已冻结** `setDocument` 的释放语义，**不新增方法**（非架构变更）；本文档按语义实现销毁顺序。
3. ~~`PageRenderState.scale` 语义未定义~~ → **R5 已冻结**：允许为旧值（LOD 预览），消费方不得判定失败。
