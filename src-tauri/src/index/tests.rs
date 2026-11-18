// M09 单测：内容流解析、质量判定、分词对称性。

use super::extract::{extract_from_content, looks_like_text};
use super::segment::{build_seg_text, segment_query, tokens};

#[test]
fn extracts_text_from_tj_operators() {
    let content = b"BT /F1 24 Tf 72 760 Td (Hello PDF) Tj ET";
    let text = extract_from_content(content);
    assert!(text.contains("Hello PDF"), "实际: {text:?}");
}

#[test]
fn extracts_text_from_tj_array() {
    let content = b"BT [(Hello) -200 (World)] TJ ET";
    let text = extract_from_content(content);
    assert!(text.contains("Hello") && text.contains("World"), "实际: {text:?}");
}

#[test]
fn garbage_is_not_treated_as_text() {
    assert!(!looks_like_text(""));
    assert!(!looks_like_text("\u{FFFD}\u{FFFD}\u{FFFD}\u{FFFD}"));
    assert!(looks_like_text("中文分词的效果很好"));
    assert!(looks_like_text("Legere sample page 2026"));
}

#[test]
fn segmentation_is_deterministic_and_symmetric() {
    let a = tokens("中文分词的效果");
    let b = tokens("中文分词的效果");
    assert_eq!(a, b, "同一文本两次切分必须一致（V-04）");
    // 查询侧与文档侧走同一实现：查询串的 token 必须是文档 token 的子序列。
    assert!(a.windows(2).any(|w| w.len() == 2));
    let q = segment_query("分词");
    let mut idx = 0;
    for token in &q {
        let pos = a[idx..].iter().position(|t| t == token).expect("查询 token 应出现在文档 token 中");
        idx += pos;
    }
}

#[test]
fn seg_text_is_space_joined() {
    let seg = build_seg_text("中文分词");
    assert!(seg.contains(' '), "seg_text 应以空格分隔 token：{seg:?}");
    assert!(!seg.contains("，"), "标点应被过滤");
}
// 真实 PDF 冒烟（默认 ignore）：用于确认 lopdf 提取在真实文档上的表现。
// 运行方式：
//   $env:LEGERE_REAL_PDF="D:\\path\\to.pdf"; cargo test real_pdf_extraction -- --ignored --nocapture
#[test]
#[ignore]
fn real_pdf_extraction_smoke() {
    let Ok(path) = std::env::var("LEGERE_REAL_PDF") else {
        panic!("需要设置 LEGERE_REAL_PDF 指向一个真实 PDF");
    };
    use super::extract::{looks_like_text, LopdfExtractor, TextExtractor};
    let extractor = LopdfExtractor;
    let (meta, pages) = extractor.extract(std::path::Path::new(&path)).expect("解析真实 PDF");
    let with_text = pages.iter().filter(|p| looks_like_text(&p.text)).count();
    let total_chars: usize = pages.iter().map(|p| p.text.chars().count()).sum();
    println!("real pdf: pages={} with_text={} total_chars={} title={:?}", meta.page_count, with_text, total_chars, meta.title);
    for page in pages.iter().take(3) {
        let sample: String = page.text.chars().take(80).collect();
        println!("  p{} chars={} sample={:?}", page.page_no, page.text.chars().count(), sample);
    }
    assert!(meta.page_count > 0, "页数应大于 0");
}
