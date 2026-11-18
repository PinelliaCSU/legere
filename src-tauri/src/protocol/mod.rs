// pdf:// 协议壳（M01 交付）。真实 URL 形态与 Range 支持性需按 V-06 探针在目标平台确认：
// Windows 上自定义 scheme 通常会变成 http://pdf.localhost/...，因此路由解析必须同时接受
// 两种前缀，而不是假设一种。文档不全时以探针实测的 req.uri() 为准，并回填 docs/02 §1。

pub mod range;

pub use range::{parse_range, RangeOutcome, RANGE_MAX_BYTES};

#[derive(Debug, Clone)]
pub struct ProtocolResponse {
    pub status: u16,
    pub content_range: Option<String>,
    pub body: Vec<u8>,
}

/// 从 uri 里解析 document id：同时接受 pdf://doc/17?... 与 /doc/17?... 
pub fn parse_document_id(uri: &str) -> Option<i64> {
    let path = match uri.find("://") {
        Some(idx) => {
            let rest = &uri[idx + 3..];
            match rest.find('/') {
                Some(slash) => &rest[slash..],
                None => return None,
            }
        }
        None => uri,
    };
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let mut segments = path.trim_start_matches('/').split('/');
    match (segments.next(), segments.next()) {
        (Some("doc"), Some(id)) => id.parse::<i64>().ok(),
        _ => None,
    }
}

/// 生成响应。size 必须来自真实文件长度，而不是请求声明的值。
pub fn respond(bytes: &[u8], range_header: Option<&str>) -> ProtocolResponse {
    let size = bytes.len() as u64;
    match parse_range(range_header, size) {
        RangeOutcome::Full => ProtocolResponse { status: 200, content_range: None, body: bytes.to_vec() },
        RangeOutcome::Partial { start, end } => {
            let slice = &bytes[start as usize..=(end as usize).min(bytes.len().saturating_sub(1))];
            ProtocolResponse {
                status: 206,
                content_range: Some(format!("bytes {start}-{end}/{size}")),
                body: slice.to_vec(),
            }
        }
        RangeOutcome::Unsatisfiable => ProtocolResponse {
            status: 416,
            content_range: Some(format!("bytes */{size}")),
            body: Vec::new(),
        },
        RangeOutcome::Invalid => ProtocolResponse { status: 400, content_range: None, body: Vec::new() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_id_from_both_uri_shapes() {
        assert_eq!(parse_document_id("pdf://doc/17?v=1"), Some(17));
        assert_eq!(parse_document_id("http://pdf.localhost/doc/17?v=1"), Some(17));
        assert_eq!(parse_document_id("pdf://doc/17"), Some(17));
        assert_eq!(parse_document_id("pdf://doc/abc"), None);
        assert_eq!(parse_document_id("pdf://other/17"), None);
        assert_eq!(parse_document_id(""), None);
    }

    #[test]
    fn respond_full_and_partial() {
        let body = vec![7u8; 100];
        let full = respond(&body, None);
        assert_eq!(full.status, 200);
        assert_eq!(full.body.len(), 100);

        let partial = respond(&body, Some("bytes=10-19"));
        assert_eq!(partial.status, 206);
        assert_eq!(partial.body.len(), 10);
        assert_eq!(partial.content_range.as_deref(), Some("bytes 10-19/100"));

        let unsat = respond(&body, Some("bytes=200-"));
        assert_eq!(unsat.status, 416);
        assert_eq!(unsat.content_range.as_deref(), Some("bytes */100"));
    }
}
