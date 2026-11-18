# 模块 M01：foundation

> 依赖前置：无（工程起点）。03 §3 把 `M01 -> M02 -> M03` 定为串行主链，M01 之前没有任何可依赖项。
> 被依赖方：M02 contracts、M03 database（经 M02 的类型）、M05 pdf-engine（经 `pdf://` 取字节）、M14 workspace-shell、M15 integration-release。
> 归属层：全栈（L0 Rust Core 骨架，同时是 L1 IPC 通道两侧的物理通路）；并行组：串行主链第一环（03 §3），无并行伙伴。

## 1. 模块身份

M01 是整条依赖链的物理起点。它不实现任何业务语义，只铺七块地基：Tauri 2 桌面壳、React/TS 前端、invoke/emit 双向通道、tracing 日志、`ApiError` 基类型、`pdf://` 协议壳、测试环境——之后 14 个模块不必再碰工程配置。

数据流上它位于两端（02 §3 架构图与文字说明）：前端 `invoke` 请求经 `invoke_handler` 进入 Rust 命令层；PDF 字节不经 IPC，由 WebView 用 `fetch` 请求 `pdf://doc/{id}`，Rust 侧按 HTTP Range 读文件（02 §11 D01）。

它不含任何表、任何 PDF 解析、任何 UI 布局（03 §2 M01「不负责」）。关键判据：M01 结束时 `pdf://doc/{id}` 已能按 Range 返回真实字节，但「id → 真实路径」的映射仍是占位实现，由 M04 注入。

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

交付一个可运行空壳：`cargo tauri dev` 起得来，前端 `invoke("ping")` 能拿到回包，`fetch("pdf://doc/1", { headers: { Range: "bytes=0-99" } })` 返回 `206` + 正确的 `Content-Range`。

1. 工程可构建可运行：Tauri 2 + Vite + React + TS（`strict: true`），版本按 02 §1 表策略锁定。
2. 双向通道打通：前端→Rust（`invoke`）与 Rust→前端（`emit`/`listen`），各一条最小可用回路。
3. 日志可落地：滚动文件 + `LEGERE_LOG` 环境变量，字段集合与 02 §10 末段一致。
4. 错误基类型可被 Command 返回：`ApiError` + `ApiErrorCode` 12 变体（05 §1）。
5. `pdf://` 协议壳具备路由、Range 解析、404/403/400 语义（05 §6）。
6. 测试环境可跑：`cargo test` 与 `pnpm test`（vitest）都能出绿。

## 4. 功能范围（必须完成）

F-01 脚手架：生成 Tauri 2 + Vite + React + TS 工程（`pnpm create tauri-app` 或等价方式），锁定 `package.json` 精确版本；新增 `src-tauri/rust-toolchain.toml`（固定 stable channel）；`tsconfig.json` 开 `strict`、`noUncheckedIndexedAccess`、`paths` 别名 `@/*`。所有版本号先按 V-02 用 `cargo add --dry-run` 与 `npm view` 核实后写死。

F-02 Rust 骨架：`src-tauri/src/main.rs` 只做一件事——调用 `legere_lib::run()`；`src-tauri/src/lib.rs` 里装配 `tauri::Builder`（`.setup()`、`.invoke_handler(tauri::generate_handler![ping, app_info])`、`.register_asynchronous_uri_scheme_protocol("pdf", …)`、`.manage(...)`、`.run(tauri::generate_context!())`）。**这些调用签名一律标注为「按 V-06 / V-02 待验证」**，以 `cargo doc -p tauri` 与官方文档实际签名为准，不得凭记忆写。

F-03 日志：`init_logging(cfg: &AppConfig) -> Result<LogGuard, ApiError>`。默认级别 INFO，`LEGERE_LOG` 可覆盖（取值 `error|warn|info|debug|trace`，非法值回落 INFO 并 `warn!`）；输出到 `<app_data_dir>/logs/legere.YYYY-MM-DD.log`，滚动保留 7 天（02 §10）；结构化字段至少 `module`、`document_id`、`job_id`、`elapsed_ms`（02 §10）。具体滚动 crate 与 API 形态先按 V-02 核实版本，再按该版本 `cargo doc` 抄签名。

