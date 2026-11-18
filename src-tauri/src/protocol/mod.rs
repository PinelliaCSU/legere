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

/// 内存缓冲版的响应（单测与未来的内存数据源用）。
///
/// 状态码 / Content-Range 一律由 plan_ok 决定，这里只负责按计划切字节：
/// 两套判定并存必然漂移，所以不再重复实现一遍 Range 语义。
pub fn respond(bytes: &[u8], range_header: Option<&str>) -> ProtocolResponse {
    let plan = plan_ok(range_header, bytes.len() as u64);
    let body = match plan.span {
        Some((start, len)) => {
            let from = (start as usize).min(bytes.len());
            let to = from.saturating_add(len as usize).min(bytes.len());
            bytes[from..to].to_vec()
        }
        // 错误计划：响应体就是那一行可读原因。
        None => plan.body_bytes(),
    };
    ProtocolResponse { status: plan.status, content_range: plan.content_range, body }
}

// ---------------------------------------------------------------------------
// 响应规划（docs/05 §6 / R15）：GET 与 HEAD 共用一份计划，失败按成因分派状态码。
//
// 之前的缺口：闭包无论成败都写 Content-Type: application/pdf，且 404 吞掉了
// 「记录缺失 / 文件不存在 / 无权限 / 被占用 / 读失败」，前端无法区分。
// 这里把状态码判定抽成纯函数，协议闭包只负责查库、读字节、发响应。
// ---------------------------------------------------------------------------

pub const CONTENT_TYPE_PDF: &str = "application/pdf";
pub const CONTENT_TYPE_TEXT: &str = "text/plain; charset=utf-8";

/// 一次 GET/HEAD 的完整回包计划（不含字节）。
#[derive(Debug, Clone)]
pub struct PdfPlan {
    pub status: u16,
    pub content_type: &'static str,
    /// 真实 Content-Length：200 为文件长度、206 为区间长度、错误为原因文本长度。
    pub content_length: u64,
    pub content_range: Option<String>,
    /// GET 需要读取的 (start, len)；HEAD 与错误响应为 None（HEAD 不读文件体）。
    pub span: Option<(u64, u64)>,
    /// 错误响应的一行可读原因，同时就是响应体。
    pub reason: Option<String>,
}

impl PdfPlan {
    /// 错误响应体：有原因就用原因文本，正常响应为空（正常字节由调用方读入）。
    pub fn body_bytes(&self) -> Vec<u8> {
        self.reason.as_ref().map(|r| r.as_bytes().to_vec()).unwrap_or_default()
    }
}

/// 200 / 206 / 416 / 400 的正常与 Range 失败判定。
pub fn plan_ok(range_header: Option<&str>, size: u64) -> PdfPlan {
    if size == 0 {
        // 0 字节不是可用的 PDF。回 200 + 空 body 会让 PDF.js 抛 "Invalid PDF structure"，
        // 看不出根因；这里明确 500，并给出可读原因。
        return plan_error(500, "文件为空（0 字节），无法作为 PDF 提供");
    }
    match parse_range(range_header, size) {
        RangeOutcome::Full => PdfPlan {
            status: 200,
            content_type: CONTENT_TYPE_PDF,
            content_length: size,
            content_range: None,
            span: Some((0, size)),
            reason: None,
        },
        RangeOutcome::Partial { start, end } => {
            let len = end.saturating_sub(start).saturating_add(1);
            PdfPlan {
                status: 206,
                content_type: CONTENT_TYPE_PDF,
                content_length: len,
                content_range: Some(format!("bytes {start}-{end}/{size}")),
                span: Some((start, len)),
                reason: None,
            }
        }
        RangeOutcome::Unsatisfiable => {
            let reason = format!("Range 不可满足（文件大小 {size} 字节）");
            PdfPlan {
                status: 416,
                content_type: CONTENT_TYPE_TEXT,
                content_length: reason.len() as u64,
                content_range: Some(format!("bytes */{size}")),
                span: None,
                reason: Some(reason),
            }
        }
        RangeOutcome::Invalid => plan_error(400, "Range 头非法或不支持（只接受单段 bytes=start-end）"),
    }
}

