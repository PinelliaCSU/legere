# 模块 M15：integration-release（集成、性能基线与发布）

> 依赖前置：M01–M14 全部模块（03 §2 M15 第 182 行「依赖：全部」）。
> 被依赖方：无（终局模块）。
> 归属层：全栈（不改业务代码，只新增测试、脚本、打包配置与验收记录）；并行组：第三批最后（03 §3 第 202 行）。

## 1. 模块身份

M15 是「把所有模块拧成一个可交付产品」的收口层：它跑端到端流程、记录性能基线、准备样本库、配置 Windows 打包、核对发布检查清单。
它**不写业务逻辑**，也**不改任何契约**；发现缺陷时按 03 §5 第 234 行写「接口需求 / 缺陷单」交回归属模块，而不是顺手在自己这边修。
它的产出是可复现的证据：命令、输出摘要、基线数字、安装包。

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

一句话：**在干净数据目录上一次跑通 10 步端到端流程，产出一张每格都有实测值的性能基线表，以及一个能在另一台 Windows 机器上安装并打开 PDF 的安装包。**

分解目标：
1. 端到端用例清单可执行、每步有判据（§4.1）。
2. 性能基线按固定表格记录，未测项写「未验证 + 原因」，不空着（§4.2）。
3. 样本 PDF 库覆盖 7 类真实边界（§4.3）。
4. Windows 打包配置与体积记录（§4.4）。
5. 发布检查清单全部可命令化（§4.5）。
6. 已知限制文档与实际行为一致（不做 OCR、扫描件不可检索等，§4.6）。

## 4. 功能范围（必须完成）

### 4.1 端到端用例清单（干净数据目录，按序执行）

| # | 步骤 | 操作 / 命令 | 判据 |
|---|---|---|---|
| 1 | 干净启动 | 删除数据目录（路径取自 `app_info()` 的 `dataDir`，删前先打印确认），启动应用 | 收到一次 `app://ready`（05 §4 第 214 行）；`ping()` 返回 `{ ok: true }` |
| 2 | 加库 | `library_root_add({ path })` | 返回 `LibraryRootDto`；`library_root_list()` 长度 = 1 |
| 3 | 扫描 | `library_scan_start({})` | 收到 `library://scan-progress` 且终态 `phase === "done"`；`added` = 样本 PDF 数量 |
| 4 | 索引 | 等自动入队，或 `index_rebuild_all({})` | `index_status().documentsPending === 0`；文字版 PDF 的 `document_get(id).textState === "indexed"`，扫描件 === `"no_text"`（**不得**是 `failed`，D11） |
| 5 | 主页转盘 | 切到 `home` | `[data-home-spine]` 计数 ≤ `ceil(visibleArc/360 × N) + 2`；隐藏弧 DOM 数 0（13 §5 第 116 行） |
| 6 | 打开阅读 | 点击书脊 / `Enter` | 路由变 `reader`；`document_touch_opened({ id })` 生效（`lastOpenedAt` 非空） |
| 7 | 阅读 | 连续滚动 3 页并停在中间 | canvas 就绪；1s 后发出 `progress_save`；`progress_get({ documentId })` 返回的 `pageNo` 与界面一致 |
| 8 | 文内搜索 | 搜一个中文词（M08） | 命中数 > 0；跳转到命中页且高亮可见 |
| 9 | 库级搜索 | `search_global({ params })`（`hitsPerDocument ≤ 5`、`documentLimit ≤ 50`，05 §8 第 341-342 行） | `totalDocuments > 0`；记录 `tookMs`；点击结果打开并定位到 `pageNo` |
| 10 | 书签 | `bookmark_create` → 跳转 → `bookmark_delete` | `bookmark_list` 长度 0→1→0；跳转页号 = 创建时 `pageNo` |
| 11 | 重启恢复 | 关闭应用 → 重开 | `progress_get` 恢复上次 `pageNo`；`index_status()` 中无 `indexing` 残留（04 §6 第 178 行） |

