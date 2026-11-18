# 模块 M13：theme-settings（主题与设置）

> 依赖前置：M02 contracts（`SettingsMapDto` / `CMD` / `call`）、M03 database（`app_settings` 表）。
> 被依赖方：M14 workspace-shell（消费令牌变量）、M07 reader-interaction（消费 `--lg-reader-*` 与光罩）、M11/M12（消费面板色）。
> 归属层：L0 Rust（`src-tauri/src/aux/settings/**`）+ L2/L4 React（`src/theme/**`）；并行组：D（03 §3 第 195 行）。

## 1. 模块身份

M13 是「视觉参数的唯一定义处」。它冻结一套 CSS 变量键名（见 §9），为 light / dark / paper 三套主题各提供一份**键集合完全一致**的取值，并负责把取值注入 DOM。其余所有模块只允许通过 `var(--lg-*)` 消费，不得自行定义颜色。
Rust 侧它只是 `app_settings`（04 §3 第 143-147 行）的读写者，外加默认值合并与非法值回退。
它同时承载「护眼方案」的落地：**只改外围背景与可选暖色光罩，不改 PDF canvas 像素**（决策 D07，02 §11 第 297 行；master_plan §3.5）。

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

一句话：**三套主题共用一套冻结的令牌键名并可无损切换，设置能持久化往返、非法值安全回退，且 paper 主题下 PDF 页面像素与 light 主题一致（可截图验证）。**

分解目标：
1. 冻结 15 个 `--lg-*` 键名，三套主题键集合完全一致（有测试断言）。
2. 主题切换是一次同步批量 CSS 变量注入，不重建任何 canvas、不产生闪烁。
3. paper 主题的护眼实现不含任何作用于 canvas 的 `filter`（D07）。
4. `settings_get_all` / `settings_set` 两个 Command 按 05 §3 第 197-198 行实现，含默认值合并、未知键忽略、非法值回退。
5. 设置面板骨架（区块 + 行 + 控件占位）可渲染、可测；视觉一律不落值。
6. 给出「PDF 内容颜色保真」的可执行对比方法与容差（§13 第 4 条）。

## 4. 功能范围（必须完成）

1. **令牌键名表冻结**（本模块产出，写入本节与 §9）：`THEME_TOKEN_KEYS` 为唯一来源，共 15 键：
   `--lg-bg-app`、`--lg-bg-surface`、`--lg-bg-elevated`、`--lg-fg-primary`、`--lg-fg-secondary`、`--lg-fg-muted`、`--lg-border`、`--lg-accent`、`--lg-accent-fg`、`--lg-reader-bg`、`--lg-reader-page-bg`、`--lg-overlay-tint`、`--lg-overlay-opacity`、`--lg-font-ui`、`--lg-font-reading`。
