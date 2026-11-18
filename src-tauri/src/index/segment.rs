// 中文分词（docs/07 §2-§3）：索引侧与查询侧必须用同一套配置，否则召回不一致（V-04）。

use std::sync::OnceLock;

use jieba_rs::Jieba;

fn jieba() -> &'static Jieba {
    static JIEBA: OnceLock<Jieba> = OnceLock::new();
    JIEBA.get_or_init(Jieba::new)
}

/// 切分为 token 序列（精确模式，关闭 HMM：结果可复现）。
pub fn tokens(text: &str) -> Vec<String> {
    jieba()
        .cut(text, false)
        .into_iter()
        .filter_map(|token| normalize_token(token.word))
        .collect()
}

/// 单 token 归一化：去空白与标点，保留字母/数字/汉字。
fn normalize_token(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_lowercase();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// 写入 FTS5 的 seg_text：token 之间用单空格分隔（docs/04 §7）。
pub fn build_seg_text(raw: &str) -> String {
    tokens(raw).join(" ")
}

/// 查询串切分：与文档侧共用同一实现（对称性）。
pub fn segment_query(query: &str) -> Vec<String> {
    tokens(query)
}
