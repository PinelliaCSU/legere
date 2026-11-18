// M09 · 页面级文本提取与索引写入（docs/03 M09）。
//
// 边界：不做队列与调度（M10）、不写检索 SQL（M11）、不扫描目录（M04）、不做 OCR。

pub mod extract;
pub mod segment;
pub mod writer;

pub use extract::{DocMeta, LopdfExtractor, PageText, TextExtractor};
pub use segment::{build_seg_text, segment_query, tokens};
pub use writer::{abs_path_of, index_document, mark_failed, IndexOutcome};

#[cfg(test)]
mod tests;
