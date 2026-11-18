// M11 · 全局检索（docs/03 M11、docs/07）。
//
// 关键点（全部为已定契约）：
// - 查询串先 sanitize 去掉 FTS5 语法字符，再用与文档侧同一分词器切分（V-04 对称性）。
// - 不用 snippet()/highlight()：它们作用在分词后的 seg_text 上，会插入空格破坏原文（D06）。
// - 上下文与命中区间在 raw_text 上自算，返回字符索引区间（左闭右开）。

use std::collections::BTreeMap;

use crate::contracts::dto::{
    DocumentDto, GlobalSearchHitDto, GlobalSearchPageDto, GlobalSearchParams, GlobalSearchResultDto,
    MetaState, SearchCountDto, SearchMode, TextState,
};
use crate::db::{db_err, Db};
use crate::error::{ApiError, ApiErrorCode};
use crate::index::segment_query;

const CONTEXT_RADIUS: usize = 20;

#[cfg(test)]
mod tests;

/// 只保留文字与数字，去掉 FTS5 语法字符（防止注入与语法错误）。
pub fn sanitize_query(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .trim()
        .to_string()
}

/// 构造 MATCH 表达式：短语模式用引号包裹相邻 token，宽松模式用 AND 连接。
pub fn build_match(tokens: &[String], mode: SearchMode) -> Option<String> {
    if tokens.is_empty() {
        return None;
    }
    match mode {
        SearchMode::Phrase => Some(format!("\"{}\"", tokens.join(" "))),
        SearchMode::Terms => Some(tokens.join(" AND ")),
    }
}

/// 在原文上找命中区间（按 token 逐个定位，大小写不敏感）。
pub fn hit_ranges(raw: &str, tokens: &[String]) -> Vec<(i64, i64)> {
    let lower = raw.to_lowercase();
    let char_map: Vec<(usize, char)> = raw.char_indices().collect();
    let mut ranges: Vec<(i64, i64)> = Vec::new();

    for token in tokens {
        let needle = token.to_lowercase();
        if needle.is_empty() {
            continue;
        }
        let mut from = 0usize;
        while let Some(pos) = lower[from..].find(&needle) {
            let abs = from + pos;
            // byte offset -> char offset
            let start_char = char_map.partition_point(|(b, _)| *b < abs) as i64;
            let end_char = char_map.partition_point(|(b, _)| *b < abs + needle.len()) as i64;
            if end_char > start_char {
                ranges.push((start_char, end_char));
            }
            from = abs + needle.len();
            if from >= lower.len() {
                break;
            }
        }
    }
    ranges.sort();
    ranges.dedup();
    ranges
}

/// 取包含首个命中的上下文窗口（字符窗口）。
pub fn snippet_for(raw: &str, ranges: &[(i64, i64)]) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let Some((first_start, _)) = ranges.first().copied() else {
        return raw.chars().take(CONTEXT_RADIUS * 2).collect();
    };
    let start = (first_start as usize).saturating_sub(CONTEXT_RADIUS);
    // 前后各 CONTEXT_RADIUS 个字符：窗口总长约 40，适配窄面板一行显示。
    let end = ((first_start as usize) + CONTEXT_RADIUS).min(chars.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(&chars[start..end]);
    if end < chars.len() {
        out.push('…');
    }
    out.replace(['\n', '\r'], " ")
}

struct HitRow {
    document_id: i64,
    page_no: i64,
    raw_text: String,
}

