# 15 · 主题令牌与文本层/高亮规格（D05 D06 D20 D21 已定值）

> 权限归属：本节由**用户拍板**（轮次 2），冻结为契约。M13 实现令牌、M07/M08/M14 只消费；具体色值**不得**在组件里硬编码，一律走 CSS 变量。
> 若 module-prompts/13-theme-settings.md 已自定键名，**以本文档为准**并回改该 Prompt。

## 1. 15 个颜色令牌（三套主题键集合必须完全一致）

| # | 令牌 | 用途 | 禁止用法 |
|---|---|---|---|
| 1 | `--lg-bg-app` | 应用最底层背景（窗口底色） | 不要用于卡片/浮层 |
| 2 | `--lg-bg-surface` | 面板、浮层、卡片底色 | 不要用于页面区 |
| 3 | `--lg-bg-elevated` | 悬浮元素（下拉、浮层、弹窗）底色 | 不要与 surface 同值（需靠明度差分层） |
| 4 | `--lg-border-subtle` | 分隔线、弱边界 | 不要用于可点击元素的焦点边界 |
| 5 | `--lg-border-strong` | 输入框、可聚焦元素的边界 | — |
| 6 | `--lg-fg-primary` | 主文本 | — |
| 7 | `--lg-fg-secondary` | 次文本（作者、元信息） | 对比度不足时不要用于正文 |
| 8 | `--lg-fg-muted` | 弱提示、占位符（对比度只保证 ≥3:1，**不得**承载必要信息） | 不要用于需阅读的内容 |
| 9 | `--lg-accent` | 强调色（主按钮、当前项、转盘环线） | 不要用于大面积填充 |
| 10 | `--lg-accent-fg` | 强调色之上的前景 | — |
| 11 | `--lg-page-bg` | **PDF 页面周边的环境色**（阅读区底） | **不是** PDF 页面的白色；不许改 canvas |
| 12 | `--lg-page-border` | 页面容器描边 | — |
| 13 | `--lg-hit-bg` | 普通命中底色 | — |
| 14 | `--lg-hit-active-bg` | 当前命中底色 | — |
| 15 | `--lg-hit-active-border` | 当前命中描边 | — |

## 2. 三套色值

### light（低饱和中性灰蓝，D05）

| 令牌 | 值 |
|---|---|
| `--lg-bg-app` | `#F5F7F9` |
| `--lg-bg-surface` | `#FFFFFF` |
| `--lg-bg-elevated` | `#FBFCFD` |
| `--lg-border-subtle` | `#E2E8EE` |
| `--lg-border-strong` | `#C6D0D9` |
| `--lg-fg-primary` | `#1B2430` |
| `--lg-fg-secondary` | `#55636F` |
| `--lg-fg-muted` | `#8A96A1` |
| `--lg-accent` | `#3E7B6B` |
| `--lg-accent-fg` | `#FFFFFF` |
| `--lg-page-bg` | `#EDF0F3` |
| `--lg-page-border` | `#DCE3E9` |
| `--lg-hit-bg` | `#FFE9A8` |
| `--lg-hit-active-bg` | `#FFD666` |
| `--lg-hit-active-border` | `#C99A2E` |

### dark（深墨底，低饱和）

| 令牌 | 值 |
|---|---|
| `--lg-bg-app` | `#12171C` |
| `--lg-bg-surface` | `#1A2027` |
| `--lg-bg-elevated` | `#222A32` |
| `--lg-border-subtle` | `#2C353D` |
| `--lg-border-strong` | `#3D4852` |
| `--lg-fg-primary` | `#E6EBEF` |
| `--lg-fg-secondary` | `#A8B3BC` |
| `--lg-fg-muted` | `#78848E` |
| `--lg-accent` | `#5FA391` |
| `--lg-accent-fg` | `#0F1418` |
| `--lg-page-bg` | `#0E1216` |
| `--lg-page-border` | `#2B333A` |
| `--lg-hit-bg` | `#57491B` |
| `--lg-hit-active-bg` | `#7C6526` |
| `--lg-hit-active-border` | `#C9A83C` |

### paper（米黄纸色，D05 + D06）

| 令牌 | 值 |
|---|---|
| `--lg-bg-app` | `#F3EAD9` |
| `--lg-bg-surface` | `#FBF5E9` |
| `--lg-bg-elevated` | `#F7F0E1` |
| `--lg-border-subtle` | `#E5D9C3` |
| `--lg-border-strong` | `#D2C3A8` |
| `--lg-fg-primary` | `#33291C` |
| `--lg-fg-secondary` | `#6B5B45` |
| `--lg-fg-muted` | `#9A8A72` |
| `--lg-accent` | `#8C5E3C` |
| `--lg-accent-fg` | `#FFF7EA` |
| `--lg-page-bg` | `#EFE4D0` |
| `--lg-page-border` | `#DFD1B8` |
| `--lg-hit-bg` | `#F6D98A` |
| `--lg-hit-active-bg` | `#E8C46A` |
| `--lg-hit-active-border` | `#A8813A` |

## 3. 对比度硬约束（测试断言，不达标即缺陷）