补充边界用例（必跑）：`encrypted.pdf` → `E_PDF_ENCRYPTED`；`corrupt.pdf` → `E_PDF_CORRUPT` 且应用不崩；索引进程中删除文件 → 不崩、该文档软删除。

### 4.2 性能基线执行与记录表

| 指标 | 门槛 | 测法 | 实测 | 结论 |
|---|---|---|---|---|
| 主页首次可交互 | < 300ms（N ≤ 60） | `performance.mark` 打点（13 §5 第 120 行） | 待填 | — |
| 拖拽帧率 | ≥ 55fps（N=60，1920×1080） | rAF 采样 3 秒（13 §5 第 118 行） | 待填 | — |
| 拖拽长任务 | 0 个 > 16ms | `PerformanceObserver`（`longtask` 若不可用则用 DevTools Performance 手工读数） | 待填 | — |
| 挂载书脊 DOM 数 | ≤ `ceil(visibleArc/360 × N) + 2` | `document.querySelectorAll("[data-home-spine]").length` | 待填 | — |
| 库级搜索 P95 | 门槛【待你确认】 | 固定 20 条查询 × 5 次，取 `tookMs`（05 §2 第 145 行） | 待填 | — |
| 大 PDF 首屏（>300MB） | 门槛【待你确认】 | **先关闭 V-07**（02 §1 第 36 行）再测 | 待填 | — |
| 内存峰值 | 门槛【待你确认】 | 系统任务管理器读进程工作集；若 `performance.memory` 在 WebView2 可用则一并记录（**先验证**其存在性） | 待填 | — |
| 索引吞吐 | 记录值 | 记录 8 页/批（02 §6 第 210 行）下「页/秒」 | 待填 | — |
| 安装包体积 | 记录值 | `(Get-Item <安装包>).Length` | 待填 | — |

规则：每格必须填实测值或写「未验证 + 原因」（_shared-context §G 第 77 行）；测量必须注明机器规格与分辨率（至少 CPU 型号、内存、屏幕分辨率），否则数据不可比。

### 4.3 样本 PDF 库（`tests/fixtures/pdf/`）

| 文件 | 用途 | 期望行为 |
|---|---|---|
| `text-zh.pdf`（中文文字版，≥15 页） | 正常索引与检索 | `textState = indexed`；库级搜索可命中 |
| `text-en-chart.pdf`（含彩色图表页） | M13 颜色保真对比 | light 与 paper 下 canvas 像素一致 |
| `scan-only.pdf`（无文本层） | 扫描件终态 | `textState = no_text`，不重试，不崩 |
| `encrypted.pdf`（需密码） | 错误路径 | `E_PDF_ENCRYPTED` |
| `corrupt.pdf`（截断字节） | 错误路径 | `E_PDF_CORRUPT`，不崩 |
| `huge.pdf`（> 300MB） | V-07 与首屏 | 可打开（或记录失败原因） |
| `outline-nested.pdf`（多级 Outline） | 侧栏 Outline 展示 | 层级正确，不落库（03 §2 M12 第 149 行） |

规则：不得提交受版权保护的文献；自制或公有领域样本，并在 `tests/fixtures/pdf/README.md` 记录来源与生成方式；清点命令 `Get-ChildItem tests/fixtures/pdf/*.pdf | Measure-Object -Property Length -Sum`。

### 4.4 打包配置（Windows 优先，03 §2 M15 第 178 行）

1. 构建命令：`npx tauri build`（先 `npx tauri info` 确认工具链与 WebView2 状态）。
2. `src-tauri/tauri.conf.json` 需要落地三项：`bundle.targets`（安装包形态，见 §7.2 第 5 条）、`bundle.resources`（pdfium 动态库与静态资源）、`bundle.windows.webviewInstallMode`（WebView2 依赖策略）。
   **先验证再写**：定位 CLI 的配置 schema（`Get-ChildItem node_modules/@tauri-apps/cli -Filter *.json -Recurse`），抄录这三个键的类型与枚举值；判据 = schema 中存在这些键且枚举值被抄进交付报告。若 schema 缺失该键，改为在报告写「未验证」并说明替代方案，不得凭记忆写配置。
