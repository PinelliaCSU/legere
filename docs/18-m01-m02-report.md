# 18 · M01 + M02 实施报告

**status: blocked**（代码与契约检查已就绪；构建与 `pdf://` 探针无法执行 —— 本机缺 Rust 工具链且无外网）

## 1. 本轮完成的事

1. 回填 A1–A5 五条用户决策（见 §2）。
2. 裁决 D0 / B1–B5 / V1 及 A1–A5 未覆盖的残留（见 §3）。
3. 落地 M01（工程骨架 + `pdf://` 协议壳 + 日志 + 错误基座 + 冒烟壳）与 M02（Rust/TS 双侧 DTO、Command 与事件注册表、IPC 客户端、契约一致性脚本）。

## 2. 回填清单

| 条目 | 落点 | 写入内容 |
|---|---|---|
| A1 | `module-prompts/13-theme-settings.md §7.2-5`、§7 第 7 条 | 用户原话照录 + 实现含义：`route = reader` 时 `SettingsPanel` 与设置入口一律不渲染、不可达；`Esc` 退出后可用 |
| A2 | `13-theme-settings.md §7.2-6` | 「不加入过渡动效。」+ `transition: none`（不得给 CSS 变量或背景加 transition） |
| A3 | `14-workspace-shell.md §7.3 A-3`、`16-copy-deck.md §8` | 「不做引导。」不实现引导层/气泡/遮罩/高亮提示 |
| A4 | `14-workspace-shell.md §7.3 A-4`、`16-copy-deck.md §6` | 「作者、阅读进度。」缺作者时只显示阅读进度 |
| A5 | `10-job-orchestrator.md §4`、`14-workspace-shell.md §7.3 A-5`、`16-copy-deck.md §8` | 「给出提示即可。」终态仍写 `error_code/error_msg` 并发事件；不做逐条原因列表或详情面板 |

`TODO(ui-confirm)` / `TODO(copy)` 已在这四处清除；`16-copy-deck.md §8` 由「未收录项」改为「已裁决，无待定」。

## 3. 裁决清单

| 条目 | 裁决 | 依据 |
|---|---|---|
| D0 | 下发授权成立，按 M01 → M02 串行开工 | 用户明确「编码从 M01 + M02 骨架开始」 |
| B1 · M05 | 除 T12 外不新增（已把 T12 两项写入 M05 §5.0） | 逐条比对 T1–T30，仅 T12 命中引擎职责 |
| B2 · M06 | **回灌 T16**（LOD 预览；>200% 禁止拉伸） | T16 定义 `PageRenderState.scale` 语义（契约 R5），是 M06 实现参数 |
| B3 · M08 | 不新增 | 其待确认项均属视觉，已由 D21/D22 覆盖 |
| B4 · M09 | 不新增 | T19 属检索侧，已回灌 M11 |
| B5 · T12 | 拆两处：密码框 + 旋转页 → M05；页面热区 → M07 | 三小项分属引擎与交互职责 |
| V1 | **(a) 推迟到 M13/M14 首次出界面时验证** | 边界条件禁止引入决策外的新需求；(b) 的令牌预览页属新增需求 |
| M13 残留 | 默认主题 `light`；跟随系统但仅首次 | 沿用 M13 占位值；T13 已登记 |
| M01 残留 | 标题 `Legere` / 1280×860 / 最小 960×640；不做启动画面；冒烟 UI 仅 dev；日志目录固定、级别由 `LEGERE_LOG` 调 | 均为最小假设，单点可改；详见 `14-ui-decision-register.md §4.2` |

## 4. 代码：已完成

**M01（12 个 Rust 文件 + 6 个前端/配置文件）**

- `src-tauri/src/lib.rs`：装配日志、`app://ready`、`pdf://` 协议、`invoke_handler`。
- `src-tauri/src/protocol/{mod,range}.rs`：Range 判定按契约 R15（语法非法 400 / `start >= size` 416 + `bytes */size` / `end` 越界夹取 206 / 跨度 > 8 MiB 截断 206）；URI 同时接受 `pdf://doc/N` 与 `http://pdf.localhost/doc/N`（V-06 未定时不假设单一形态）。
- `src-tauri/src/logging.rs`：`tracing` + 每日滚动 + 7 天清理 + `LEGERE_LOG`。
- `src-tauri/src/error.rs`：`ApiError`/`ApiErrorCode`(12) + `DomainError` → `ApiError` 映射。
- `src-tauri/src/commands/mod.rs`：`ping`、`app_info`（占位值显式标注，`ftsEnabled=false`、`textEngine=none`，不伪装就绪）。
- `src-tauri/assets/sample.pdf`：脚本生成的 603 字节合法 PDF，xref 偏移自校验通过。