F-04 错误基类型：`src-tauri/src/contracts/error.rs` 落 05 §1 的 `ApiError` 与 `ApiErrorCode`（12 变体逐字对齐 05 §1 代码块）；用 `thiserror` 定义本模块领域错误 `FoundationError`，并在 `contracts/error.rs` 提供 `impl From<FoundationError> for ApiError`（`retriable` 按 05 §1 错误码语义表填）。

F-05 两个 Command（05 §3 #1、#2）：`ping` 返回 `{ ok: true, version }`；`app_info` 返回 `{ version, dataDir, dbPath, ftsEnabled, contentlessDelete }`。M01 阶段 `ftsEnabled`/`contentlessDelete` 从进程内 `OnceLock<DbCapabilities>` 读取，未接入时取默认 `false` 并 `warn!(target: "m01", event = "db_caps_unwired")`；**不得静默写死**，交付报告声明「由 M03 探针接管」。

F-06 `app://ready` 事件：在 `.setup()` 中日志初始化成功后 `emit` 一次（payload `{ version }`，05 §4 事件表第 1 行），重复启动逻辑不得重复发送。

F-07 `pdf://` 协议壳（05 §6）：注册 scheme `pdf`；路由规则 `pdf://doc/{documentId}?v={mtime_ms}`；实现 `GET`、`HEAD`；解析 `Range: bytes=start-[end]` 返回 `206` + `Content-Range`；无 Range 返回 `200` + 全量；响应头固定 `Content-Type: application/pdf`、`Accept-Ranges: bytes`、`Content-Length`。错误语义：id 非正整数 → `400`；文档不存在 → `404`；`PermissionDenied` → `403`。**只允许按 id 查表取路径，永不接受路径参数**（05 §6 安全性条目）。

F-08 协议壳的占位数据源：新增 `src-tauri/fixtures/sample.pdf`（仓库内固定样本，`%PDF-` 开头、≥ 1 页、≥ 1KB，可被浏览器直接打开）；`FixturePathResolver` 仅对 `id == 1` 返回该文件，其余 id 返回 `E_NOT_FOUND`（→404）。

F-09 测试环境：`vitest.config.ts`（`environment: "node"`，`include: ["src/**/*.test.ts"]`）；`src/test/env.test.ts` 一条冒烟断言证明 runner 可用；`src-tauri` 侧 `#[cfg(test)]` 覆盖 `parse_range`。前端不为跑通 vitest 引入 jsdom（本模块无可渲染组件需要）。

F-10 `package.json` 脚本：`dev`（`vite`）、`build`（`tsc --noEmit && vite build`）、`test`（`vitest`）、`check-contracts`（`node scripts/check-contracts.mjs`）、`tauri`（`tauri`）。`scripts/check-contracts.mjs` 本模块只放**诚实桩**：打印 `check-contracts: not implemented (owner: M02)` 并 `exit 0`，交付报告声明由 M02 接管。

## 5. 非目标（明确不做）

### 5.0 已由 Lead 裁决的技术参数（**不再询问，按此实现**）

以下条目曾标为「待你确认」，但属技术参数且**已由 Lead 按官方文档与工程判断裁决**：**T29** —— 明细与理由见 `docs/14-ui-decision-register.md` §1 对应行。实现时直接落该值，**不得**再当作待确认项停下来问；若你认为某条在本模块不成立，在交付报告 §9 提出并说明，不要自行改动。

1. 不建任何业务表、不写任何 SQL、不引入 `rusqlite`（属 M03）。
2. 不定义 05 §2 的完整 DTO 集合、不写 `CMD`/`EVT` 常量表、不写 `src/core/ipc.ts`（属 M02；本模块只放 `ping`/`app_info` 的两个最小返回结构与 F-10 桩脚本）。
3. 不解析 PDF 字节：协议壳只做「读文件 + 切片 + 写响应头」，不校验 PDF 结构（属 M05）。
4. 不实现扫描、监控、元数据提取、索引、搜索、书签、进度、设置（属 M03/M04/M09–M13）。
5. 不写任何 UI 布局与视觉：**不得自行确定视觉方案**；`App.tsx` 只允许一个无样式的文字按钮用于 IPC 冒烟，并留 `TODO(ui-confirm)`。
6. 不实现 `document_url` 之类的业务命令（属 M04）；协议壳读取的路径来源是 F-08 的占位实现。
7. 不改任何 `docs/` 契约文件；发现契约问题只写进交付报告。