| 组合 | 门槛 |
|---|---|
| `fg-primary` / `bg-surface` | ≥ 10:1 |
| `fg-secondary` / `bg-surface` | ≥ 4.5:1 |
| `fg-muted` / `bg-surface` | ≥ 3:1（仅装饰/占位） |
| `accent-fg` / `accent` | ≥ 4.5:1 |
| `fg-primary` / `page-bg` | ≥ 7:1 |
| `hit-active-bg` 与 `hit-bg` 的 ΔL* | ≥ 8（保证一眼能分出"当前"） |

## 4. 暖色纸光罩（D06）

```css
/* 叠加在 PDF 页面容器之上，pointer-events: none；不触碰 canvas 像素 */
.lg-paper-veil { background: #C9A063; opacity: 0.06; mix-blend-mode: multiply; }
```

- 仅在 `theme = paper` 时默认启用，可在设置里关闭（开关键 `reader.paperVeil`）。
- `light` / `dark` 下默认关闭。
- **禁止**用 `filter: invert()` / `sepia()` 等作用于 canvas（决策 D07）。
- 颜色保真验收：含彩色图表的样本页，在 paper + 光罩下与 light 主题同一区域取色，每通道差 ≤ 6/255（6% 光罩的理论上限）。

## 5. 文本层与高亮（D20 D21）

层级（z-index，冻结）：

| 层 | z | 说明 |
|---|---|---|
| canvas 位图 | 0 | 由 M06 持有 |
| TextLayer | 10 | 文字**完全透明**（`color: transparent`），只用于选择与命中定位 |
| 高亮层 | 20 | `pointer-events: none`，不得拦截选择 |
| 阅读器界面 | 30 | 页码、悬浮控件 |
| 浮层（搜索/书签/设置） | 100 | — |

高亮规格：

| 状态 | 样式 |
|---|---|
| 普通命中 | `background: var(--lg-hit-bg)`，无描边 |
| 当前命中 | `background: var(--lg-hit-active-bg)` + `outline: 1px solid var(--lg-hit-active-border)`，`outline-offset: 0` |
| 选区（用户拖选） | 用浏览器原生 `::selection`，颜色由当前主题的 `--lg-accent` 派生（不引入新令牌） |

约束：高亮矩形必须由文本层坐标计算，**不得**在 canvas 上绘制；跨行命中拆成多段，每段独立背景。

## 6. 非颜色令牌（同时冻结）

| 令牌 | 值 | 说明 |
|---|---|---|
| `--lg-font-ui` | `"Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif` | 界面 |
| `--lg-font-reading` | `"Source Han Serif SC", "Noto Serif SC", "Songti SC", serif` | 阅读区元信息（书脊/标题） |
| `--lg-radius-sm` / `md` / `lg` | `4px` / `8px` / `12px` | 浮层与按钮 |
| `--lg-page-radius` | `0` | 页面容器无圆角（**D18 已定**） |
| `--lg-page-shadow` | `0 1px 2px rgba(16,24,32,.06), 0 6px 16px rgba(16,24,32,.05)` | 页容器极淡阴影（**D18 已定**；dark 主题改用单层 `rgba(0,0,0,.35)`） |
| `--lg-reader-padding` | `32px` | 阅读区上下留白（**D17 已定**） |
| `--lg-page-gap` | `12px` | 连续模式页间距（**D17 已定**） |
| `--lg-space-1`…`6` | `4/8/12/16/24/32px` | 间距阶梯 |
| `--lg-dur-fast` / `base` / `slow` | `120ms` / `180ms` / `240ms` | 动效时长（曲线统一 `cubic-bezier(.2,0,0,1)`） |

## 8. 主页书脊色板（D13 已定：8 色预设，哈希取色）

取自你示意图中的配色倾向（橄榄/苔绿/赭棕/沙黄/灰紫/灰绿/暖棕/鼠尾草），按 `hash(documentId) % 8` 取用，**不读封面**：

```ts
export const SPINE_PALETTE = [
  "#9AA47A", // 1 橄榄
  "#8FA083", // 2 苔绿
  "#9B6B4A", // 3 赭棕
  "#C9B37A", // 4 沙黄
  "#8E86A5", // 5 灰紫
  "#A8B49B", // 6 灰绿
  "#A9714B", // 7 暖棕
  "#9FB08C", // 8 鼠尾草
] as const;
```

- `dark` 主题统一提亮 12%（`color-mix(in oklab, base 88%, white)`），避免深底上发闷。
- `paper` 与 `light` 共用同一套（这些色相与纸底协调）。
- 书脊文字颜色固定 `rgba(255,255,255,.92)`：8 色的明度都落在 45%–62%，不需要逐色算对比度。

## 7. 本轮之后仍未定（登记在 14-register）

- D07 转盘深度数值、D08 重叠策略、D09 滚轮语义、D10 进入过渡、D11 焦点书信息、D12 书脊状态标记、D13 取色策略、D14 空态、D16 页码指示、D17 留白/页间距、D18 页容器阴影、D19 长页对齐、D22–D28 面板与文案。
- 主题切换是否加过渡动效、设置面板分区块结构（D27）。