**M02（9 个 TS/RS 契约文件 + 1 个检查脚本）**

- `src/contracts/{errors,types,cmd,evt,index}.ts`：12 错误码 + 文案表、18 个 DTO、28 条 Command、5 个事件。
- `src-tauri/src/contracts/{dto,cmd,evt}.rs`：与 TS 逐字段镜像（`serde(rename_all="camelCase")`，错误码与枚举显式 rename）。
- `src/core/ipc.ts`：`call<T>`（超时 + `ApiError` 归一化）、`subscribe`（同事件订阅去重）。
- `scripts/check-contracts.mjs`：纯 Node，比对 DTO 字段 / Command 名 / 错误码三组。

## 5. 验证证据

```text
$ node scripts/make-sample-pdf.mjs
sample.pdf 已生成: ...\src-tauri\assets\sample.pdf (603 bytes, 5 objects, xref @ 416)

$ node scripts/check-contracts.mjs   # exit 0
比对 DTO 类型数: 18
Command: TS 28 / Rust 28
错误码: TS 12 / Rust 12
契约一致 ✓
```

## 6. 未验证（阻塞项，必须补齐后才可宣称 M01 验收通过）

| 项 | 原因 | 补齐方式 |
|---|---|---|
| `cargo build` / `cargo test`（含 `range.rs` 8 条单测） | 本机 **无 cargo/rustc**（`Get-Command` 确认缺失，`%USERPROFILE%\.cargo\bin` 不存在） | 安装 Rust stable 后执行 `cd src-tauri && cargo test` |
| `pdf://` 的 206 + Range 实测（本轮验证目标 ①） | 依赖构建产物 + 运行中的应用；且 V-06 的真实 URL 形态未测 | 装好工具链后按 M01 §11 步骤 1 的探针执行，回填 `docs/02 §1` 的 V-06 |
| `pnpm install` / `tsc --noEmit` / `vite build` | 本机 **无外网**（`registry.npmjs.org` 连接失败） | 有网后执行 `pnpm install && pnpm typecheck` |
| 45 个色值的真实界面观感（本轮验证目标 ②） | 按 V1 裁决 (a) 推迟到 M13/M14 | 不属 M01/M02 的验收范围 |

## 7. 对后续模块的影响

- M03/M04/M09 接入后，须把 `commands::app_info` 的占位值替换为真实能力（`ftsEnabled`/`contentlessDelete`/`textEngine`）。
- `invoke_handler` 目前只注册 `ping`/`app_info` 两条；M02 的「注册集合 == `CMD` 集合」验收要等全部模块落地，属**计划内阶段缺口**，不得当作已通过。
- `lib.rs` 的 `pdf://` handler 现返回内置样本；M04 提供 `DocumentPathResolver` 后替换为真实文件读取。
- 冒烟壳 `src/App.tsx` 在 M14 接入 `AppShell` 时删除。

---

## 8. 第二轮执行记录（Rust 环境就绪后，2026-11-18）

**status: 部分通过**（编译/单测/类型检查通过；端到端 `pdf://` 取证被宿主环境阻塞）

### 8.1 环境实况（实测）

| 项 | 结果 |
|---|---|
| `cargo` | 1.100.0（不在本进程 PATH，实际路径 `C:\Users\Lenovo\.cargo\bin\cargo.exe`） |
| `rustc` | 1.100.0 |
| `pnpm` | 10.26.1；registry 已指向 `https://registry.npmmirror.com` |
| `git` | 2.47.0.windows.2（配 `http.proxy=127.0.0.1:7890`） |
| crates.io 直连 | **失败**：`[35] schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`。curl 同样失败，git（OpenSSL）与 node fetch 正常 ⇒ 本机进程不可用 Windows Schannel |
| npm registry 直连 | HTTPS 同样受 schannel 限制；pnpm 走镜像正常 |

构建期绕过（不改产品代码）：`scripts/cargo-http-mirror.mjs` 起本地 HTTP 镜像（Node TLS 转发 crates.io），配合 `.cargo/config.toml`（已 gitignore）与工作区内 `CARGO_HOME`（沙箱禁止写工作区外路径）。

### 8.2 命令与结果

```text
$ pnpm install                       -> exit 0（132 包，10.6s）
$ pnpm typecheck (tsc --noEmit)      -> exit 0（无输出）
$ cargo build                        -> Finished dev profile in 33.99s
$ cargo test                         -> 13 passed; 0 failed（exit 0）
$ node scripts/check-contracts.mjs   -> exit 0（18 DTO / 28 Command / 12 错误码一致）
```