2. 三套主题对象 `themes.light` / `themes.dark` / `themes.paper` 的键集合必须**完全相同**（类型层用 `Record<ThemeTokenKey, string>` 约束，测试层断言三份 `Object.keys` 排序后相等且长度 = 15）。**具体色值全部【待你确认】**，实现时写占位值并集中标记 `TODO(ui-confirm)`。
3. 注入方式：`applyTheme(theme, root = document.documentElement)` 在**一次同步调用**内完成 15 次 `style.setProperty`；禁止逐键 `await`、禁止在 React render 期间写入、禁止通过给根节点换 `class` 让 15 个变量分两拍生效（会闪）。
4. `useTheme()`：返回 `{ theme, tokens, setTheme }`；`setTheme` 先调 `settings_set({ key, value })`，成功再更新 store 与 DOM；IPC 抛 `ApiError` 时回滚到旧主题并 `console.warn`（不得静默吞）。
5. 首屏不闪烁：应用启动后在 `settings_get_all()` 返回前**不渲染主题化内容**（渲染中性占位壳，`data-theme-pending`）；不引入 `localStorage` 缓存作为第二真源。
6. 护眼（paper）落地：外围背景由 `--lg-reader-bg` 承担；可选暖色光罩由本模块导出 `<ThemeOverlay enabled intensity />` 组件（`aria-hidden="true"`、`pointer-events: none`），由 M14 决定挂在阅读区哪一层。**禁止**对 canvas 或任何包含 canvas 的祖先使用 `filter` / `backdrop-filter` / `mix-blend-mode`（D07）。
7. 颜色保真可验证：paper 与 light 下同一 PDF 页面 canvas 的像素必须一致；对比方法见 §13 第 4 条（含 canvas taint 的降级方法）。
8. 设置读取：`loadSettings()` = `settings_get_all()` 原始 map ⊕ `DEFAULTS` 合并；逐键 `JSON.parse`（失败 → 该键回退默认值 + `console.warn` 一条）→ `validate`（不合规 → 回退默认值）；**未知键忽略**（04 §4 第 162 行：读取失败或未知键 → 用默认值，不抛错）。
9. 设置写入：`settings_set` 的 Rust 侧对已知键做同一套 `validate`，非法 → `E_INVALID_ARG`（05 §3 第 198 行）；**未知键允许写入**（前向兼容），读取时由 `loadSettings` 忽略。
10. `value` 编码：一律 `JSON.stringify` 后的字符串（04 §1/§3 第 143 行注释、05 §2 第 148 行 `value 为 JSON 字符串`）。例如主题 paper 存为 `"paper"`（含双引号）。
11. 持久化键名冻结（契约未定义键名，由本模块定，交付报告 §9 记录）：`theme`（string）、`readerOverlayEnabled`（boolean）、`readerOverlayIntensity`（number 0–1）。
12. 设置面板骨架：`SettingsPanel` 由若干 `SettingsSection`（主题 / 护眼 / 关于）组成，每行 `SettingRow(label, description, control)`；控件形态（下拉/开关/滑块）属视觉，见 §7。
13. 本模块**不新增** Command / 事件 / DTO 字段；不改 `app_settings` 表结构。

## 5. 非目标（明确不做）

### 5.0 已由 Lead 裁决的技术参数（**不再询问，按此实现**）

以下条目曾标为「待你确认」，但属技术参数且**已由 Lead 按官方文档与工程判断裁决**：**T10 T11 T13** —— 明细与理由见 `docs/14-ui-decision-register.md` §1 对应行。实现时直接落该值，**不得**再当作待确认项停下来问；若你认为某条在本模块不成立，在交付报告 §9 提出并说明，不要自行改动。

1. 不改 PDF canvas 像素；不实现 CSS filter 反色 / 反相 / 降低白度；不实现「纸面本身也变暖」的像素级处理（D07 代价栏明确这是后续可选能力）。
2. 不做**逐文档临时主题覆盖**（03 §2 M13 第 159 行）。
3. 不做阅读器排版（字号、行距、页间距属 M07 的阅读布局）。
4. 不定主页书脊色板（13-ui-home-concept §7 第 3 条属 M14 的待确认项）。
5. 不做主题 JSON 导入导出、自定义主题编辑器、跟随系统主题的监听逻辑（若要跟随 OS，属新增产品决策，见 §7）。
6. 不新增 Command，不改 `app_settings` 表，不改 M02 的 DTO。
7. **不得自行确定视觉方案**：15 个令牌的**色值已由 D05/D06 冻结于 `docs/15-theme-tokens.md`**（不是待确认项，照抄即可）；字体栈、圆角/间距/动效阶梯见该文档 §6（同样已冻结）。原待确认项已全部裁决：分区块（D27）、分区内控件形态与阅读模式下的可见性（A1）、主题切换动效（A2，不做）。本模块**不再有视觉待确认项**；仍不得虚构任何数值。
8. 不做 Tailwind 主题配置的语法推断：若要用 Tailwind v4 的 CSS-first 配置，先读 `package.json` 中 `tailwindcss` 的实际版本并对照该版本文档，不得凭记忆写配置语法。

## 6. 架构约束

