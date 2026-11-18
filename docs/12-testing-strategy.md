# 12 · 测试策略

> 依据：`master_plan.md` §4.1（性能）、§4.2（稳定性）、§7 第 12 节（测试要求）；`docs/02-system-architecture.md` §1（V 清单）；`docs/04-database-design.md` §9（测试要求）；`docs/05-api-contracts.md` §10（契约一致性检查）；`docs/module-prompts/_shared-context.md` G 节。
> 本文档规定「测什么、怎么测、怎么判定通过」，不规定代码怎么写。

## 1 测试金字塔与比例目标

| 层 | 工具 | 占比目标 | 测什么 | 单次时长 |
|---|---|---|---|---|
| Rust 单测 | `#[cfg(test)]`（同文件内） | 45–55% | 分词、查询构造、窗口算法、Range 解析、路径校验、Repository SQL | < 60s |
| TS 单测 | vitest | 25–35% | 页几何、可见页、优先级、LRU、归一化、坐标映射 | < 30s |
| 集成测试 | `tests/*.rs` + 真实 SQLite 文件 + 真实 PDF 样本 | 10–15% | 迁移、级联、FTS 一致性、索引全链路、降级分支 | < 5min |
| 手工 UI 清单 | 人工（§7） | 5% | 视觉、手感、跨进程行为、断网 | 每次发版 |

覆盖率门槛：**纯逻辑模块**（`index/`、`search/`、`render/` 的纯函数部分）行覆盖 ≥ 70%，分支覆盖 ≥ 60%。**不给 UI 组件设覆盖率门槛**——那只会诱导写「快照即断言」的空测试。

最低用例数（每模块，来自 shared-context G2）：每个 Command / 事件 / 纯函数至少 1 正常 + 1 边界 + 1 错误路径。三个路径写成同一张表登记在模块交付报告的 §5。

## 2 Rust 侧：仓库测试

### 2.1 为什么用临时目录 + 真实 SQLite 文件，而不用 `:memory:`

| 理由 | 说明 |
|---|---|
| WAL 无法在内存库上生效 | `PRAGMA journal_mode = WAL` 对 `:memory:` 返回 `memory`。04 §2 的并发承诺（单写多读、`busy_timeout=5000`）在内存库上根本没有被测到，测试会给出虚假的通过 |
| 需要关闭再重开 | 「`text_state='indexing'` 启动时重置为 `pending`」（04 §6 L178）与 rowid 复用回归（04 §9 L204）都要求进程/连接能重开同一份数据 |
| 迁移升级路径 | 04 §9 L202 要求「从 001 库 → 最新」，必须有落盘的旧版本库文件 |
| 崩溃语义 | 批事务最多丢一批（02 §6 L210）只能用真实文件 + 强制中断验证 |

做法：每个测试用 `tempfile::TempDir` 建独立目录，库路径 `dir/legere.db`，测试结束自动清理（Windows 上如需保留失败现场，用环境变量 `LEGERE_KEEP_TEST_DB=1` 跳过清理并打印路径）。

### 2.2 `tests/common/mod.rs` 辅助函数清单

| 函数 | 作用 | 备注 |
|---|---|---|
| `new_temp_db() -> (TempDir, Connection)` | 建临时目录 + 打开库 + 设 04 §2 四条 PRAGMA + 跑迁移 | 一切集成测试的入口 |
| `open_wal_db(path) -> Connection` | 打开已存在的库并设 PRAGMA | 重开场景 |
| `db_caps(conn) -> DbCapabilities` | 执行 V-03 探针，返回 `{ fts5, contentlessDelete }` | 探针本身也是被测对象 |
| `force_degraded_fts(conn)` | 强制建「无 `content=''`」的普通 FTS5 表 | 04 §9 L206 的降级用例必须能跑 |
| `seed_documents(conn, n) -> Vec<i64>` | 插入 n 条 `documents`（含 root） | 返回 id 便于断言 |
| `insert_pages(conn, doc_id, &[&str])` | 按 §07 的 `build_seg_text` 写入 `page_text` + `page_fts`（同事务） | 供检索测试造数据 |
| `assert_fts_consistent(conn)` | FTS 行数 == `page_text` 行数，且无孤儿 rowid | 与 `db_integrity_check` 的口径一致 |
| `fixture_path(name) -> PathBuf` | 取 `tests/fixtures/pdfs/<name>` | 缺失即 panic 并提示跑 `scripts/gen-fixtures.ps1` |
| `build_bench_db(dir, docs, pages_per_doc)` | 造 100k 页基准库 | 只在 `#[ignore]` 的性能测试里用 |
| `with_two_connections(path, f)` | 一写一读两个连接同时操作 | 并发用例 |
| `capture_logs(f)` | 捕获 `tracing` 输出断言「有 warn 且有上下文」 | 静默吞错检查 |