**过程中修掉的真实缺陷（1 个）**：`pdf://doc/17` 中 `doc` 是 **authority** 而非路径段，原实现把它当路径 → 返回 `400`。
修正后同时支持 `pdf://doc/17` 与 `http://pdf.localhost/doc/17`，并补 9 条 URI 回归断言（总测试 13 条）。

**其他构建阻塞（已解决）**：`tauri-build` 要求 `icons/icon.ico`；PNG-in-ICO 会被判 `muda::icon::BadIcon`，改为经典 BMP(DIB) 32bpp 多尺寸 ICO（16/32/48/64/128/256）后通过。图标为**中性灰占位**，正式图标待用户提供。

### 8.3 验证目标 ①（`pdf://` 的 206 + Range）——**未取得**

- 现象：`WebviewWindowBuilder::build()` → `Io(Os { code: 5, kind: PermissionDenied })`；失败发生在 Tauri 内部 setup（先建窗、后跑用户 setup），面包屑证明用户 setup 从未进入。
- 排除：WebView2 运行时已装（157.0.4341.46）；`%LOCALAPPDATA%` 可写；WinForms 窗口可创建；`WEBVIEW2_USER_DATA_FOLDER` 指向工作区亦无效。
- 结论：宿主环境限制，非代码缺陷。取证点已就位（handler 以 INFO 记录 uri/range/status/content-range），换到有桌面 WebView2 权限的机器即可一次关闭 V-06。
- **不得**把「13 条单测通过」表述为「206 取证通过」。

### 8.4 验证目标 ②（45 个色值观感）

按 V1 裁决 (a) 推迟到 M13/M14；本轮未做，也不属 M01/M02 验收范围。

### 8.5 仍未验证

- `pnpm build` / `vite build`：esbuild 的 postinstall 与服务需要 piped stdio 子进程，本会话禁止（`spawn EPERM`）；`node_modules` 中 `picomatch` 亦未落盘。**前端打包链路未验证**（`tsc --noEmit` 已覆盖类型正确性）。
- 端到端 GUI：同上（WebView2 被拒）。

---

## 9. M03 首片（数据库内核）执行记录（2026-11-18）

**status: ready**（构建与 20 条单测全绿）

### 9.1 交付内容

| 文件 | 作用 |
|---|---|
| `src-tauri/migrations/001_init.sql` | 8 张表 + FTS5 虚表，含 R17 的 `abs_path_key`/`rel_path_key` |
| `src-tauri/src/db/mod.rs` | 打开库、PRAGMA（WAL/foreign_keys/busy_timeout/synchronous）、迁移（只增不改 + 幂等）、写连接串行化、只读连接、UTC 时间格式化 |
| `src-tauri/src/db/probe.rs` | FTS5 与 `contentless_delete` 能力探针（V-03 的实现侧） |
| `src-tauri/src/db/repo.rs` | `LibraryRootRepo`/`DocumentRepo`/`SettingsRepo` + `insert_page_with_fts`/`delete_document_index`（rowid 绑定的唯一实现点） |
| `src-tauri/src/db/integrity.rs` | 一致性自检（只报告不修改） |
| `src-tauri/src/db/tests.rs` | 7 条测试：迁移幂等、能力探针、库根 CRUD、路径 key 大小写、软删除、FTS rowid 绑定与级联、设置往返 |
| `commands::app_info` | `ftsEnabled`/`contentlessDelete` 改为来自真实探针（不再是占位） |
| `commands::db_integrity_check` | 新增，对应契约 §3 第 28 行 |

### 9.2 命令与结果

```text
$ cargo build      -> Finished dev profile
$ cargo test       -> 20 passed; 0 failed（exit 0）
$ pnpm typecheck   -> exit 0
$ node scripts/check-contracts.mjs -> 18 DTO / 28 Command / 12 错误码一致（exit 0）
```

### 9.3 过程中修掉的两个真实缺陷

1. **迁移脚本与代码重复建表**：001 里 `CREATE TABLE schema_migrations` 与 `run_migrations` 的 `CREATE TABLE IF NOT EXISTS` 冲突，导致所有 DB 测试失败。已改为「只由代码建表」，并在 docs/04 §5 记下该坑。
2. **`io_err` 类型推断失败**：`DomainError::Io(err).into()` 在没有上下文时无法推断目标类型，改为显式 `let api: ApiError = ...`。

### 9.4 本机环境补充事实（影响后续模块）