- 允许依赖：M02（`SettingsMapDto` / `CMD` / `call`）、M03（`app_settings` 的连接与写队列，04 §2 第 22 行）。
- 禁止依赖：M04/M09/M10/M11/M05/M06 的任何实现；`src/theme/**` 不得 import `src/pdf-engine/**` 或 `src/render/**`（02 §2 第 56-60 行）。
- 状态归属：设置唯一真源是 `app_settings`；`src/theme` 的 store 只是内存镜像。主题的**最终生效形态**是 `document.documentElement` 上的 15 个 CSS 变量，不是某个 class。
- 资源所有权：本模块不持有 canvas、不持有 `DocumentHandle`、不参与渲染调度。
- 契约缺口（需 Lead 裁定）：
  1. 05 与 04 均**未定义设置键名**，只定义了 `app_settings(key, value, updated_at)` 与 `SettingsMapDto = Record<string, string>`。本模块按 §4 第 11 条冻结三个键名；这是本模块的自定细节，不改契约。
  2. 03 §4 第 229 行把 `src/theme/**` 划归 M13，但设置面板的《设置》路由由 M14 的 `AppShell` 承载；本模块只导出 `SettingsPanel`，**不注册路由**。

## 7. 输入与输出

| 输入来源 | 数据形态 | 触发时机 |
|---|---|---|
| M03 database | `SettingsMapDto`（`Record<string,string>`） | 启动、面板打开、切换主题 |
| 用户（设置面板） | `ThemeName` / boolean / number | 点击控件 |
| M14 | 无（M14 只消费 `var(--lg-*)` 与 `useTheme()`） | — |

| 输出目标 | 数据形态 | 消费方 |
|---|---|---|
| DOM（`documentElement`） | 15 个 CSS 自定义属性 | 全部 UI 模块（`var(--lg-*)`） |
| `useTheme()` | `{ theme, tokens, setTheme }` | M14（主题选择器）、M07 |
| `<ThemeOverlay/>` | 一个 `aria-hidden` 的装饰层 | M14 在阅读区挂载 |
| SQLite | `app_settings` 行 | — |

### 7.2 【待你确认】清单（实现时留 `TODO(ui-confirm)`）

1. ~~三套主题的具体色值~~ → **D05 已拍板**：15 令牌 × 3 套的**全部色值已冻结在 `docs/15-theme-tokens.md` §2**，键名与值必须逐字照抄；若本 Prompt 之前自定过键名，一律以该文档为准。对照度门槛见其 §3（测试断言）。
2. ~~暖色光罩色相与不透明度~~ → **D06 已拍板**：`#C9A063 @ 6%`、`mix-blend-mode: multiply`、paper 主题默认开启且可在设置里关闭（键 `reader.paperVeil`）；light/dark 默认关闭。规格见 `docs/15-theme-tokens.md` §4（含颜色保真验收容差 6/255）。
3. 首次启动的默认主题（现占位 `light`）。
4. 字体栈：`--lg-font-ui` / `--lg-font-reading` 的具体字体与回退顺序。
5. ~~设置面板分区块与分区内控件形态~~ → **D27 + A1 已拍板**：左侧分区栏（外观 / 阅读 / 数据 / 关于）+ 右侧表单。**A1 用户原话**：“阅读模式下不出现任何与阅读无关的按钮或选项区域，界面保持最纯粹的阅读状态；按 Esc 退出阅读模式后，才显示设置面板各分区。” 实现含义：阅读模式（`route = reader`）下 `SettingsPanel` 与设置入口一律不渲染、不可达；`Esc` 退出阅读模式后设置面板各分区才可用。控件形态（下拉 / 开关 / 滑块）由实现按现有 `SettingRow` 结构选择，不属待确认项。
6. ~~主题切换是否需要过渡动效~~ → **A2 已拍板：「不加入过渡动效。」** 主题切换瞬时生效（`transition: none`；不得给 CSS 变量或背景加 transition）。
   - 待补充：主题切换是否加过渡动效（已裁决，见上）
7. dark 主题下 PDF 页面区域的处理（是否加描边、是否降低周围亮度）——只允许动外围，不动像素。
8. 是否需要「恢复默认设置」入口及其位置。
9. 是否跟随系统 `prefers-color-scheme`（若要，属新增产品行为，需先确认）。