8. 不得自行确定视觉方案；下面这份清单在本模块一律只留 `TODO(ui-confirm)` 占位，并在报告第 6 节逐条列出。

**本模块【待你确认】清单（不得自行选择）**

1. 【待你确认】窗口标题与初始/最小尺寸——建议标题 `Legere`、尺寸用 Tauri 默认、不设最小尺寸。
2. 【待你确认】空壳阶段是否需要启动画面/加载状态——建议不要，直接显示裸窗口。
3. 【待你确认】冒烟用临时按钮的文案与位置，以及是否允许它进入最终交付——建议允许，并在 M14 接入后由 M14 移除。
4. 【待你确认】日志目录是否可配置（默认 `<app_data_dir>/logs`）——建议不可配置，只用 `LEGERE_LOG` 调级别。
5. 【待你确认】是否在 UI 提供「打开日志目录」入口——属 M13/M14 界面职责，建议本模块不提供。

## 6. 架构约束

- 允许依赖：无项目内模块。第三方仅限 02 §1 表内技术（Tauri 2、tokio、serde、serde_json、tracing 系、thiserror）。新增 runtime 依赖需在报告说明理由与体积（_shared-context E.7）。
- 不允许依赖：任何 `src-tauri/src/{db,library,index,jobs,search,aux}/*`（尚未存在，也不得为它们预建空壳）；不在 Rust 侧引入前端类型（02 §2 规则 4）。
- 资源所有权：`pdf://` 处理器不得长期持有文件句柄（每次请求内打开并用完即释放）；日志 `LogGuard` 必须在 `run()` 生命周期内存活，提前 drop 会丢尾部日志。
- 文件归属（03 §4）：`src-tauri/src/main.rs`、`lib.rs` 属 M01，后续模块只能以「注册一行」方式追加并在报告声明。`src-tauri/src/contracts/*` 属 M02——**M01 是这些文件的首个创建者**（`contracts/mod.rs`、`contracts/error.rs`、`contracts/app_info.rs`），创建后即移交 M02 接管，交付报告必须显式声明该越界创建行为及理由（M01 的 Command 必须返回 `ApiError`）。除这三个文件外不得在 `contracts/` 下新增文件。
- 不负责清单：表结构、PDF 解析、UI 布局、业务命令、索引与检索。
- 边界线：本模块结束处，`pdf://` 的「读字节/写响应」归 M01，「id→路径」归 M04，二者通过 F-08 的 trait 缝合。

## 7. 输入与输出

| 输入来源 | 数据形态 | 触发时机 |
|---|---|---|
| 前端 `invoke` | 单对象参数（05 §3 约束 1） | 用户/前端主动调用 |
| WebView `fetch(pdf://…)` | HTTP 请求（含 `Range` 头） | PDF 引擎加载文档（M05） |
| 进程环境变量 | `LEGERE_LOG` 字符串 | 进程启动 |
| Tauri 运行时 | `app_data_dir()` 路径 | `setup()` 内 |

| 输出目标 | 数据形态 | 消费方 |
|---|---|---|
| 前端（invoke 返回） | `PingResult` / `AppInfoDto` / `ApiError` | M02 的 `call<T>()`、M14 |
| 前端（事件） | `app://ready` payload `{ version }` | M14 启动编排 |
| WebView（协议响应） | `200/206/400/403/404` + PDF 字节 + 头部 | M05 pdf-engine |
| 文件系统 | 滚动日志文件 | 开发者/用户诊断 |
| 其他模块 | `DocumentPathResolver` 注入点、`LogGuard`、`ApiError` 基类型 | M04、全部后端模块 |