/// 错误计划：text/plain + 一行原因，Content-Length 为原因字节数。
pub fn plan_error(status: u16, reason: impl Into<String>) -> PdfPlan {
    let reason = reason.into();
    PdfPlan {
        status,
        content_type: CONTENT_TYPE_TEXT,
        content_length: reason.len() as u64,
        content_range: None,
        span: None,
        reason: Some(reason),
    }
}

/// 文件系统错误的成因分派：410 不存在 / 403 无权限 / 423 被占用 / 500 其它。
pub fn status_for_io_error(err: &std::io::Error) -> u16 {
    if is_os_lock(&err.raw_os_error()) {
        return 423;
    }
    match err.kind() {
        std::io::ErrorKind::NotFound => 410,
        std::io::ErrorKind::PermissionDenied => 403,
        std::io::ErrorKind::WouldBlock => 423,
        _ => 500,
    }
}

/// Windows 上「文件被占用」是 ERROR_SHARING_VIOLATION(32) / ERROR_LOCK_VIOLATION(33)，
/// 不落进 ErrorKind::WouldBlock，必须显式识别，否则会被误报成 500。
fn is_os_lock(code: &Option<i32>) -> bool {
    #[cfg(windows)]
    {
        return matches!(code, Some(32) | Some(33));
    }
    #[cfg(not(windows))]
    {
        let _ = code;
        false
    }
}

/// 查库失败的分派：404 只有「数据库里没有这条记录」一种。
pub fn status_for_lookup_error(err: &crate::error::ApiError) -> u16 {
    use crate::error::ApiErrorCode;
    match err.code {
        ApiErrorCode::NotFound => 404,
        ApiErrorCode::Permission => 403,
        ApiErrorCode::Busy => 423,
        ApiErrorCode::InvalidArg => 400,
        _ => 500,
    }
}

/// 查库失败的响应文本：带上错误码，前端/日志里能区分 404 与 410。
pub fn lookup_error_reason(err: &crate::error::ApiError) -> String {
    format!("{}: {}", err.code.as_str(), err.message)
}

/// 读文件失败的响应文本（含路径，便于定位是哪个库根下的文件）。
pub fn io_error_reason(path: &std::path::Path, err: &std::io::Error) -> String {
    format!("{}: {}", path.display(), err)
}

