// M04 · 文献库扫描与增量判定（docs/03 M04 边界卡、docs/02 §8）。
//
// 边界：本模块只写「文件事实」（路径/大小/mtime），不解析 PDF、不分词、不建索引；
// 元数据与正文由 M09 经 M10 的 meta/text 任务产出。

pub mod dialog;
pub mod scan;
pub mod watch;

pub use dialog::pick_folder;
pub use scan::{ensure_root_dir, scan_root, FoundFile, ScanDiff, ScanOutcome};

#[cfg(test)]
mod tests;

#[cfg(test)]
mod watch_tests;