## 8. 接口契约

**Command（05 §3 表第 1、2 行 / L172–L173 原文）**

```rust
// 05 §3 #1：ping  | 入参 — | 返回 { ok: true, version: string } | 错误码 E_INTERNAL | 归属 M01
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResult { pub ok: bool, pub version: String }
#[tauri::command]
pub async fn ping() -> Result<PingResult, ApiError>;

// 05 §3 #2：app_info | 入参 — | 返回 { version, dataDir, dbPath, ftsEnabled, contentlessDelete } | E_INTERNAL | M01/M03
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfoDto {
    pub version: String, pub data_dir: String, pub db_path: String,
    pub fts_enabled: bool, pub contentless_delete: bool,
}
#[tauri::command]
pub async fn app_info() -> Result<AppInfoDto, ApiError>;
```

注：05 只规定了 `app_info` 的返回字段、未给结构体名；本模块定名 `AppInfoDto` 并在报告中声明，M02 冻结时沿用。

**事件（05 §4 表第 1 行 / L214 原文）**

```ts
"app://ready" // payload { version: string }；发送方 M01；节流：一次
```

**本模块新增的内部接口（契约未定义，需在报告中列出）**

```rust
// src-tauri/src/protocol/range.rs
pub enum ByteRange { Full, Span { start: u64, end_incl: u64 } }
pub fn parse_range(header: Option<&str>, total_len: u64) -> Result<ByteRange, RangeError>;
pub enum RangeError { Syntax, Unsatisfiable }  // 分别映射 400 / 416

// src-tauri/src/protocol/resolver.rs —— M04 接管此 trait 的实现
pub trait DocumentPathResolver: Send + Sync {
    fn resolve(&self, document_id: i64) -> Result<std::path::PathBuf, ApiError>;
}

// src-tauri/src/log.rs
pub struct AppConfig { pub log_level: LogLevel, pub data_dir: std::path::PathBuf }   // 03 §2 M01 关键数据结构
pub fn init_logging(cfg: &AppConfig) -> Result<LogGuard, ApiError>;
```

**未决契约细节（不得自行改契约，按推荐值实现并标 `TODO(contract-confirm)`）**：越界 Range 的响应码，契约（05 §6）未定义，推荐 `416` + `Content-Range: bytes */{len}`；`?v=` 参数是否参与校验，推荐仅透传缓存键、不参与路径解析。

## 9. 数据结构

| 名称 | 定义位置 | 字段/说明 |
|---|---|---|
| `ApiError` | `contracts/error.rs` | `code: ApiErrorCode`、`message: String`（中文短句）、`detail: Option<String>`、`retriable: bool`——逐字对齐 05 §1 / L10–L16 |
| `ApiErrorCode` | 同上 | 12 变体：`E_INVALID_ARG E_NOT_FOUND E_DB E_IO E_PERMISSION E_PDF_CORRUPT E_PDF_ENCRYPTED E_PDF_NO_TEXT E_BUSY E_UNSUPPORTED E_CANCELED E_INTERNAL`（05 §1 / L19–L23）；`Serialize` 输出即为码串，**不加** `rename_all` |
| `PingResult`/`AppInfoDto` | `contracts/app_info.rs` | 见 §8 |
| `AppConfig` | `log.rs` | `log_level`、`data_dir`（03 §2 M01） |
| `LogGuard` | `log.rs` | 持有非阻塞写线程句柄，drop 时 flush |
| `ByteRange`/`RangeError` | `protocol/range.rs` | 纯值类型，无 IO，可单测 |
| `DbCapabilities` | 暂用 `{ fts5: bool, contentless_delete: bool }` | 03 §2 M03 定义的输出类型；M01 只放占位定义于 `contracts/app_info.rs`，M03 迁移到 `db/caps.rs` 时保留字段名 |

## 10. 文件组织