3. pdfium 动态库分发：`.dll` 必须以 resource 形式随包分发（M09 的 `TextExtractor` 依赖它）；运行时定位路径的 API 必须先抄录签名（Tauri 2 的 resource 目录解析），判据 = 安装后 `.dll` 实际存在于安装目录的 resources 下（用 `Get-ChildItem -Recurse` 验证）。
4. 体积记录：记录 msi/nsis 各自体积与「与上一版比较」的增量；无体积门槛（见 §7.2 第 1 条）时只记录不判定。
5. 安装验证：在另一台 Windows 机器（或全新用户配置的干净虚拟机）安装 → 启动 → 加库 → 打开一本 PDF。

### 4.5 发布检查清单（全部命令化，逐项贴输出摘要）

1. `cd src-tauri && cargo clippy --all-targets -- -D warnings` → 0 warning。
2. `npx tsc --noEmit` → 0 error。
3. `node scripts/check-contracts.mjs`（脚本归 M02，05 §10 第 362 行）→ DTO 字段差集为空。
4. `cd src-tauri && cargo test` 与 `npx vitest run` → 全绿，无 `skip`（跳过的用例必须列出并说明）。
5. 契约一致性：`CMD` 常量集合 == Rust `#[tauri::command]` 注册集合（05 §10 第 363 行）；错误码枚举双向覆盖（05 §10 第 364 行）。
6. `index_rebuild_all({})` 跑完后 `db_integrity_check()`：`ftsRows == pageTextRows`、`orphanPages === 0`、`mislabeledDocuments.length === 0`（05 §3 第 199 行、04 §6 第 179 行）。
7. 日志：默认 INFO，`LEGERE_LOG` 可调，滚动文件保留 7 天（02 §10 第 284 行）；检查数据目录下日志文件数量与最早文件日期，确认清理生效。
8. 已知限制文档条目与实测行为一致（§4.6）。

### 4.6 已知限制文档

至少覆盖 4 条，每条一句「现象 + 原因 + 绕过方式」：不做 OCR（扫描件不可全文检索，D11）；`contentless_delete` 不可用时的降级分支（V-03/D10）；FTS5 中文短查询的限制（04 §7 第 186 行明确不使用 trigram）；大 PDF 首屏表现（V-07 结论）。

### 4.7 日志与数据目录

启动后记录 `app_info().dataDir` 与 `dbPath` 的实际值；核对日志滚动策略；给出「如何在不重装的前提下重置数据目录」的三步操作（停应用 → 备份/删除数据目录 → 重开），供后续复现问题用。

## 5. 非目标（明确不做）

### 5.0 已由 Lead 裁决的技术参数（**不再询问，按此实现**）

以下条目曾标为「待你确认」，但属技术参数且**已由 Lead 按官方文档与工程判断裁决**：**T27 T28 T30** —— 明细与理由见 `docs/14-ui-decision-register.md` §1 对应行。实现时直接落该值，**不得**再当作待确认项停下来问；若你认为某条在本模块不成立，在交付报告 §9 提出并说明，不要自行改动。

1. **不新增业务功能**（03 §2 M15 第 179 行）；发现缺功能走「接口需求」。
2. **不改任何契约**：`docs/02-05`、DTO、Command、事件、表结构一律只读（_shared-context §C）。
3. 不修其他模块的源码：端到端跑出的缺陷记录现象 + 最小复现 + 归属建议，交回该模块。
4. 不做 OCR，不把扫描件「尽量索引一下」。
5. 不引入自动更新、云 CI、崩溃上报等需要外部服务的组件（D12：local-first）。
6. 不替换技术栈（_shared-context §B）。
7. 不为让基线达标而放宽门槛、删样本、跳过用例或改判据。
8. **不得自行确定视觉方案**：若端到端过程中需要截图，只截不断言视觉正确性（视觉判据归各模块的【待你确认】）。

## 6. 架构约束