## 8. 接口契约

Rust Command（与 05 §3 第 197-198 行一致，入参单对象，05 §3 第 203 行）：

```rust
// src-tauri/src/aux/settings/commands.rs
#[tauri::command]
pub async fn settings_get_all() -> Result<SettingsMapDto, ApiError>;

#[tauri::command]
pub async fn settings_set(key: String, value: String) -> Result<(), ApiError>;
```

本模块产出的冻结 TS 接口（契约未定义，属本模块所有，M14 只能 import 这些）：

```ts
// src/theme/tokens.ts
export const THEME_TOKEN_KEYS = [
  "--lg-bg-app", "--lg-bg-surface", "--lg-bg-elevated",
  "--lg-fg-primary", "--lg-fg-secondary", "--lg-fg-muted",
  "--lg-border", "--lg-accent", "--lg-accent-fg",
  "--lg-reader-bg", "--lg-reader-page-bg",
  "--lg-overlay-tint", "--lg-overlay-opacity",
  "--lg-font-ui", "--lg-font-reading",
] as const;
export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];
export type ThemeTokens = Record<ThemeTokenKey, string>;

// src/theme/themes.ts
export type ThemeName = "light" | "dark" | "paper";
export const themes: Record<ThemeName, ThemeTokens>;

// src/theme/apply-theme.ts —— 同步、一次批量写入
export function applyTheme(theme: ThemeName, root?: HTMLElement): void;

// src/theme/use-theme.ts
export function useTheme(): { theme: ThemeName; tokens: ThemeTokens; setTheme(next: ThemeName): void };

// src/theme/settings-schema.ts
export const SETTING_KEYS = {
  theme: "theme",
  overlayEnabled: "readerOverlayEnabled",
  overlayIntensity: "readerOverlayIntensity",
} as const;
export interface AppSettings { theme: ThemeName; readerOverlayEnabled: boolean; readerOverlayIntensity: number }
export const DEFAULTS: AppSettings;                       // 占位值，见 §7.2
export function parseSetting<K extends keyof AppSettings>(key: K, raw: string | undefined): AppSettings[K];
export function validateSetting<K extends keyof AppSettings>(key: K, value: unknown): AppSettings[K];

// src/theme/settings-io.ts
export function loadSettings(): Promise<{ settings: AppSettings; warnings: string[] }>;
export function saveSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void>;

// src/theme/ThemeOverlay.tsx —— 装饰层，不含业务逻辑
export interface ThemeOverlayProps { enabled: boolean; intensity: number }
```

## 9. 数据结构

令牌键名表（本模块冻结；三套主题必须同键，值全部【待你确认】）：

| 令牌 | 语义 | 消费方 |
|---|---|---|
| `--lg-bg-app` | 应用最外层背景 | AppShell（M14） |
| `--lg-bg-surface` | 面板 / 列表 / 卡片表面 | M11 / M12 / M14 |
| `--lg-bg-elevated` | 浮层（搜索浮层、对话框、下拉） | M11 / M14 |
| `--lg-fg-primary` | 主文本 | 全部 UI |
| `--lg-fg-secondary` | 次级文本（作者、元数据） | 全部 UI |
| `--lg-fg-muted` | 弱化文本（空态、禁用） | 全部 UI |
| `--lg-border` | 分隔线与边框 | 全部 UI |
| `--lg-accent` | 强调色（选中、焦点环、进度） | 全部 UI |
| `--lg-accent-fg` | 强调色上的前景色 | 全部 UI |
| `--lg-reader-bg` | 阅读器外围背景（PDF 之外） | M07 |
| `--lg-reader-page-bg` | 页垫底色（canvas 之下的衬底，不是 canvas 像素） | M07 |
| `--lg-overlay-tint` | 暖色光罩颜色（含 alpha） | `<ThemeOverlay/>` |
| `--lg-overlay-opacity` | 光罩整体不透明度（0–1 的数值串） | `<ThemeOverlay/>` |
| `--lg-font-ui` | UI 字体栈 | 全部 UI |
| `--lg-font-reading` | 阅读区字体栈（M07 可选消费） | M07 |

