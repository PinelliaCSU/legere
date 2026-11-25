# Legere

Legere 是面向个人使用的 Windows PDF 阅读器。它从本地文件夹建立文献库，支持跨文档全文搜索，并记住书签和阅读进度。日常阅读与检索离线运行，无需账号。

![Legere 主页设计示意](design_pictures/%E4%B8%BB%E9%A1%B5%E7%A4%BA%E6%84%8F.png)

## 下载安装

从 [GitHub Releases](https://github.com/PinelliaCSU/legere/releases/latest) 下载 Windows x64 安装包。`Legere_*_x64-setup.exe` 是 NSIS 安装程序，`.msi` 是另一种安装格式，任选其一即可。安装和运行需要 Microsoft Edge WebView2 Runtime。

## 开始阅读

1. 打开 **文献库 → 添加文献库**，选择存放 PDF 的文件夹。Legere 会扫描子文件夹，并在原路径读取 PDF。
2. 从主页或文献库打开 PDF。右键或点击 `⋯` 可以切换连续阅读与单页模式、缩放、跳页，以及打开目录和书签。
3. `Ctrl+F` 在当前 PDF 内搜索。`Ctrl+K` 在已索引的文献正文中搜索，点击结果跳到对应页。纯图片扫描件可以阅读，全文搜索需要 PDF 自带文本层。
4. 使用 `Esc` 关闭阅读面板或返回主页。更多快捷键可在 **设置** 中查看。

PDF 保留在原文件夹中。书签、进度、设置和全文索引存储在本地 `legere.db`，默认数据目录为 `%APPDATA%\com.legere.reader`，也可通过 `LEGERE_DATA_DIR` 指定。备份时先退出 Legere，再复制数据库和原始 PDF 文件。

## 本地开发

使用 Windows x64、Node.js 22.13 或更新版本、pnpm 10.26.1，以及 Rust stable（MSVC）。安装 Visual Studio C++ 构建工具和 WebView2 Runtime。构建 MSI 时还需启用 Windows 的 VBSCRIPT 可选功能。[Tauri 环境配置](https://v2.tauri.app/start/prerequisites/) · [Windows 打包说明](https://v2.tauri.app/distribute/windows-installer/)

```powershell
pnpm install --frozen-lockfile
pnpm tauri:dev
```

```powershell
pnpm typecheck
pnpm check-contracts
pnpm check-theme
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml --locked
pnpm tauri:build --bundles nsis,msi
```

默认打包目录为 `src-tauri/target/release/bundle/`。项目使用 Tauri 2、Rust、React、TypeScript、PDF.js 和 SQLite FTS5。更多实现细节见 [项目概览](docs/00-project-overview.md) 和 [手动测试清单](docs/19-manual-test.md)。