- `rusqlite` bundled 需要通过 MSVC 编译 SQLite；本机 `cl.exe` 在默认 `TEMP`（`%LOCALAPPDATA%\Temp`）下报 `D8050（无法执行 c1.dll：未能将命令行放入调试记录中）`。把 `TMP`/`TEMP` 指到工作区 `.tmp/` 后编译正常。CI 与其它机器若遇同样错误，按此处理。
- 编译 SQLite 时开启了 `SQLITE_ENABLE_FTS5`（cc-rs 输出的宏里有 `-DSQLITE_ENABLE_FTS5`），与 04 §7 依赖一致。

---

## 10. 环境问题收敛记录（2026-11-18 第二轮）

**结论：三项必验全部通过，V-06 已关闭，无需用户介入。**

### 10.1 四个环境坑与解法（均为本机/本会话特性，不是代码问题）

| # | 现象 | 根因 | 解法 |
|---|---|---|---|
| 1 | `cargo` 拉 crates 失败 `schannel: SEC_E_NO_CREDENTIALS` | 本机进程不可用 Windows Schannel（curl 同样失败；git/OpenSSL、node fetch 正常） | `scripts/cargo-http-mirror.mjs` 起本地 HTTP 镜像（Node TLS 转发 crates.io）+ 项目级 `.cargo/config.toml`（已 gitignore） |
| 2 | `cargo` 写注册表缓存失败 `os error 5` | 沙箱禁止写工作区外 `~/.cargo` | `CARGO_HOME=<workspace>/.cargo-home` |
| 3 | `libsqlite3-sys` 编译失败 `cl.exe D8050` | 默认 `TEMP` 下 cl 无法写调试记录 | `TMP`/`TEMP` 指到 `<workspace>/.tmp` |
| 4 | 应用启动即 `window build failed: Io(code 5)`，日志/数据库初始化也报 `拒绝访问` | 工具派生的子进程无法写 `%APPDATA%`/`%LOCALAPPDATA%`，WebView2 因此无法建环境；计划任务方式落到 session 0（无窗口站）同样失败 | 把三类目录全部改为可覆盖：`LEGERE_DATA_DIR`（数据库）、`LEGERE_LOG_DIR`（日志）、`LEGERE_WEBVIEW_DATA_DIR`（WebView2 数据目录），并把窗口改为**程序化创建**（配置声明的窗口无法传 data_directory） |

### 10.2 对产品代码的两处正当修改

1. **窗口改为代码创建**（`lib.rs` 常量 + `WebviewWindowBuilder`），因为 `tauri.conf.json` 的窗口项不支持 `data_directory`，而便携模式/受限环境必须能指定 WebView2 数据目录。标题与尺寸仍沿用已裁决策略（Legere / 1280×860 / 最小 960×640）。
2. **三个目录环境变量**：默认值不变（appDataDir），仅在显式设置时覆盖。用途：便携模式与受限环境调试；已写入本节，不成为产品交互面。

### 10.3 V-06 取证（真实运行日志）

```text
pdf:// 请求进入 uri=pdf://localhost/doc/1 range=None method=GET
pdf:// 响应     status=200 content_range=None body_len=599
pdf:// 请求进入 uri=pdf://localhost/doc/1 range=Some("bytes=0-9") method=GET
pdf:// 响应     status=206 content_range=Some("bytes 0-9/599") body_len=10
```

- Windows 真实形态 = `pdf://localhost/doc/{id}`（已加回归断言）。
- Range 端到端生效：206 + `Content-Range: bytes 0-9/599`。
- 结论已回填 `docs/02 §1` 的 V-06 行。

### 10.4 本轮验证命令汇总

```text
$ pnpm install --force        -> exit 0（node_modules 重建后 esbuild/picomatch 才落盘）
$ pnpm build                  -> ✓ 36 modules transformed, built in 976ms
$ pnpm typecheck              -> exit 0
$ node scripts/check-contracts.mjs -> 契约一致（exit 0）
$ cargo build                 -> Finished
$ cargo test                  -> 20 passed; 0 failed
$ 运行应用（受限环境变量）      -> 窗口已创建；pdf:// 200/206 均有日志
```

### 10.5 仍属环境限制、但不影响交付的项

- `cargo build --release` 曾在编辑 `lib.rs` 期间被中断（exit 1），未重跑；release 打包属 M15，届时执行。
- 桌面窗口只在本会话外（用户真实桌面）具备完整观感；本会话内的窗口截图不可靠，45 个色值的**观感**验证仍按 V1(a) 推迟到 M13/M14。