- 允许依赖：全部模块的**公开接口**与命令行工具；只读访问 `docs/**`。
- 禁止：修改 `src-tauri/src/contracts/**`、`src/contracts/**`、`src/core/ipc.ts`（M02）、`migrations/**`（M03）以及任何其他模块已登记的源文件（03 §4 第 209-230 行）。
- 产物位置：测试与门禁放 `tests/**`、脚本放 `scripts/**`（不覆盖 M02 的 `check-contracts.mjs`）、基线产物放 `artifacts/baseline/**`、dev-only 性能探针放 `src/dev/**`。
- 契约缺口（需 Lead 裁定）：
  1. `tests/**`、`scripts/**`、`artifacts/**`、`src/dev/**` 与 `src-tauri/tauri.conf.json` **均未在 03 §4 的文件归属矩阵中登记**。本模块只**新增**未登记路径下的文件；若必须修改 `tauri.conf.json` 的打包键，先声明并只改 `bundle` 子树，交付报告逐键列出。
  2. 03 §4 第 230 行规定 `docs/**` 归 Lead、模块只能追加「实现说明」；本模块的基线记录因此写在 `artifacts/` + 交付报告，**不新建 docs 文件**（需要时请 Lead 批准）。

## 7. 输入与输出

| 输入来源 | 数据形态 | 触发时机 |
|---|---|---|
| 全部模块 | 可构建的工程与可调用接口 | 每次发布前 |
| `app_info()` | `{ version, dataDir, dbPath, ftsEnabled, contentlessDelete }`（05 §3 第 173 行） | 每次运行开始 |
| 5 个事件 | `app://ready`、`library://scan-progress`、`library://changed`、`index://progress`、`index://job-finished`（05 §4 第 214-218 行） | 流程各步 |

| 输出目标 | 数据形态 | 消费方 |
|---|---|---|
| 基线记录 | `artifacts/baseline/*.json` + Markdown 表 | Lead / 后续版本对比 |
| 发布包 | `.msi` / `.exe` 安装包 | 用户在另一台机器安装 |
| 验收报告 | 按 §14 格式填写 | Lead |

### 7.2 【待你确认】清单

1. 安装包体积是否需要门槛（现只记录实测值）。
2. 未由 13 §5 给定门槛的三项（库级搜索 P95、内存峰值、索引吞吐）的验收门槛值。
3. 样本 PDF 库是否纳入仓库（版权与体积 vs 可复现性的权衡）。
4. 数据目录与日志目录的默认位置、日志保留天数（02 §10 第 284 行只给「7 天」）。
5. Windows 安装包形态：msi / nsis / 两者都出。
6. 基线产物（`artifacts/`）是否纳入版本库。

## 8. 接口契约

本模块**不新增**任何 Command、事件或 DTO（05 §3/§4 保持不变）。新增的自有接口仅两类：

```ts
// src/dev/perf/probe.ts —— dev-only，生产构建必须剔除
export interface PerfProbe {
  sampleDrag(durationMs: number): Promise<{ frames: number; fps: number; longTasks: number }>;
  markInteractive(name: string): void;
}
```

```bash
node scripts/perf-summary.mjs --in artifacts/baseline --out artifacts/baseline/summary.md
node scripts/perf-summary.mjs --check            # 校验每个指标格都有值或「未验证 + 原因」
```

探针剔除的判据：release 构建产物中检索 `__legerePerf` 命中数为 0。剔除手段必须先核对 Vite 版本的文档化能力（`import.meta.env.DEV` 等），不得凭记忆断言其行为。

## 9. 数据结构

无表、无 DTO 变更。新增的只有记录文件格式：

```json
{
  "generatedAt": "2025-01-31T12:00:00Z",
  "machine": { "cpu": "<型号>", "ramGb": 16, "screen": "1920x1080" },
  "metrics": [
    { "id": "home-interactive-ms", "value": 210, "threshold": "< 300", "verdict": "pass", "method": "performance.mark" },
    { "id": "drag-fps-60", "value": null, "threshold": ">= 55", "verdict": "unverified", "note": "缺 60 本样本" }
  ]
}
```

规则：`value` 为 `null` 时必须同时有 `verdict: "unverified"` 与 `note`（原因），否则 `--check` 失败。