pub fn search_global(db: &Db, params: &GlobalSearchParams) -> Result<GlobalSearchPageDto, ApiError> {
    let started = std::time::Instant::now();
    let cleaned = sanitize_query(&params.query);
    let tokens = segment_query(&cleaned);
    let Some(match_expr) = build_match(&tokens, params.mode) else {
        return Ok(GlobalSearchPageDto {
            items: Vec::new(),
            total_documents: 0,
            offset: params.document_offset,
            limit: params.document_limit,
            took_ms: started.elapsed().as_millis() as i64,
        });
    };

    let hits_per_doc = params.hits_per_document.clamp(1, 5);
    let doc_limit = params.document_limit.clamp(1, 50);
    let doc_offset = params.document_offset.max(0);

    db.with_read(|conn| {
        // 1) FTS 命中 -> rowid，join page_text 拿原文；按文档聚合在 Rust 侧做。
        let mut stmt = conn
            .prepare(
                "SELECT p.document_id, p.page_no, p.raw_text \
                 FROM page_fts f JOIN page_text p ON p.id = f.rowid \
                 WHERE page_fts MATCH ?1 \
                 ORDER BY bm25(page_fts) LIMIT 5000",
            )
            .map_err(|e| db_err("准备检索失败", e))?;

        let rows = stmt
            .query_map(rusqlite::params![match_expr], |row| {
                Ok(HitRow {
                    document_id: row.get(0)?,
                    page_no: row.get(1)?,
                    raw_text: row.get(2)?,
                })
            })
            .map_err(|e| db_err("执行检索失败", e))?;

        let mut grouped: BTreeMap<i64, Vec<HitRow>> = BTreeMap::new();
        for row in rows {
            let row = row.map_err(|e| db_err("读取检索结果失败", e))?;
            grouped.entry(row.document_id).or_default().push(row);
        }

        let total_documents = grouped.len() as i64;
        let doc_ids: Vec<i64> = grouped.keys().copied().skip(doc_offset as usize).take(doc_limit as usize).collect();

        let mut items = Vec::with_capacity(doc_ids.len());
        for doc_id in doc_ids {
            let Some(hit_rows) = grouped.get(&doc_id) else { continue };
            let document = load_document(conn, doc_id)?;
            let mut hits: Vec<GlobalSearchHitDto> = hit_rows
                .iter()
                .take(hits_per_doc as usize)
                .map(|row| {
                    let ranges = hit_ranges(&row.raw_text, &tokens);
                    let snippet = snippet_for(&row.raw_text, &ranges);
                    GlobalSearchHitDto { page_no: row.page_no, snippet, ranges }
                })
                .collect();
            hits.sort_by_key(|h| h.page_no);
            items.push(GlobalSearchResultDto {
                document,
                hit_count: hit_rows.len() as i64,
                hits,
            });
        }

        Ok(GlobalSearchPageDto {
            items,
            total_documents,
            offset: doc_offset,
            limit: doc_limit,
            took_ms: started.elapsed().as_millis() as i64,
        })
    })
}

pub fn search_count(db: &Db, params: &GlobalSearchParams) -> Result<SearchCountDto, ApiError> {
    let cleaned = sanitize_query(&params.query);
    let tokens = segment_query(&cleaned);
    let Some(match_expr) = build_match(&tokens, params.mode) else {
        return Ok(SearchCountDto { documents: 0, pages: 0 });
    };
    db.with_read(|conn| {
        let pages: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM page_fts WHERE page_fts MATCH ?1",
                rusqlite::params![match_expr],
                |row| row.get(0),
            )
            .map_err(|e| db_err("统计命中页失败", e))?;
        let documents: i64 = conn
            .query_row(
                "SELECT COUNT(DISTINCT p.document_id) FROM page_fts f JOIN page_text p ON p.id = f.rowid \
                 WHERE page_fts MATCH ?1",
                rusqlite::params![match_expr],
                |row| row.get(0),
            )
            .map_err(|e| db_err("统计命中文档失败", e))?;
        Ok(SearchCountDto { documents, pages })
    })
}

fn load_document(conn: &rusqlite::Connection, id: i64) -> Result<DocumentDto, ApiError> {
    conn.query_row(
        "SELECT d.id, d.library_root_id, d.file_name, d.rel_path, d.size_bytes, d.mtime_ms, d.page_count, \
                d.pdf_title, d.pdf_author, d.meta_state, d.text_state, d.last_opened_at, \
                (p.document_id IS NOT NULL), p.page_no \
         FROM documents d LEFT JOIN reading_progress p ON p.document_id = d.id WHERE d.id = ?1",
        rusqlite::params![id],
        |row| {
            Ok(DocumentDto {
                id: row.get(0)?,
                library_root_id: row.get(1)?,
                file_name: row.get(2)?,
                rel_path: row.get(3)?,
                size_bytes: row.get(4)?,
                mtime_ms: row.get(5)?,
                page_count: row.get(6)?,
                pdf_title: row.get(7)?,
                pdf_author: row.get(8)?,
                meta_state: match row.get::<_, String>(9)?.as_str() {
                    "ok" => MetaState::Ok,
                    "failed" => MetaState::Failed,
                    _ => MetaState::Pending,
                },
                text_state: match row.get::<_, String>(10)?.as_str() {
                    "indexing" => TextState::Indexing,
                    "indexed" => TextState::Indexed,
                    "no_text" => TextState::NoText,
                    "failed" => TextState::Failed,
                    _ => TextState::Pending,
                },
                last_opened_at: row.get(11)?,
                has_progress: row.get::<_, i64>(12)? != 0,
                progress_page: row.get(13)?,
            })
        },
    )
    .map_err(|e| ApiError::new(ApiErrorCode::Db, "数据库错误", false).with_detail(e.to_string()))
}