`app_settings`（04 §3 第 143-147 行）：`key` TEXT PRIMARY KEY、`value` TEXT NOT NULL（JSON 字符串）、`updated_at` TEXT NOT NULL（UTC ISO-8601，04 §1 第 8 行）。本模块只写三行，不建新表、不加列。

`DEFAULTS` 占位值（全部标 `TODO(ui-confirm)`，交付报告 §6 逐条列出）：`theme` 占位 `"light"`、`readerOverlayEnabled` 占位 `false`、`readerOverlayIntensity` 占位 `0.5`。

## 10. 文件组织

```text
src-tauri/src/aux/settings/
  mod.rs        # 模块出口：2 个命令名清单
  commands.rs   # settings_get_all / settings_set，参数与语义校验
  repo.rs       # app_settings 的 select-all / upsert，走 M03 写队列
  schema.rs     # 已知键名 + validate（与前端 settings-schema.ts 保持同语义）
  tests.rs
src/theme/
  tokens.ts        # THEME_TOKEN_KEYS 唯一来源
  themes.ts        # 三套主题（值占位）
  apply-theme.ts   # 批量 setProperty
  use-theme.ts     # store + hook + 失败回滚
  settings-schema.ts / settings-io.ts
  ThemeOverlay.tsx
  SettingsPanel.tsx + settings-panel/{Section.tsx,Row.tsx}
  theme.css        # 兜底令牌声明（值与 themes.light 同源，不得各自演化）
  *.test.ts
```

## 11. 实施步骤

1. `tokens.ts` + `themes.ts`（占位值）→ 键集合断言测试通过。
2. `apply-theme.ts` + `theme.css` → 手动切三次，`documentElement.style` 上恰有 15 个 `--lg-*` 键、无残留。
3. `settings-schema.ts`（`DEFAULTS` / `parseSetting` / `validateSetting` 纯函数）+ 单测（合法 / 非法 / 未知键三分支）。
4. Rust `aux/settings`：`repo.rs` + 2 个 Command + `validate`；`cargo test aux::settings` 通过。
5. `settings-io.ts` 接 `call("settings_get_all")` / `call("settings_set")`；实现合并与告警收集。
6. `use-theme.ts`：`setTheme` → IPC → 成功更新 / 失败回滚。
7. `<ThemeOverlay/>` + paper 主题的自检（§13 第 4 条方法 A）。
8. `SettingsPanel` 骨架（三个区块 + `SettingRow`），控件留占位并标 `TODO(ui-confirm)`。
9. `cargo clippy --all-targets -- -D warnings` 与 `npx tsc --noEmit` 清零。

## 12. 测试要求

TS（vitest，jsdom）：
- 令牌完整性：三套 `Object.keys(themes[t]).sort()` 两两相等且 = `[...THEME_TOKEN_KEYS].sort()`；长度 15；每个值是非空字符串。
- 注入：`applyTheme("paper")` 后 `document.documentElement.style.cssText` 中 `--lg-` 出现次数 = 15；再 `applyTheme("dark")` 后仍 = 15（无残留键）。
- 批量性：spy `setProperty`，调用计数 = 15，且全部发生在同一同步栈（无 `await` 间隙）→ 断言 15 次都在 `applyTheme` 返回前完成。
- 回退：`parseSetting("theme", '"nope"')` → `DEFAULTS.theme`；`parseSetting("theme", 'not-json')` → 默认值且 1 条 warn；`loadSettings` 遇到未知键不报错、不出现在结果里。
- 往返：mock `call`，`saveSetting("theme","paper")` 后再次 `loadSettings` 得 `paper`；`value` 实际发送为 `'"paper"'`。
- 回滚：mock `call` 抛 `ApiError{code:"E_DB"}` → `setTheme` 后 store 与 DOM 仍是旧主题。
- 面板：三个区块渲染；`SettingRow` 无样式值断言（仅结构与可交互性）。