/// 统一构造响应：CORS、Accept-Ranges、真实 Content-Length 全部在这里，避免分支漏头。
pub fn build_response(plan: &PdfPlan, body: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
    // 有 body 时以真实字节数为准：文件在 stat 与 read 之间被截断时，声明长度必须与 body 一致，
    // 否则客户端等不到字节。HEAD/204 无 body，沿用计划里的真实长度。
    let declared = if body.is_empty() { plan.content_length } else { body.len() as u64 };
    let mut builder = tauri::http::Response::builder()
        .status(plan.status)
        .header("Content-Type", plan.content_type)
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", declared.to_string())
        .header("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN)
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        .header("Access-Control-Allow-Headers", cors_allow_headers())
        .header("Access-Control-Expose-Headers", cors_expose_headers());
    if let Some(value) = &plan.content_range {
        builder = builder.header("Content-Range", value);
    }
    if plan.status == 204 {
        builder = builder.header("Allow", "GET, HEAD, OPTIONS");
    }
    builder.body(body).unwrap_or_else(|_| {
        tauri::http::Response::builder()
            .status(500)
            .body(Vec::new())
            .expect("构造 500 响应不应失败")
    })
}

/// OPTIONS 预检：204 + Allow + CORS，无 body。
pub fn build_preflight_response() -> tauri::http::Response<Vec<u8>> {
    let plan = PdfPlan {
        status: 204,
        content_type: CONTENT_TYPE_TEXT,
        content_length: 0,
        content_range: None,
        span: None,
        reason: None,
    };
    build_response(&plan, Vec::new())
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
    fn read_span_reads_real_file_bytes() {
        // 用仓库自带的 sample.pdf 验证真实文件读取（不依赖数据库）。
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/sample.pdf");
        let size = std::fs::metadata(&path).expect("sample.pdf 应存在").len();
        assert!(size > 100, "sample.pdf 大小异常: {size}");

        let head = read_span(&path, 0, 5).expect("读取文件头");
        assert_eq!(&head[..4], b"%PDF", "文件头必须是 %PDF");

        let tail = read_span(&path, size.saturating_sub(8), 8).expect("读取文件尾");
        assert!(
            String::from_utf8_lossy(&tail).contains("%%EOF"),
            "文件尾应包含 %%EOF，实得 {:?}",
            String::from_utf8_lossy(&tail)
        );

        // 越界读取应安全返回空（不 panic）
        let beyond = read_span(&path, size + 10, 10).expect("越界读取不应报错");
        assert!(beyond.is_empty());
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

    // ---- R15：GET/HEAD 的成功与每一条失败都必须可区分 ----

    fn header<'a>(resp: &'a tauri::http::Response<Vec<u8>>, name: &str) -> &'a str {
        resp.headers()
            .get(name)
            .unwrap_or_else(|| panic!("缺少响应头 {name}"))
            .to_str()
            .expect("响应头应为 ASCII")
    }

    #[test]
    fn head_has_real_length_and_three_headers_without_body() {
        // 用真实文件的真实长度做 HEAD：闭包不读 span，body 为空，但头部必须如实。
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/sample.pdf");
        let size = std::fs::metadata(&path).expect("sample.pdf 应存在").len();
        let plan = plan_ok(None, size);
        assert_eq!(plan.status, 200);
        let resp = build_response(&plan, Vec::new());
        assert_eq!(resp.status(), 200);
        assert_eq!(header(&resp, "content-type"), CONTENT_TYPE_PDF);
        assert_eq!(header(&resp, "accept-ranges"), "bytes");
        assert_eq!(header(&resp, "content-length"), size.to_string());
        assert!(resp.body().is_empty(), "HEAD 响应不得带 body");
        assert_eq!(header(&resp, "access-control-allow-origin"), CORS_ALLOW_ORIGIN);
        assert_eq!(header(&resp, "access-control-expose-headers"), cors_expose_headers());
    }

    #[test]
    fn get_without_range_is_200_with_full_span() {
        let body = vec![9u8; 4096];
        let plan = plan_ok(None, body.len() as u64);
        assert_eq!(plan.status, 200);
        assert_eq!(plan.span, Some((0, 4096)));
        assert!(plan.content_range.is_none(), "200 不得带 Content-Range");
        let resp = build_response(&plan, body);
        assert_eq!(resp.status(), 200);
        assert_eq!(header(&resp, "content-length"), "4096");
        assert_eq!(resp.body().len(), 4096);
    }

    #[test]
    fn get_range_0_99_is_206_with_content_range() {
        let plan = plan_ok(Some("bytes=0-99"), 1000);
        assert_eq!(plan.status, 206);
        assert_eq!(plan.span, Some((0, 100)));
        assert_eq!(plan.content_range.as_deref(), Some("bytes 0-99/1000"));
        let resp = build_response(&plan, vec![0u8; 100]);
        assert_eq!(resp.status(), 206);
        assert_eq!(header(&resp, "content-range"), "bytes 0-99/1000");
        assert_eq!(header(&resp, "content-length"), "100");
        assert_eq!(header(&resp, "content-type"), CONTENT_TYPE_PDF);
    }

    #[test]
    fn start_beyond_size_is_416_with_star_size() {
        let plan = plan_ok(Some("bytes=1000-"), 1000);
        assert_eq!(plan.status, 416);
        assert_eq!(plan.content_range.as_deref(), Some("bytes */1000"));
        assert!(plan.reason.is_some(), "416 必须带可读原因");
        let resp = build_response(&plan, plan.body_bytes());
        assert_eq!(resp.status(), 416);
        assert_eq!(header(&resp, "content-range"), "bytes */1000");
        assert_eq!(header(&resp, "content-type"), CONTENT_TYPE_TEXT);
        assert!(!resp.body().is_empty());
    }

    #[test]
    fn non_bytes_unit_is_400() {
        let plan = plan_ok(Some("items=0-10"), 1000);
        assert_eq!(plan.status, 400);
        assert_eq!(plan.content_type, CONTENT_TYPE_TEXT);
        let resp = build_response(&plan, plan.body_bytes());
        assert_eq!(resp.status(), 400);
        assert!(!resp.body().is_empty(), "400 必须带一行原因");
    }

    #[test]
    fn illegal_syntax_is_400() {
        for raw in ["bytes=abc", "bytes=10", "bytes="] {
            let plan = plan_ok(Some(raw), 1000);
            assert_eq!(plan.status, 400, "Range {raw} 应判 400");
            assert!(plan.span.is_none(), "400 不应要求读字节");
        }
    }

    #[test]
    fn reversed_range_is_400() {
        let plan = plan_ok(Some("bytes=100-50"), 1000);
        assert_eq!(plan.status, 400);
        let resp = build_response(&plan, plan.body_bytes());
        assert_eq!(header(&resp, "content-type"), CONTENT_TYPE_TEXT);
    }

    #[test]
    fn multi_range_is_400() {
        let plan = plan_ok(Some("bytes=0-10,20-30"), 1000);
        assert_eq!(plan.status, 400);
        assert!(plan.reason.as_deref().unwrap_or("").contains("单段"));
    }

    #[test]
    fn suffix_range_covers_file_tail() {
        let plan = plan_ok(Some("bytes=-100"), 1000);
        assert_eq!(plan.status, 206);
        assert_eq!(plan.span, Some((900, 100)));
        assert_eq!(plan.content_range.as_deref(), Some("bytes 900-999/1000"));
        assert_eq!(plan.content_length, 100);
    }

    #[test]
    fn oversized_span_is_truncated_and_declared() {
        let size = 64 * 1024 * 1024;
        let plan = plan_ok(Some("bytes=0-"), size);
        assert_eq!(plan.status, 206);
        assert_eq!(plan.span, Some((0, RANGE_MAX_BYTES)));
        assert_eq!(plan.content_length, RANGE_MAX_BYTES);
        assert_eq!(
            plan.content_range.as_deref(),
            Some(format!("bytes 0-{}/{size}", RANGE_MAX_BYTES - 1).as_str())
        );
    }

    #[test]
    fn empty_file_is_500_with_readable_reason() {
        let plan = plan_ok(None, 0);
        assert_eq!(plan.status, 500);
        assert_eq!(plan.content_type, CONTENT_TYPE_TEXT);
        assert!(plan.reason.as_deref().unwrap_or("").contains("0 字节"));
        let resp = build_response(&plan, plan.body_bytes());
        assert_eq!(resp.status(), 500);
        assert!(!resp.body().is_empty());
    }

    #[test]
    fn io_error_kinds_map_to_distinct_statuses() {
        let make = |kind| std::io::Error::new(kind, "x");
        assert_eq!(status_for_io_error(&make(std::io::ErrorKind::NotFound)), 410);
        assert_eq!(status_for_io_error(&make(std::io::ErrorKind::PermissionDenied)), 403);
        assert_eq!(status_for_io_error(&make(std::io::ErrorKind::WouldBlock)), 423);
        assert_eq!(status_for_io_error(&make(std::io::ErrorKind::UnexpectedEof)), 500);
        assert_eq!(status_for_io_error(&make(std::io::ErrorKind::Other)), 500);
    }

    #[cfg(windows)]
    #[test]
    fn windows_sharing_violation_is_423_not_500() {
        // ERROR_SHARING_VIOLATION(32) / ERROR_LOCK_VIOLATION(33)
        assert_eq!(status_for_io_error(&std::io::Error::from_raw_os_error(32)), 423);
        assert_eq!(status_for_io_error(&std::io::Error::from_raw_os_error(33)), 423);
    }

    #[test]
    fn lookup_errors_map_to_404_403_423_500() {
        use crate::error::{ApiError, ApiErrorCode};
        let missing = ApiError::new(ApiErrorCode::NotFound, "找不到该文献", false);
        assert_eq!(status_for_lookup_error(&missing), 404);
        assert!(lookup_error_reason(&missing).contains("E_NOT_FOUND"));

        let denied = ApiError::new(ApiErrorCode::Permission, "无访问权限", false);
        assert_eq!(status_for_lookup_error(&denied), 403);

        let busy = ApiError::new(ApiErrorCode::Busy, "文件被占用", true);
        assert_eq!(status_for_lookup_error(&busy), 423);

        let db = ApiError::new(ApiErrorCode::Db, "数据库错误", true);
        assert_eq!(status_for_lookup_error(&db), 500);
        assert!(lookup_error_reason(&db).contains("E_DB"));
    }

    #[test]
    fn preflight_is_204_with_allow_and_range_headers() {
        let resp = build_preflight_response();
        assert_eq!(resp.status(), 204);
        assert!(resp.body().is_empty());
        assert_eq!(header(&resp, "allow"), "GET, HEAD, OPTIONS");
        assert_eq!(header(&resp, "access-control-allow-methods"), "GET, HEAD, OPTIONS");
        assert!(header(&resp, "access-control-allow-headers")
            .split(',')
            .any(|h| h.trim().eq_ignore_ascii_case("range")));
        assert_eq!(header(&resp, "access-control-expose-headers"), cors_expose_headers());
    }

    #[test]
    fn error_responses_still_expose_range_headers() {
        let plan = plan_error(403, "无访问权限");
        let resp = build_response(&plan, plan.body_bytes());
        assert_eq!(resp.status(), 403);
        assert_eq!(header(&resp, "content-type"), CONTENT_TYPE_TEXT);
        let exposed = header(&resp, "access-control-expose-headers");
        for name in ["content-range", "accept-ranges", "content-length", "content-type"] {
            assert!(exposed.contains(name), "Expose-Headers 缺 {name}");
        }
        assert_eq!(header(&resp, "accept-ranges"), "bytes");
        assert!(!resp.body().is_empty(), "错误响应必须带一行可读原因");
    }

    #[test]
    fn read_span_handles_cjk_and_space_names() {
        let dir = std::env::temp_dir().join(format!("legere-span-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = dir.join("中文 名称 报告 (v2).pdf");
        let payload: Vec<u8> = (0..=255u8).cycle().take(64 * 1024).collect();
        std::fs::write(&path, &payload).expect("写临时文件");

        assert_eq!(read_span(&path, 0, 4).expect("读头部"), payload[..4].to_vec());
        assert_eq!(
            read_span(&path, payload.len() as u64 - 8, 8).expect("读尾部"),
            payload[payload.len() - 8..].to_vec()
        );
        assert_eq!(read_span(&path, 1000, 16).expect("读中部"), payload[1000..1016].to_vec());

        std::fs::remove_dir_all(&dir).ok();
    }
}
/// 从文件读取 [start, start+len) 区间的字节（不整文件读入，避免大 PDF 内存峰值）。
pub fn read_span(path: &std::path::Path, start: u64, len: u64) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut buf = vec![0u8; len as usize];
    let mut filled = 0usize;
    while filled < buf.len() {
        let read = file.read(&mut buf[filled..])?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    buf.truncate(filled);
    Ok(buf)
}