## 3 样本 PDF 库要求

样本放 `tests/fixtures/pdfs/`，用 `scripts/gen-fixtures.ps1` 生成 + 一份 SHA-256 清单锁定；仓库不存超过 50MB 的文件（大样本走脚本按需生成）。

| # | 样本 | 用途 | 来源方式 | 期望行为 |
|---|---|---|---|---|
| 1 | 正常中文论文（含图表、公式） | 分词、检索、正文分栏 | 自建（Typst/LaTeX 导出 CJK） | `text_state='indexed'`；查「中文双字词」命中正确页 |
| 2 | 英文双栏论文 | 阅读顺序、`text` 与 `items` 对齐（07 §8 A1） | 公开样本（pdfjs-dist 仓库 test 目录） | `text.length == sum(items.str.length)`；跨栏不串行 |
| 3 | 扫描件（整页图片，无文本层） | `no_text` 分支（D11） | 自建（图片打平成 PDF） | `text_state='no_text'`、`index_error_code='E_PDF_NO_TEXT'`、不重试 |
| 4 | 加密（用户密码为空，owner 密码非空） | 可打开路径 | `qpdf --encrypt` 生成 | 正常打开并索引 |
| 5 | 加密（用户密码非空） | 拒绝路径 | 同上 | `E_PDF_ENCRYPTED`；`text_state='failed'`；`attempts` 不无限增长 |
| 6 | 损坏（截断到 50%） | 容错 | 用 `head` 截断正常 PDF | `E_PDF_CORRUPT`；不崩溃；不写入半截 `page_text` |
| 7 | 超大（>200MB，>800 页扫描体量） | Range、内存、首屏 | 脚本合并生成 | 首屏与内存进 §6 基线；验证 `RANGE_MAX_BYTES`（09 §3.2）取值 |
| 8 | 页数 >1000 | 调度、进度、批事务 | 脚本合并生成 | 索引按 8 页批推进（02 §6 L210）；`index://progress` ≤ 4 次/秒（05 §4 L217）；滚动不爆任务 |
| 9 | 页面旋转 90/180/270 | 几何与高亮坐标 | 自建（LaTeX 旋转页） | `PageGeometry.rotation` 正确；命中矩形在旋转页上仍贴合文字 |
| 10 | 无 Outline | `getOutline` 降级 | 自建 | 返回 `[]`（05 §7 L261），UI 不崩 |
| 11 | 彩色图表页（高饱和） | 护眼不改像素（D07） | 自建 | 切换 paper 主题前后 `canvas.toDataURL()` 逐字节相同（外围背景变、像素不变） |
| 12 | 文件名含中文/空格/`&`/`#`/`%` | 路径与 URL 编码 | 复制样本改名 | 全部入库；`pdf://` 请求正常（`#`、`%` 不得被当成 fragment 或转义失败） |
| 13 | 文件名超长（>200 字符）+ 深目录（>260 字符） | 长路径（09 §8） | 脚本创建 | 入库并可打开；打不开时明确报 `E_IO` 而非崩溃 |
| 14 | 同名文件（两个不同子目录） | 唯一键与去重 | 复制样本 | 两行记录（`abs_path` 不同）、各自独立索引 |
| 15 | 极简（1 页 1 行文本）/ 0 页 | 边界 | 自建 | `page_count` 正确；窗口算法边界夹取不 panic |

## 4 TS 前端：vitest 覆盖范围

