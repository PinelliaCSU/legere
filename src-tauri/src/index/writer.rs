// 把一本文档写进索引：提取 -> 分词 -> page_text + page_fts（同事务同 rowid）-> 回写元数据。

use std::path::Path;

use crate::db::repo::{delete_document_index, insert_page_with_fts, SqlRepos};
use crate::db::{db_err, now_utc, Db};
use crate::error::{ApiError, ApiErrorCode};

use super::extract::{looks_like_text, LopdfExtractor, TextExtractor};
use super::segment::build_seg_text;

/// 每批页数：批内一个事务，崩溃最多丢一批（docs/02 §6）。
const BATCH_PAGES: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IndexOutcome {
    /// 成功建索引，记录页数。
    Indexed { pages: i64 },
    /// 可以打开但没有可提取文本（扫描件/CID 未解码）——终态，不重试。
    NoText { pages: i64 },
}

pub fn index_document(db: &Db, document_id: i64, path: &Path) -> Result<IndexOutcome, ApiError> {
    let extractor = LopdfExtractor;
    let (meta, pages) = extractor.extract(path)?;

    // 先清旧索引：重跑必须幂等（同一页不得产生两行）。
    db.with_write(|conn| {
        delete_document_index(conn, document_id)?;
        Ok(())
    })?;

    let pages_with_text: Vec<(&i64, &str)> = pages
        .iter()
        .filter(|p| looks_like_text(&p.text))
        .map(|p| (&p.page_no, p.text.as_str()))
        .collect();

    if pages_with_text.is_empty() {
        db.with_write(|conn| {
            conn.execute(
                "UPDATE documents SET page_count = ?1, meta_state = 'ok', text_state = 'no_text', \
                        index_error_code = NULL, index_error_msg = NULL, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![meta.page_count, now_utc(), document_id],
            )
            .map_err(|e| db_err("回写 no_text 状态失败", e))?;
            Ok(())
        })?;
        tracing::info!(document_id, pages = meta.page_count, "无可提取文本，标记 no_text");
        return Ok(IndexOutcome::NoText { pages: meta.page_count });
    }

    let mut written = 0_i64;
    for chunk in pages_with_text.chunks(BATCH_PAGES) {
        db.with_write(|conn| {
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| db_err("开启索引事务失败", e))?;
            for (page_no, text) in chunk {
                let seg = build_seg_text(text);
                insert_page_with_fts(&tx, document_id, **page_no, text, &seg)?;
            }
            tx.commit().map_err(|e| db_err("提交索引事务失败", e))?;
            Ok(())
        })?;
        written += chunk.len() as i64;
    }

    db.with_write(|conn| {
        conn.execute(
            "UPDATE documents SET page_count = ?1, pdf_title = COALESCE(?2, pdf_title), \
                    pdf_author = COALESCE(?3, pdf_author), pdf_subject = COALESCE(?4, pdf_subject), \
                    pdf_keywords = COALESCE(?5, pdf_keywords), pdf_producer = COALESCE(?6, pdf_producer), \
                    pdf_creator = COALESCE(?7, pdf_creator), pdf_creation_date = COALESCE(?8, pdf_creation_date), \
                    meta_state = 'ok', text_state = 'indexed', index_error_code = NULL, \
                    index_error_msg = NULL, updated_at = ?9 WHERE id = ?10",
            rusqlite::params![
                meta.page_count,
                meta.title,
                meta.author,
                meta.subject,
                meta.keywords,
                meta.producer,
                meta.creator,
                meta.creation_date,
                now_utc(),
                document_id
            ],
        )
        .map_err(|e| db_err("回写索引完成状态失败", e))?;
        Ok(())
    })?;

    tracing::info!(document_id, pages = written, total = meta.page_count, "索引完成");
    Ok(IndexOutcome::Indexed { pages: written })
}

/// 失败终态回写：M10 在重试耗尽后调用。
pub fn mark_failed(db: &Db, document_id: i64, code: &str, message: &str) -> Result<(), ApiError> {
    db.with_write(|conn| {
        conn.execute(
            "UPDATE documents SET text_state = 'failed', index_error_code = ?1, index_error_msg = ?2, \
                    updated_at = ?3 WHERE id = ?4",
            rusqlite::params![code, message, now_utc(), document_id],
        )
        .map_err(|e| db_err("回写失败状态失败", e))?;
        Ok(())
    })
    .map(|_| ())
    .map_err(|e: ApiError| ApiError::new(ApiErrorCode::Db, "数据库错误", false).with_detail(format!("{e:?}")))
    .or_else(|_| Ok(()))
}

/// 供 M10 使用：按 document_id 找到绝对路径。
pub fn abs_path_of(db: &Db, document_id: i64) -> Result<String, ApiError> {
    let repos = SqlRepos;
    db.with_read(|conn| {
        use crate::db::repo::DocumentRepo;
        let (path, _pc, _name, _mt) = repos.abs_path_of(conn, document_id)?;
        Ok(path)
    })
}
