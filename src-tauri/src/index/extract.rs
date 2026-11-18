// 页面级文本提取（docs/03 M09）。
//
// 用 lopdf 解析内容流，只处理文本显示算子 Tj / TJ / ' / "，不追求版面还原：
// 索引需要的只是「这一页有哪些字」，坐标与排版由 PDF.js 那一侧负责。
//
// 已知限制（诚实标注，不伪装）：CID/子集字体的 ToUnicode 未解码时可能抽出乱码；
// 因此提取后做一次质量判定，质量不达标就按 no_text 处理，宁可不可检索也不要污染索引。

use std::path::Path;

use lopdf::{Document, Object};

use crate::error::{ApiError, ApiErrorCode};

#[derive(Debug, Clone)]
pub struct PageText {
    pub page_no: i64,
    pub text: String,
}

#[derive(Debug, Clone, Default)]
pub struct DocMeta {
    pub page_count: i64,
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub keywords: Option<String>,
    pub producer: Option<String>,
    pub creator: Option<String>,
    pub creation_date: Option<String>,
}

pub trait TextExtractor: Send + Sync {
    fn name(&self) -> &'static str;
    fn extract(&self, path: &Path) -> Result<(DocMeta, Vec<PageText>), ApiError>;
}

/// 默认实现：lopdf（纯 Rust，无外部二进制依赖）。
pub struct LopdfExtractor;

impl TextExtractor for LopdfExtractor {
    fn name(&self) -> &'static str {
        "lopdf"
    }

    fn extract(&self, path: &Path) -> Result<(DocMeta, Vec<PageText>), ApiError> {
        let doc = Document::load(path).map_err(|e| {
            let msg = e.to_string();
            if msg.to_lowercase().contains("encrypt") {
                ApiError::new(ApiErrorCode::PdfEncrypted, "这个 PDF 有密码保护，暂不支持打开", false)
                    .with_detail(msg)
            } else {
                ApiError::new(ApiErrorCode::PdfCorrupt, "这个 PDF 已损坏，无法打开", false)
                    .with_detail(msg)
            }
        })?;

        let mut meta = DocMeta::default();
        if let Ok(info) = doc.trailer.get(b"Info").and_then(|o| o.as_dict()) {
            let get = |key: &[u8]| -> Option<String> {
                info.get(key)
                    .ok()
                    .and_then(|o| o.as_str().ok())
                    .map(|s| String::from_utf8_lossy(s).trim().to_string())
                    .filter(|s| !s.is_empty())
            };
            meta.title = get(b"Title");
            meta.author = get(b"Author");
            meta.subject = get(b"Subject");
            meta.keywords = get(b"Keywords");
            meta.producer = get(b"Producer");
            meta.creator = get(b"Creator");
            meta.creation_date = get(b"CreationDate");
        }

        let pages = doc.get_pages();
        meta.page_count = pages.len() as i64;

        let mut out = Vec::with_capacity(pages.len());
        for (page_no, page_id) in pages {
            let text = match doc.get_page_content(page_id) {
                Ok(content) => extract_from_content(&content),
                Err(err) => {
                    tracing::warn!(page_no, ?err, "读取页面内容流失败，按空页处理");
                    String::new()
                }
            };
            out.push(PageText { page_no: i64::from(page_no), text });
        }

        Ok((meta, out))
    }
}

/// 从内容流里收集文本显示算子的字符串。
pub fn extract_from_content(content: &[u8]) -> String {
    let Ok(parsed) = lopdf::content::Content::decode(content) else {
        return String::new();
    };
    let mut buf = String::new();
    for op in parsed.operations {
        match op.operator.as_str() {
            "Tj" | "'" | "\"" => {
                if let Some(Object::String(bytes, _)) = op.operands.first() {
                    push_pdf_string(&mut buf, bytes);
                }
            }
            "TJ" => {
                if let Some(Object::Array(items)) = op.operands.first() {
                    for item in items {
                        if let Object::String(bytes, _) = item {
                            push_pdf_string(&mut buf, bytes);
                        }
                    }
                }
            }
            "ET" | "Td" | "TD" | "T*" | "TL" => buf.push('\n'),
            _ => {}
        }
    }
    buf
}

fn push_pdf_string(buf: &mut String, bytes: &[u8]) {
    // PDF 文本字符串可能是 PDFDocEncoding 或 UTF-16BE（带 BOM）。
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        buf.push_str(&String::from_utf16_lossy(&units));
    } else {
        buf.push_str(&String::from_utf8_lossy(bytes));
    }
}

/// 文本质量判定：乱码比例过高就当没有文本层（扫描件/CID 未解码）。
pub fn looks_like_text(text: &str) -> bool {
    let total = text.chars().count();
    if total == 0 {
        return false;
    }
    let bad = text
        .chars()
        .filter(|c| *c == '\u{FFFD}' || (!c.is_whitespace() && !c.is_alphanumeric() && !c.is_ascii_punctuation() && !is_cjk(*c)))
        .count();
    let meaningful = text.chars().filter(|c| c.is_alphanumeric()).count();
    // 规则：必须有足够多的字母/汉字，且坏字符占比 < 30%。
    meaningful * 10 >= total && bad * 10 <= total * 3
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x3000..=0x303F | 0xFF00..=0xFFEF)
}