| 模块 | 必测纯逻辑 | 断言示例 |
|---|---|---|
| M05/M06 页几何 | `pageGeometries` → 累计纵向偏移表 | N 页偏移单调递增；缩放 1→2 后偏移整体 ×2（误差 ≤ 0.5px） |
| M06 可见页计算 | `(scrollTop, viewportHeight, geometries) -> 页集合` | 首页时返回 `[1..ceil(h/页高)+prefetch]`；滚动到末尾不越界 |
| M06 优先级 | 可见 > 预取 > 空闲；缩放时取消窗口外任务 | 队列顺序快照；取消后 `renderTask.cancel` 调用次数 = 被取消页数 |
| M06 LRU | 字节预算逐出 | 逐出顺序严格 LRU；`dispose()` 后缓存与任务均为空 |
| M02 归一化 | `normalize_keep_len` 与 Rust 侧一致 | 20 组共享 fixture（全角/大小写/emoji/换行）两侧输出逐字节相同 |
| M08 查询与坐标 | 锚点查找 + 累积长度表 → item 下标 | 页内索引 0 / 末尾 / item 边界三处定位正确；命中含 emoji 时不偏移 |
| M07 缩放锚点 | `setScale(s, anchor)` 后锚点 ratio 保持 | ratioX/ratioY 变化 ≤ 0.005 |
| M11 结果面板 | 分组、命中数格式化、（无排序逻辑） | 空结果 / 1 条 / 50 条三档渲染不抛错 |

**为什么 UI 组件以「手工清单 + 少量 DOM 测试」为主，不做全面 e2e**：

1. Tauri 的 e2e（WebDriver/tauri-driver）在 Windows 上要驱动 WebView2，环境依赖重、失败原因难归因；本项目单人开发，维护成本 > 收益。
2. 渲染结果依赖 GPU/字体/DPR，像素级断言在不同机器上必然 flaky，最终只能靠放宽阈值通过——正是 §9 禁止的做法。
3. 主页转盘等形态本身仍是【待你确认】状态（13 §7 十条未定），写 e2e 断言等于把未拍板的视觉固化成测试契约。
4. 保留的 DOM 测试只测**可判定的结构**：```testing-library/react` 断言隐藏弧段 `[data-home-spine]` 计数为 0、键盘 Tab 顺序、`prefers-reduced-motion` 下无动画类名。这些与视觉无关。

## 5 契约一致性测试（05 §10 三条）

| # | 检查 | 判定方式 | 失败输出 |
|---|---|---|---|
| 1 | DTO 字段名差集 | `node scripts/check-contracts.mjs`：读 `src/contracts/*.ts` 与 `src-tauri/src/contracts/*.rs`，提取 interface/struct 字段名，算两侧差集 | 差集非空 → 打印 `文件:行 字段名` 并 `exit 1` |
| 2 | Command 注册表覆盖 | `CMD` 常量集合（`as const`）与 Rust 侧 `#[tauri::command]` 注册清单做集合相等断言；清单由构建脚本生成到 `src-tauri/target/commands.json`，避免手抄 | 集合不等 → 打印只在一侧出现的命令名 |
| 3 | 错误码完整性 | Rust `ApiErrorCode` 的 12 个变体 == TS 12 个字面量，双向子集 | 打印缺失项；数量不是 12 也失败（05 §1 L19-L23） |
| 4（补充） | 可选性语义 | 所有 Rust `Option<T>` 字段在 TS 中必须是 `T \| null`，不得是 `?: T` | 05 §2 L154 明确要求「不是 undefined」；违反 → exit 1 |

这三条是 CI 的**门禁**，不通过不得合入。它们保护的是「改名/漏项」这类静默漂移——这类错误在运行时表现为「字段莫名 undefined」，靠手工测试几乎抓不到。

## 6 性能基线：测法与记录表

测法：找一台固定的开发机，禁用其他负载，每个场景跑 3 次取中位数；搜索类跑 20 次取 P95。

| 场景 | 指标 | 目标 | 实测 | 通过? |
|---|---|---|---|---|
| 打开 20MB 中文论文 → 首屏可读 | 时长 | 建议 ≤ 3s（首测后回填基线） | | |
| 连续滚动（1000 页文档，快速拖拽） | 帧率 | ≥ 55fps（13 §5 同口径） | | |
| 全局搜索（100k 页，中文双字词） | P95 | < 200ms（07 §11） | | |
| 全局搜索（100k 页，单汉字） | P95 | < 200ms | | |
| 索引吞吐 | 页/秒 | ≥ 40（8 页一批、2 并发下） | | |
| 索引期间前台滚动 | 帧率 | ≥ 55fps（不得被索引拖垮） | | |
| 打开 >200MB PDF | 内存峰值 | ≤ 1.2GB（V-07 后回填） | | |
| 主页转盘（N=60）挂载 DOM 数 | 节点数 | ≤ `ceil(visibleArc/360 × N) + 2`（13 §5 L116） | | |
| 迁移 001 → 最新（4000 文档库） | 时长 | ≤ 5s | | |

表中「目标」列标「建议」的行是我给的初始值，**首次实测后回填并固化**；回填不得放宽，只能收紧或说明理由。