## 10. 文件组织

```text
scripts/perf-summary.mjs      # 汇总/校验基线 JSON（不覆盖 M02 的 check-contracts.mjs）
tests/e2e/                    # 端到端用例（能脚本化就脚本化，不能则交步骤书）
tests/fixtures/pdf/           # 样本库 + README.md（来源、用途、生成方式）
src/dev/perf/probe.ts         # dev-only 性能探针
artifacts/baseline/*.json     # 实测记录
src-tauri/tauri.conf.json     # 仅 bundle 子树（见 §6 契约缺口 1）
```

## 11. 实施步骤

1. 记录环境事实：`app_info()`、机器规格、`npx tauri info` 输出；写入报告。
2. 搭样本库：按 §4.3 准备 7 个文件并写 `README.md`；用 `Get-ChildItem` 清点。
3. 跑 §4.1 的 11 步，逐步记判据结果；失败的步骤记录最小复现并归属到模块。
4. 接 `src/dev/perf/probe.ts` 与 `scripts/perf-summary.mjs`，跑 §4.2 表并填实测值。
5. 配置打包：先抄 schema（§4.4 第 2 条），再写 `bundle` 子树，`npx tauri build`。
6. 执行 §4.5 全部 8 项门禁，贴输出摘要。
7. 安装包在另一台机器验证（或在报告写「未验证」+ 具体方法与阻塞原因）。
8. 写已知限制（§4.6）与复现手册（§4.7）。

## 12. 测试要求

- 端到端：§4.1 的 11 步 + 3 条边界用例，每步附判据的实际读数。
- 门禁：§4.5 的 8 条，逐条命令 + 输出摘要（失败项必须列出，不得只贴通过项）。
- 基线校验：`node scripts/perf-summary.mjs --check` 在缺值时必须以非 0 退出码失败。
- 回归抽查：随机抽 3 本样本，重复「打开 → 滚动 → 关闭」5 次，检查内存不单调增长（记录数值，不做断言）。

命令汇总：

```bash
cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test
npx tsc --noEmit && npx vitest run
node scripts/check-contracts.mjs
node scripts/perf-summary.mjs --check
npx tauri build
```

## 13. 验收标准

1. **端到端一次通过**：在干净数据目录（删除后重建）上，§4.1 的 11 步全部满足判据并附实际读数；任一步失败即不通过（可重试，但必须记录首次失败现象）。
2. **基线表无空格**：§4.2 每个指标格都有实测值或「未验证 + 原因」；不达标项必须给出原因与建议（如「N=60 时 CSS 变量批量写入导致 1 次长任务，建议改为 rAF 分片」这类可执行建议，不接受「性能不佳」）。
3. **安装包可安装可运行**：在另一台 Windows 机器上安装 → 启动 → 加库 → 打开 PDF；若无法验证，交付报告必须写「未验证」并给出完整方法（目标机要求、安装步骤、判据）。其它模块未完成时，本项标注阻塞原因而非判为通过。
4. **8 项发布门禁**全部 0 失败，每项附命令与实际输出摘要。
5. `index_rebuild_all({})` 后 `db_integrity_check()` 返回 `ftsRows === pageTextRows`、`orphanPages === 0`、`mislabeledDocuments.length === 0`。
6. 样本库清点结果与 §4.3 表逐一对应（文件名、用途、期望行为），且 `README.md` 记录了每个文件的来源。
7. 已知限制（§4.6）中每条都能在本次实测中被复现或引用到具体用例编号。

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

1. 不得为让基线达标而放宽门槛、删除样本、跳过用例或修改判据；未达标即写未达标。
2. 不得修改任何其他模块的源文件或契约文档来「顺手修掉」端到端暴露的缺陷（03 §5 第 234 行）。
3. 不得新增业务功能、新增 Command / 事件 / DTO / 表。
4. 不得凭记忆写 `tauri.conf.json` 的键名或枚举值：必须先抄录本机 CLI schema 再写。
5. 不得把「安装包未验证」写成「已可用」；`artifacts/` 中不得出现手填的编造数字。
