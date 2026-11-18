// M11 单测：查询净化、MATCH 构造、命中区间与上下文。

use crate::contracts::dto::SearchMode;

use super::{build_match, hit_ranges, sanitize_query, snippet_for};

#[test]
fn sanitize_strips_fts_syntax() {
    assert_eq!(sanitize_query("中文 \"分词\" * AND"), "中文 分词  AND");
    assert_eq!(sanitize_query("   "), "");
    assert_eq!(sanitize_query("a-b(c)"), "abc");
}

#[test]
fn match_expression_shapes() {
    let tokens = vec!["中文".to_string(), "分词".to_string()];
    assert_eq!(build_match(&tokens, SearchMode::Phrase).unwrap(), "\"中文 分词\"");
    assert_eq!(build_match(&tokens, SearchMode::Terms).unwrap(), "中文 AND 分词");
    assert!(build_match(&[], SearchMode::Phrase).is_none());
}

#[test]
fn ranges_use_char_offsets() {
    let raw = "中文分词的效果";
    let ranges = hit_ranges(raw, &["分词".to_string()]);
    assert_eq!(ranges.len(), 1);
    let (start, end) = ranges[0];
    // 字符索引 2..4 -> 分词
    let chars: Vec<char> = raw.chars().collect();
    let hit: String = chars[start as usize..end as usize].iter().collect();
    assert_eq!(hit, "分词");
}

#[test]
fn snippet_has_ellipsis_when_truncated() {
    let raw = "前面很多字".repeat(10) + "目标词" + &"后面很多字".repeat(10);
    let ranges = hit_ranges(&raw, &["目标词".to_string()]);
    let snip = snippet_for(&raw, &ranges);
    assert!(snip.contains("目标词"));
    assert!(snip.starts_with('…') && snip.ends_with('…'));
    assert!(snip.chars().count() < 60);
}
