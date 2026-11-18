// pdf:// 的 Range 判定（契约 docs/05 §6 / 修订 R15）。纯函数，便于单测。
//
// 判定顺序：语法非法 -> Invalid(400)；start >= size -> Unsatisfiable(416)；
// end >= size 或跨度超上限 -> 截断后 Partial(206)。end 越界夹取是服务端标准行为，
// 而 start 越界必须明确失败：夹取会让 PDF.js 把错位字节当成目标区间解析。

/// 单次 Range 跨度上限（R15）。超出则截断并在 Content-Range 中如实声明。
pub const RANGE_MAX_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeOutcome {
    /// 没有 Range 头（或非 bytes 单位）：返回 200 + 全量。
    Full,
    /// 206 + Content-Range: bytes start-end/size。
    Partial { start: u64, end: u64 },
    /// 416 + Content-Range: bytes */size。
    Unsatisfiable,
    /// 400。
    Invalid,
}

pub fn parse_range(header: Option<&str>, size: u64) -> RangeOutcome {
    let Some(raw) = header else { return RangeOutcome::Full };
    let raw = raw.trim();
    if raw.is_empty() {
        return RangeOutcome::Full;
    }
    let Some(spec) = raw.strip_prefix("bytes=") else {
        // 非 bytes 单位：按规范应忽略，但我们只服务 PDF.js，明确失败更利于排障。
        return RangeOutcome::Invalid;
    };
    let spec = spec.trim();
    if spec.contains(',') {
        // 多段 Range 不支持：明确失败，而不是返回错误拼接的字节。
        return RangeOutcome::Invalid;
    }
    let Some((start_raw, end_raw)) = spec.split_once('-') else {
        return RangeOutcome::Invalid;
    };
    let start_raw = start_raw.trim();
    let end_raw = end_raw.trim();

    if size == 0 {
        return RangeOutcome::Unsatisfiable;
    }

    let (start, wanted_end) = if start_raw.is_empty() {
        // 后缀形式 bytes=-N：取最后 N 字节。
        let Ok(suffix) = end_raw.parse::<u64>() else { return RangeOutcome::Invalid };
        if suffix == 0 {
            return RangeOutcome::Unsatisfiable;
        }
        let start = size.saturating_sub(suffix);
        (start, size - 1)
    } else {
        let Ok(start) = start_raw.parse::<u64>() else { return RangeOutcome::Invalid };
        if start >= size {
            return RangeOutcome::Unsatisfiable;
        }
        if end_raw.is_empty() {
            (start, size - 1)
        } else {
            let Ok(end) = end_raw.parse::<u64>() else { return RangeOutcome::Invalid };
            if end < start {
                return RangeOutcome::Invalid;
            }
            (start, end.min(size - 1))
        }
    };

    let capped_end = wanted_end.min(start.saturating_add(RANGE_MAX_BYTES - 1));
    RangeOutcome::Partial { start, end: capped_end }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_header_is_full() {
        assert_eq!(parse_range(None, 1000), RangeOutcome::Full);
        assert_eq!(parse_range(Some("   "), 1000), RangeOutcome::Full);
    }

    #[test]
    fn simple_range() {
        assert_eq!(parse_range(Some("bytes=0-99"), 1000), RangeOutcome::Partial { start: 0, end: 99 });
    }

    #[test]
    fn open_ended_range_goes_to_eof() {
        assert_eq!(parse_range(Some("bytes=100-"), 1000), RangeOutcome::Partial { start: 100, end: 999 });
    }

    #[test]
    fn end_beyond_eof_is_clamped() {
        assert_eq!(parse_range(Some("bytes=900-5000"), 1000), RangeOutcome::Partial { start: 900, end: 999 });
    }

    #[test]
    fn start_beyond_eof_is_unsatisfiable() {
        assert_eq!(parse_range(Some("bytes=1000-"), 1000), RangeOutcome::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=5000-6000"), 1000), RangeOutcome::Unsatisfiable);
    }

    #[test]
    fn invalid_syntax() {
        assert_eq!(parse_range(Some("bytes=abc"), 1000), RangeOutcome::Invalid);
        assert_eq!(parse_range(Some("bytes=10"), 1000), RangeOutcome::Invalid);
        assert_eq!(parse_range(Some("bytes=100-50"), 1000), RangeOutcome::Invalid);
        assert_eq!(parse_range(Some("items=0-10"), 1000), RangeOutcome::Invalid);
        assert_eq!(parse_range(Some("bytes=0-10,20-30"), 1000), RangeOutcome::Invalid);
    }

    #[test]
    fn suffix_range() {
        assert_eq!(parse_range(Some("bytes=-100"), 1000), RangeOutcome::Partial { start: 900, end: 999 });
        assert_eq!(parse_range(Some("bytes=-0"), 1000), RangeOutcome::Unsatisfiable);
    }

    #[test]
    fn span_is_capped() {
        let size = 64 * 1024 * 1024;
        match parse_range(Some("bytes=0-"), size) {
            RangeOutcome::Partial { start, end } => {
                assert_eq!(start, 0);
                assert_eq!(end, RANGE_MAX_BYTES - 1);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn empty_file_is_unsatisfiable_for_any_range() {
        assert_eq!(parse_range(Some("bytes=0-10"), 0), RangeOutcome::Unsatisfiable);
    }
}