```text
src-tauri/
├── Cargo.toml                 # 依赖与 feature（tauri 2、tokio、serde、tracing 系、thiserror）
├── rust-toolchain.toml        # 固定 stable channel
├── tauri.conf.json            # 窗口与构建配置（视觉项留 TODO(ui-confirm)）
├── build.rs
├── fixtures/sample.pdf        # 协议壳占位样本（F-08）
└── src/
    ├── main.rs                # 仅调用 legere_lib::run()
    ├── lib.rs                 # Builder 装配：命令注册、协议注册、setup 里的日志与事件
    ├── log.rs                 # init_logging / LogGuard / AppConfig
    ├── commands/mod.rs        # ping、app_info
    ├── contracts/mod.rs       # 契约模块门面（M02 接管）
    ├── contracts/error.rs     # ApiError / ApiErrorCode / From<FoundationError>
    ├── contracts/app_info.rs  # PingResult / AppInfoDto / DbCapabilities 占位
    └── protocol/
        ├── mod.rs             # pdf scheme 注册与请求分发
        ├── range.rs           # parse_range 纯函数 + 单元测试
        └── resolver.rs        # DocumentPathResolver trait + FixturePathResolver
src/
├── main.tsx / App.tsx         # 仅 IPC 冒烟入口，无样式
├── lib/ipc-probe.ts           # 临时 invoke 封装（M02 的 ipc.ts 就绪后移除调用点）
└── test/env.test.ts           # vitest 冒烟
scripts/check-contracts.mjs    # 诚实桩（M02 接管）
package.json / vite.config.ts / vitest.config.ts / tsconfig.json
```

## 11. 实施步骤

1. **脚手架**：生成工程 → `pnpm install` → `cargo build` 通过 → `cargo tauri dev` 能起空窗口（此时无任何业务代码）。判据：窗口出现、控制台无 panic。
2. **通信回路（invoke）**：加 `ping`（先返回硬编码 version 常量 `CARGO_PKG_VERSION`，这是真实值不是伪造）→ 前端文字按钮调用并 `console.log`。判据：控制台打印 `{ ok: true, version: "0.x.y" }`。
3. **通信回路（事件）**：`.setup()` 内 `emit("app://ready", { version })`，前端 `listen` 计数。判据：`app://ready` 恰好收到 1 次。
4. **日志**：接 `init_logging`，把步骤 2/3 的日志改为 `tracing::info!`。判据：`<dataDir>/logs/` 出现当日文件且含 `ping` 记录；`LEGERE_LOG=debug` 时出现 debug 行。
5. **错误**：落 `ApiError`/`ApiErrorCode`；给 `ping` 加一个「version 为空则返回 `E_INTERNAL`」的内部断言路径，前端验证错误对象可被归一化为 `{ code, message, detail, retriable }`。判据：抛出的错误是对象而非字符串。
6. **协议壳**：先按 V-06 写最小 handler（只打印 `req.uri()`、回 200 空体）→ 记录真实 URI 形态 → 再加 `parse_range` 与样本文件 → 最后补 404/403/400。判据：`fetch` 带 `Range: bytes=0-99` 得 `206` 与 `Content-Range: bytes 0-99/{total}`。
7. **测试环境**：vitest 配置 + `env.test.ts`；`parse_range` 的 `#[cfg(test)]` 用例（见 §12）。判据：两条测试命令均绿。
8. **冒烟与收尾**：按 §13 逐条跑，把结果与命令输出摘要写进交付报告；声明 `contracts/` 首次创建、`check-contracts.mjs` 为桩。

## 12. 测试要求

**Rust 单元（`src-tauri/src/protocol/range.rs`）**，`total_len = 1000`：

| 输入 `Range` | 期望 |
|---|---|
| `None` | `Ok(Full)` |
| `Some("bytes=0-")` | `Ok(Span { start: 0, end_incl: 999 })` |
| `Some("bytes=100-199")` | `Ok(Span { start: 100, end_incl: 199 })` |
| `Some("bytes=-500")` | `Ok(Span { start: 500, end_incl: 999 })`（后缀语义） |
| `Some("bytes=500-")` | `Ok(Span { start: 500, end_incl: 999 })` |
| `Some("bytes=abc")` / `Some("")` | `Err(Syntax)` → 400 |
| `Some("bytes=2000-")` | `Err(Unsatisfiable)` → 416（推荐值，见 §8 未决项） |
| `Some("bytes=199-100")` | `Err(Syntax)`（end < start） |

