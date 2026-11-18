# 17 · 交付说明（下发给编程 Agent）

> 版本：v1（基于 34 份文档、15 份模块 Prompt、28 条决策已定、30 条技术裁决已回灌的现状）。
> 本文件只做**下发与约束说明**，不改写任何 Prompt 内容，也不新增任何需求。

## 1. 交付清单

| 模块编号 | Prompt 文件名 | 15 节齐全 | §5.0 已回灌 |
|---|---|---|---|
| M01 | `module-prompts/01-foundation.md` | 是 | 是（T29） |
| M02 | `module-prompts/02-contracts.md` | 是 | 是（T1 T2 T3 T4 T5） |
| M03 | `module-prompts/03-database.md` | 是 | 是（T6 T7） |
| M04 | `module-prompts/04-library.md` | 是 | 是（T22 T23 T24 T25 T26） |
| M05 | `module-prompts/05-pdf-engine.md` | 是 | **否**（待补充：核实是否有应指派的 T 项） |
| M06 | `module-prompts/06-render-scheduler.md` | 是 | **否**（待补充：核实 T16 缩放 LOD 是否回灌） |
| M07 | `module-prompts/07-reader-interaction.md` | 是 | 是（T14 T15 T16 T21） |
| M08 | `module-prompts/08-doc-search.md` | 是 | **否**（待补充：核实是否有应指派的 T 项） |
| M09 | `module-prompts/09-text-index.md` | 是 | **否**（待补充：核实是否有应指派的 T 项） |
| M10 | `module-prompts/10-job-orchestrator.md` | 是 | 是（T17 T23） |
| M11 | `module-prompts/11-global-search.md` | 是 | 是（T19 T20 T21） |
| M12 | `module-prompts/12-bookmarks-progress.md` | 是 | 是（T9） |
| M13 | `module-prompts/13-theme-settings.md` | 是 | 是（T10 T11 T13） |
| M14 | `module-prompts/14-workspace-shell.md` | 是 | 是（T18 T21） |
| M15 | `module-prompts/15-integration-release.md` | 是 | 是（T27 T28 T30） |

15/15 在列；「15 节齐全」逐份经机器核对（`## 1.`–`## 15.` 各出现一次，缺节数 0）。

## 2. 执行约束（每个编程 Agent 必须遵守）

**读取顺序（严格按此顺序，读完再动手）**

1. `docs/module-prompts/_shared-context.md` —— 项目背景、技术栈、冻结契约索引、工程规范、UI 纪律、禁止事项、报告格式。
2. 你被派发的那**一份**模块 Prompt（15 节）。
3. 该 Prompt 显式引用的契约：`docs/02`（架构/决策/待验证项）、`docs/03`（边界与文件归属）、`docs/04`（数据库）、`docs/05`（API 契约，含 §13 修订记录 R1–R20）。
4. 按模块按需：`docs/13-ui-home-concept.md`（M14 必读）、`docs/15-theme-tokens.md`（M05/M06/M07/M08/M13/M14 必读）、`docs/16-copy-deck.md`（凡产出用户可见文字）。
5. 需要背景时才读 `master_plan.md` 的对应节，不要通读。

**适用范围**

- 一份 Prompt 只对应一个模块；只允许改 `docs/03 §4` 归属矩阵里属于你的路径。
- 需要别的模块提供新接口 → 在交付报告「对其他模块的影响」里提出，不要改别人的文件（`docs/03 §5`）。

**§5.0 执行规则（重要）**

- §5.0 列出的技术参数**已由 Lead 裁决**：直接落值实现，**不要停下来问**。
- 若你认为某条在你的模块里不成立 → 在交付报告 §9「契约问题」写明理由与证据，**不得自行改值**。
- §5.0 未覆盖、但 Prompt 里标了「【待你确认】」的项 → 见 §3，一律留 `TODO(ui-confirm)` / `TODO(copy)` 占位并在报告 §6 列出，**不得自行定值**。

**交付报告**

- 必须用 `_shared-context.md §I` 的 9 节格式，逐节填。
- 「已验证」必须附命令与输出摘要；没验证的写「未验证」，禁止把未验证写成已完成。

**契约变更**

- 任何 DTO/表/Command/事件/错误码的改动 = 架构变更：先报，等 Lead 批准，再由 Lead 登记进 `docs/05 §13` 修订记录（R21 起）。禁止在代码里悄悄改。