## 7 回归清单（每次改动后必测 10 条）

1. 启动 → 空态 → 添加库根 → 扫描 → 列表出现文档，`library://scan-progress` 三段 phase 都到达。
2. 打开 PDF：首屏渲染完成；若有进度，恢复位置正确且夹取到 `page_count` 内。
3. 连续/单页模式切换：`getDocument` 只调用 1 次（打点断言，不是肉眼）。
4. 缩放 1.0 → 2.0 → 1.0：锚点页与页内比例不漂移。
5. 全局搜索中文双字词 → 结果 → 点击 → 打开到正确页 → 高亮框贴合文字（07 §8 段 2）。
6. 当前文献内搜索（M08）：跨行/跨 `item` 命中、中文子串、大小写与全角归一。
7. 删除磁盘文件 → 记录软删除；文件放回 → 复活同一 id，书签与进度仍在（04 §4 L155）。
8. 书签增删改 + 进度节流保存（1s）：关窗后重开，最后一次进度不丢。
9. paper 主题：外围背景变、`canvas.toDataURL()` 不变（样本 #11）。
10. 断网启动：全部功能可用，进程无对外 TCP 连接（09 §7）。

补充第 11 条（发版前必做）：从 001 库升级到最新迁移 + `db_integrity_check` 四项全为 0。

## 8 CI / 本地脚本

仓库当前无 CI 时，以下 PowerShell 脚本就是门禁，交付前必须本地跑通并把输出摘要贴进报告（shared-context G3）。

| 脚本 | 作用 | 通过判据 |
|---|---|---|
| `scripts/test-all.ps1` | 依次跑 `cargo test --all`、`pnpm vitest run`、`pnpm tsc --noEmit`、`node scripts/check-contracts.mjs` | 任一非 0 退出码即整体失败；输出末尾打印各步通过数 |
| `scripts/gen-fixtures.ps1` | 生成/校验 §3 的样本清单（SHA-256 白名单）；缺失的按需生成 | 15 个样本齐全、哈希匹配；缺一即失败 |
| `scripts/bench-search.ps1` | 造 100k 页基准库 → 跑 100 条预置查询 → 打印 P95 | P95 < 200ms；同时打印 `EXPLAIN QUERY PLAN` 供人工核对 07 §11 三条判据 |
| `scripts/smoke.ps1` | 启动构建产物 30s，抓日志与连接 | 日志无 ERROR 级、无对外连接、进程正常退出 |
| `scripts/check-contracts.mjs` | §5 的四条检查 | 差集为空、集合相等、12 个错误码、无 `?: T` |

约定：脚本只调用项目已有命令（`cargo`/`pnpm`/`node`），不引入新工具链；脚本自身不得修改源码。

## 9 纪律：不得以降低断言换绿灯

禁止（出现即视为交付失败，对应 shared-context H.4）：

1. 注释掉、删除或 `#[ignore]` / `.skip` 一个失败用例；
2. 放宽阈值让用例通过（例如把 P95 门槛从 200ms 改成 500ms、把帧率从 55 改成 30）；
3. 用 `try/catch` 包住断言、用 `setTimeout` 掩盖竞态、用重试掩盖不确定行为；
4. 把随机输入改成「只测一个恰好通过的值」；
5. 在没有实测数据的情况下调整 §6 的目标列。

允许的做法：把不确定的输入换成确定性输入并保留断言强度；把 flaky 用例的根因写清楚后**先修被测代码**；确实需要放宽时，必须同时修改本文件 §6/§9 并附实测数据，由 Lead 批准。

flaky 处理流程：复现 3 次 → 记录触发条件（并发/时序/字体）→ 在用例注释里写下根因 → 修或重写。修不掉且在本次发布范围外的，移入 `#[ignore]` **并在报告 §7「已知问题」逐条列出**，不得静默跳过。

## 10 与 UI 相关的判定项（阈值等你定，测试不得替代拍板）

以下验收口径涉及视觉/手感，测试只能采集数据，判定权在你（对应 13 §7 的待确认条目）：

1. 拖拽「手感」是否可接受——本文件只记录 fps 与长任务数（13 §5 已有数值门槛）。
2. 空态与引导形态的验收标准（13 §7 第 9 条未定）。
3. 焦点书信息展示位置与形式的验收标准（13 §7 第 8 条未定）。

在收到你的取值前，手工清单里这三项一律记为「未判定」，不得自行写成「通过」。
