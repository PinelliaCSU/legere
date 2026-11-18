# 19 · 手工测试指南（交付给用户完整测试）

> 目的：把「机器能验的」与「只能人眼看的」分开，让测试有的放矢。
> 每条都标注了**当前已知状态**，便于你区分「我没测到」与「已知有问题」。

## 0. 启动方式

```powershell
cd C:\Users\Lenovo\Desktop\legere
# 1) 前端产物（改过前端后必须重跑）
pnpm build
# 2) 后端 + 应用。注意：本仓库把 CARGO_TARGET_DIR 指向了工作区的 .target
#    （src-tauri/target 里的旧产物带 Low 完整性标签，已弃用）
cd src-tauri
$env:CARGO_TARGET_DIR = "C:\Users\Lenovo\Desktop\legere\.target"
cargo build --release --features custom-protocol
# 3) 构建产物带 Low 完整性标签，需重打一级（每次重建后都要做）
icacls "C:\Users\Lenovo\Desktop\legere\.target\release\legere.exe" /setintegritylevel M
# 4) 启动（注意是 .target，不是 src-tauri\target）
C:\Users\Lenovo\Desktop\legere\.target\release\legere.exe
```

数据目录：`%APPDATA%\com.legere.reader`（数据库 `legere.db`、日志 `logs\`）。
想换位置可用环境变量：`LEGERE_DATA_DIR` / `LEGERE_LOG_DIR` / `LEGERE_WEBVIEW_DATA_DIR`。

## 1. 已验证通过（可跳过）

| 项 | 证据 |
|---|---|
| 协议 `pdf://` 的 200/206 + Range | 日志 `pdf:// 响应 status=206 content_range=Some("bytes 0-9/599")` |
| 文献库扫描/增量/软删/复活 | 界面探针 `扫描后文档数 total=2`、`前三个文件名 beta.pdf, alpha.pdf` |
| 索引链路 | `索引状态 indexed=2 failed=0 noText=0`、`文档状态 textState=indexed pageCount=1` |
| 全局检索 | `搜索 Legere: documents=2 tookMs=7`、`首个命中 p1「Legere sample page」ranges=[[1,7]]` |
| pdfjs 引擎 | 8 步全绿（pageCount/几何/文本/itemStarts 可逆/元数据/目录/渲染位图/释放） |
| 主题令牌与对比度 | `check-theme`：3 套 × 15 令牌全部达标 |
| 契约一致性 | `check-contracts`：18 DTO / 28 Command / 12 错误码 |

## 2. 需要你人工验证（按优先级）

### P0 · 主页空间转盘（已知有缺陷，优先看）

1. 打开应用默认进入「主页」。**当前已知问题**：环线与书脊整体偏向右下，看不出「书脊沿圆周排布」。
   - 已取得的证据：界面调试输出 `size=1280x807 c=(640,371) r=274 inner=1280x860`——几何计算正确，
     但渲染位置比计算值右移约 190px，说明问题在 DOM/CSS 层。
   - 请确认：是否只有环线偏移？书脊是否也在同一偏移下（若书脊与环线错开，是两处问题）。
2. 拖拽左右移动，书脊应随之转动；隐藏弧内的书**不应存在**（可用 DevTools 数 `[data-home-spine]`）。
3. `←` / `→` 旋转一格；`Enter` 打开焦点书；滚轮应旋转（当前**未实现**，见 §4）。
4. 书脊上应只有竖排书名，无进度条/无标记（D04/D12）。
5. 空态：删掉所有库根后应显示「还没有文献 + 添加文献库」，不画环（D14）。

### P1 · 阅读器

6. 从主页点一本书进入阅读器；应看到页面位图与可选择的文字（文字本身透明）。
7. `Ctrl + / -` 缩放；`←/→` 翻页；`M` 切换连续/单页；`Esc` 返回。
8. 底部页码胶囊显示 `当前页 / 总页数`；左右各一枚悬浮圆按钮（D15）。
9. 关闭再打开同一本书，应恢复上次页码（进度回写间隔 1s）。
10. 已知风险：`←/→` 同时被主页的键盘监听使用，若停留在主页按方向键可能与阅读器冲突（待修）。

### P2 · 主题与设置

11. 设置 → 主题 light/dark/paper 切换应**瞬时生效、无过渡动画**（A2）。
12. paper 主题下页面区域应几乎看不出染色（光罩 6%，颜色差 ≤6/255）。
13. 重启应用后主题应保持（写 `app_settings`）。

### P3 · 全局搜索

14. `Ctrl+K` 打开居中浮层；输入 ≥2 字回车搜索；点击结果应打开对应文献。
15. 输入 1 个字应提示「请输入至少 2 个字」（E_INVALID_ARG）。

## 2.5 本轮修复（2026-11-18 晚）

- **阅读器空白已修**：页槽原本没有宽高（高度 0），canvas 绝对定位在零高容器里。现在页槽尺寸由 PageGeometry × scale 内联给出；截图已确认能显示真实页面（白页 + 文字 + 左侧悬浮按钮 + paper 主题）。
- **环线定位已改**：改用与书脊相同的 transform 路径。**但由于缓存/进程原因本轮截图与上一版字节相同，未能确认生效**，请你实测。
- 阅读器页面**水平居中仍偏移**（与环线同一现象），改用 flex 居中后截图未变化，怀疑构建产物未生效，需你在干净进程下确认。

## 3. 已知问题清单（我这边未解决，不需要你复现）

| # | 问题 | 现状 |
|---|---|---|
| 1 | 主页环线偏移（书脊正确） | 已改为与书脊同一条 transform 定位路径，**本次未复验** |
| 2 | 滚动轮旋转未实现 | HomeSpace 未监听 wheel |
| 3 | 书签面板 UI 未做 | 后端 8 条命令已就绪（bookmark_*） |
| 4 | 索引进度条未做 | 事件 `index://progress` 已发 |
| 5 | 文内搜索面板未接入 | `doc-search.ts` 逻辑与 9 条测试就绪，未接 UI |
| 6 | `cargo test` 偶发 8 失败 | 疑为临时目录并发竞争，需按唯一目录加固 |
| 7 | 打包（`tauri build` / NSIS）未验证 | M15 未开始 |

## 4. 报告问题的方式

把「你做了什么 → 看到什么 → 期望什么」写清楚；若涉及界面，附截图；若涉及错误，
附 `%APPDATA%\com.legere.reader\logs\legere.log.*` 的最后 20 行。