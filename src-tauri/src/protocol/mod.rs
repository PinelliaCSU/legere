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

/// 跨源访问说明：页面在 tauri://localhost，而协议在 pdf://localhost，属于跨源请求。
/// 不带这些响应头时浏览器会直接判 fetch 失败（实测：请求到达后端但前端 TypeError: Failed to fetch）。
/// Range 不是 CORS 安全列表内的请求头，因此还必须应答 OPTIONS 预检。
pub const CORS_ALLOW_ORIGIN: &str = "*";

/// 允许预检通过的请求头与方法。
pub fn cors_allow_headers() -> &'static str {
    "range, if-range, accept, content-type"
}

/// 需要暴露给脚本读取的响应头（否则 PDF.js 读不到 Content-Range）。
pub fn cors_expose_headers() -> &'static str {
    "content-range, accept-ranges, content-length, content-type"
}

/// OPTIONS 预检响应：204 + CORS 头，无 body。
pub fn preflight_response() -> ProtocolResponse {
    ProtocolResponse { status: 204, content_range: None, body: Vec::new() }
}

/// 从 uri 里解析 document id。
///
/// 必须同时接受两种形态（V-06 未定前不假设单一形态）：
///   pdf://doc/17        -> authority = "doc"，id 在路径首段
///   http://pdf.localhost/doc/17 -> authority 是主机，id 在 "doc" 之后
pub fn parse_document_id(uri: &str) -> Option<i64> {
    let after_scheme = match uri.find("://") {
        Some(idx) => &uri[idx + 3..],
        None => uri,
    };

    let (authority, path) = match after_scheme.find('/') {
        Some(slash) => (&after_scheme[..slash], &after_scheme[slash..]),
        None => (after_scheme, ""),
    };

    let path = path.split(['?', '#']).next().unwrap_or(path);
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    if authority == "doc" {
        return segments.first().and_then(|s| s.parse::<i64>().ok());
    }

    match (segments.first(), segments.get(1)) {
        (Some(&"doc"), Some(id)) => id.parse::<i64>().ok(),
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
        // 形态 A：scheme 后第一段就是 "doc"（pdf://doc/17）
        assert_eq!(parse_document_id("pdf://doc/17?v=1"), Some(17));
        assert_eq!(parse_document_id("pdf://doc/17"), Some(17));
        // 形态 B：V-06 实测形态 —— Windows 上 Tauri 把 pdf:// 映射成 pdf://localhost/doc/N
        // （2026-11-18 取证：日志中 uri=pdf://localhost/doc/1）
        assert_eq!(parse_document_id("pdf://localhost/doc/17"), Some(17));
        assert_eq!(parse_document_id("pdf://localhost/doc/17?v=1"), Some(17));
        // 兼容 http://pdf.localhost 形态（旧假设，保留以避免回归）
        assert_eq!(parse_document_id("http://pdf.localhost/doc/17?v=1"), Some(17));
        assert_eq!(parse_document_id("http://pdf.localhost/doc/17"), Some(17));
        // 结尾斜杠与查询串不影响
        assert_eq!(parse_document_id("http://pdf.localhost/doc/17/?v=9"), Some(17));
        // 非法与不匹配
        assert_eq!(parse_document_id("pdf://doc/abc"), None);
        assert_eq!(parse_document_id("pdf://other/17"), None);
        assert_eq!(parse_document_id("pdf://doc/"), None);
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