## 3. 已知未决项（**不阻塞开工**）

**A. 5 条视觉/交互残留**（用户已知并同意先开工）

1. 设置面板各分区内的控件形态细节（M13）
2. 主题切换是否加过渡动效（M13）
3. 首次使用的发现性提示形态（M14，无工具栏方案下"控件在哪"）
4. 书脊悬停 tooltip 的文案（M14）
5. 索引失败逐条原因的展示形式（M10/M14）

处理方式：遇到即留 `TODO(ui-confirm)` 占位（第 4 条留 `TODO(copy)`），按现有结构把能做的做完，在交付报告 §6 列出并附你的建议选项。**不要因此停工，也不要自己拍板。**

**B. 4 份 Prompt 的 §5.0 缺口**（见 §1 表格）

M05 / M06 / M08 / M09 未回灌 §5.0。经核对，这四份的待确认条目主要是视觉类或已在 §5 非目标中处理；但 T12（加密 PDF 密码框 / 旋转页 / 页面热区）与 T16（缩放 LOD）分别与 M05/M06 相关 —— **(待补充：是否把 T12/T16 回灌进 05/06)**。在这条落定前，M05/M06 的 Agent 遇到这两处按 Prompt 原样留 `TODO(ui-confirm)` 并在报告 §6 提出。

**C. 不在本次下发范围**

`【待你确认】` 全文仍有 86 处命中，其中绝大多数是历史引用与「已裁决」说明里的字样，不构成待办；真正需要决策的只有 A 组 5 条 + B 组 1 条。

## 4. 首批任务：M01 + M02（串行，不得同时开工）

授权状态：**已授权**（用户本次明确「编码从 M01 + M02 骨架开始」）。下发动作本身待用户确认本说明后执行。

### 第 1 步 · M01 foundation（完成后验收通过才进第 2 步）

- 下发：`module-prompts/01-foundation.md`（332 行，15 节齐全，§5.0=T29）。
- 本轮唯一新增验证目标 ①：**`pdf://` 能否返回 206 + Range**
  - 判据（照 Prompt 内 V-06 探针执行）：最小 protocol handler 打印 `req.uri()` 记录 Windows 上真实 URL 形态；`fetch` 带 `Range: bytes=0-99` → 必须 `206` 且带 `Content-Range: bytes 0-99/{size}`；`start >= size` → `416` + `Content-Range: bytes */{size}`；语法非法 → `400`（契约 `docs/05 §6` / R15）。
  - 证据：命令 + 状态码 + 响应头原文，写进报告 §5。失败则记录真实状态码与形态，不要改成「已通过」。
- 交付报告按 9 节格式；同时产出 `pdf://` 探针结论，供 Lead 回填 `docs/02 §1` 的 V-06。

### 第 2 步 · M02 contracts

- 下发：`module-prompts/02-contracts.md`（326 行，§5.0=T1–T5）。
- 验收：`cargo build` 与 `tsc --noEmit` 均通过；`node scripts/check-contracts.mjs` 字段差集为空；`CMD` 集合与 Rust `#[tauri::command]` 注册集合完全相等；12 个错误码在 TS 与 Rust 双侧一一对应。
- 本轮验证目标 ②：**45 个色值在真实界面上的观感** —— **(待补充：验证载体)**。
  - 现状：令牌归属 M13（`src/theme/**`），`docs/15-theme-tokens.md` 已冻结 45 个色值，但其首次可见面在 M14 的外壳；M01/M02 本身不含 UI。
  - 两条路径，需用户选一条（不得由执行 Agent 自行决定）：
    - (a) **推迟到 M13/M14 首次出界面时验证**：不新增任何需求，符合现有文档归属。
    - (b) **在 M01 阶段做一次性「令牌预览页」**：属**新增需求**，需用户明确批准并写入 `master_plan`/M01 的验收，否则不得实现。

## 5. 下发方式

1. 一次只下发**一份** Prompt 给**一个**编程 Agent。
2. 并行组按 `docs/03 §3`：串行主链 M01 → M02 → M03 不可并行；M03 完成后，A（M04）/ B（M09→M10→M11）/ C（M12）/ D（M13）与前端链 E（M05→M06→M07→M08）可并行；M14 依赖 A/B/C/D 的接口（先 mock 后接线），M15 最后。
3. 每份 Prompt 的交付报告由 Lead 验收（读最终 diff + 跑相关验证），验收通过才下发下一份。