Rust（`#[cfg(test)]`）：
- `settings_get_all` 空库返回空 map（默认值合并是前端职责，不在 Rust 侧造默认行）。
- `settings_set` upsert 两次同一键 → 行数 1、值 = 第二次、`updated_at` 不早于第一次。
- 非法值 `settings_set("readerOverlayIntensity", "2")` → `E_INVALID_ARG`；`settings_set("theme", '"nope"')` → `E_INVALID_ARG`。
- 未知键 `settings_set("futureKey", "1")` → 成功（前向兼容）。

命令：

```bash
cd src-tauri && cargo test aux::settings && cargo clippy --all-targets -- -D warnings
npx vitest run src/theme && npx tsc --noEmit
```

## 13. 验收标准

1. **令牌键集合一致**：一次测试断言三套主题键集合完全一致（= 15 键），命令 `npx vitest run src/theme` 中该用例名为 `theme-token-parity`。
2. **持久化往返**：`settings_set({ key: "theme", value: '\"paper\"' })` → `settings_get_all()` 返回 `theme = '"paper"'` → 重启后 `useTheme().theme === "paper"`。
3. **非法值回退**：库中写 `theme = '"nope"'`，启动后 `useTheme().theme` = `DEFAULTS.theme`，UI 不崩、恰有一条 warn。
4. **PDF 内容颜色保真**（paper vs light）：
   - 方法 A（优先）：在同一页 canvas 上取像素。WebView 控制台执行：
     ```js
     const c = document.querySelector("canvas");
     const g = c.getContext("2d", { willReadFrequently: true });
     const p = g.getImageData(Math.floor(c.width * 0.5), Math.floor(c.height * 0.4), 1, 1).data;
     JSON.stringify([p[0], p[1], p[2]]);
     ```
     分别在 light 与 paper 下执行，**判据：三个通道逐一比较，每通道差 ≤ 1**（0–255 标度）。
   - 方法 B（A 抛 `SecurityError` 即 canvas 被 taint 时）：对同一页面区域截图（`Win+Shift+S` 或系统截图），用取色器读 RGB，判据同 A 但容差放宽为每通道 ≤ 2（截图有缩放与压缩误差）。
   - 无论 A/B，若差 > 容差 → 判定为「像素被改动」的缺陷，必须先找出改动来源（检查是否有 `filter` / `backdrop-filter` / `opacity` 作用在 canvas 或其祖先上）。
5. **切换无闪烁**：一次 CSS 变量批量更新——断言 `applyTheme` 内 `setProperty` 调用 15 次且在同一次同步任务内完成；切换 light→paper→dark 三轮后 `document.querySelectorAll("canvas")` 的节点身份不变（canvas 未被重建）。
6. 非法值写入口：`settings_set` 对 `theme` / `readerOverlayIntensity` 的非法值返回 `E_INVALID_ARG`；未知键写入成功。
7. `cargo clippy --all-targets -- -D warnings` 与 `npx tsc --noEmit` 均 0 错误；本模块无 `any`、无 `unwrap()`。
8. 交付报告 §6 列出 §7.2 的 9 条待确认项 + 所有 `TODO(ui-confirm)` 占位值的实际取值。

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

1. 不得对 canvas 或任何包含 canvas 的祖先元素使用 `filter` / `backdrop-filter` / `mix-blend-mode` 改变 PDF 像素（D07，02 §11 第 297 行）。
2. 不得新增第 4 套主题变量集合，也不得按文档覆盖主题（03 §2 M13 第 159 行）。
3. 不得把主题或护眼设置存进 `localStorage` / `sessionStorage` / 配置文件；唯一真源是 `app_settings`。
4. 不得把色值硬编码进任何组件（组件只允许 `var(--lg-*)`；三套主题是唯一色值来源）。
5. 不得在 `settings_set` 里把非法值静默改成默认值（必须 `E_INVALID_ARG`）。
6. 不得自行决定 15 个令牌的具体色值、字体与面板视觉。