另外两条：`init_logging` 在临时目录生成文件（`tempfile` 作为 dev-dependency，体积可忽略，报告中说明）；`app_info` 在未接入探针时 `fts_enabled == false` 且写出一条 `db_caps_unwired` 警告（用 `tracing-test` 或子进程捕获均可，做不到就在报告写「未验证」）。

**前端（vitest）**：`src/test/env.test.ts` 断言 `import.meta.env.MODE === "test"`。

**命令**：`cargo test --manifest-path src-tauri/Cargo.toml`、`cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`、`pnpm test -- --run`、`node scripts/check-contracts.mjs`。

**边界/错误路径各一例**：Range 越界（上表 2000-）；`pdf://doc/999` → 404；`pdf://doc/abc` → 400。

## 13. 验收标准

1. `cargo tauri dev` 起得来：窗口出现，控制台无 panic、无 `.unwrap()` panic 栈。
2. `ping` 往返成功：前端日志出现 `{ ok: true, version: "<与 Cargo.toml 一致>" }`。
3. `fetch("pdf://doc/1", { headers: { Range: "bytes=0-99" } })` → `status === 206`，`Content-Range` 为 `bytes 0-99/<len>`，`Content-Type: application/pdf`，`Accept-Ranges: bytes`，`Content-Length` 与切片长度一致。
4. 无 Range 请求 `pdf://doc/1` → `200` 且字节数 == 文件大小；`HEAD` 不返回 body。
5. `pdf://doc/999` → `404`；`pdf://doc/abc` → `400`。
6. `app://ready` 只收到 1 次；payload 含 `version`。
7. `cargo test` 全绿（含 §12 全部 `parse_range` 用例）；`pnpm test -- --run` 全绿。
8. 日志文件生成在 `app_info.dataDir` 下的 `logs/` 目录，含当日文件；`LEGERE_LOG=debug` 时条目增多。
9. `node scripts/check-contracts.mjs` 退出码 0 且打印 `not implemented (owner: M02)`（M01 阶段判据；M02 完成后此脚本换成真实检查）。
10. `cargo clippy -D warnings` 通过；`src-tauri/Cargo.toml` 中所有版本号均来自 V-02 实测，且已写入报告。

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

## 15. 禁止事项

## H. 禁止事项（任一项出现即视为交付失败）

1. 修改其他模块的文件或接口契约（见 03 的文件归属矩阵）。
2. 引入未经批准的架构变更或新的大型依赖。
3. 为通过验收而伪造实现、硬编码返回值、把未实现功能写成已完成。
4. 删除或破坏已有测试；降低既有断言以"通过"。
5. 长时间保留 mock 数据源而不接真实接口。
6. 越界实现其他模块职责（宁可返回"需要 M0x 提供"也不要自己造）。
7. 用 `display:none` 等手段"隐藏"本该完全不渲染的节点。

本模块补充禁令：

1. 不得创建任何业务表或 `src-tauri/src/db/`、`library/`、`index/`、`jobs/`、`search/`、`aux/` 目录与文件（03 §4 文件归属）。
2. 不得在 `pdf://` 处理器里解析 PDF 结构、读取页数或做任何 `pageCount` 判断——那是 M05 的事。
3. 不得为了让 Range 验收通过而硬编码 `Content-Range`/`Content-Length` 常量，必须由真实文件长度计算。
4. 不得把 `app_info` 的 `ftsEnabled`/`contentlessDelete` 写成固定 `true`；未接入探针就返回 `false` 并留 `TODO(m03-probe)`。
5. 不得自行决定窗口尺寸、标题栏样式、启动页、主题色或任何排版——一律 `TODO(ui-confirm)` 并进交付报告第 6 节。
6. 不得修改 `docs/02`–`docs/05`、`docs/13`、`_template.md`、`_shared-context.md`；发现问题写进报告第 9 节。