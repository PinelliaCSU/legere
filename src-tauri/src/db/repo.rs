// Repository 层（docs/05 §11 的 8 个 trait，本模块先实现 M04/M12/M13 直接依赖的三个）。
// 约定：读方法收 &Connection，写方法收 &mut Connection 并由调用方控制事务边界；
// trait 实现自己不开事务（保证「删 FTS + 删 page_text + 删 documents」同事务）。
//
// 注意：M03 交付范围只到「表可写、可读、可级联」。FTS 写入统一由 M09/M10 通过
// insert_page_with_fts 完成，避免两处各写一套 rowid 绑定逻辑。

use rusqlite::{params, Connection};

use super::{db_err, now_utc};
use crate::contracts::dto::{
    DocumentDto, LibraryRootDto, MetaState, PageDto, TextState,
};
use crate::error::{ApiError, ApiErrorCode};

pub trait LibraryRootRepo {
    fn list(&self, conn: &Connection) -> Result<Vec<LibraryRootDto>, ApiError>;
    fn add(&self, conn: &Connection, path: &str, display_name: &str) -> Result<LibraryRootDto, ApiError>;
    fn remove(&self, conn: &Connection, id: i64) -> Result<(), ApiError>;
}

pub trait DocumentRepo {
    fn list_recent(&self, conn: &Connection, limit: i64) -> Result<Vec<DocumentDto>, ApiError>;
    fn list_page(&self, conn: &Connection, offset: i64, limit: i64) -> Result<PageDto<DocumentDto>, ApiError>;
    fn insert_found(&self, conn: &Connection, new: NewDocument<'_>) -> Result<i64, ApiError>;
    fn find_by_abs_path_key(&self, conn: &Connection, abs_path_key: &str) -> Result<Option<i64>, ApiError>;
    fn soft_delete(&self, conn: &Connection, id: i64) -> Result<(), ApiError>;
}

pub trait SettingsRepo {
    fn get_all(&self, conn: &Connection) -> Result<std::collections::BTreeMap<String, String>, ApiError>;
    fn set(&self, conn: &Connection, key: &str, value: &str) -> Result<(), ApiError>;
}

pub struct NewDocument<'a> {
    pub library_root_id: i64,
    pub rel_path: &'a str,
    pub abs_path: &'a str,
    pub file_name: &'a str,
    pub size_bytes: i64,
    pub mtime_ms: i64,
}

pub struct SqlRepos;

// 路径唯一性只认 *_key 列（契约 R17）：Windows 大小写不敏感，直接比对原路径会重复入库。
pub fn path_key(raw: &str) -> String {
    raw.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

impl LibraryRootRepo for SqlRepos {
    fn list(&self, conn: &Connection) -> Result<Vec<LibraryRootDto>, ApiError> {
        let mut stmt = conn
            .prepare(
                "SELECT id, path, display_name, enabled, created_at, last_scanned_at \
                 FROM library_roots ORDER BY id",
            )
            .map_err(|e| db_err("准备 library_roots 查询失败", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(LibraryRootDto {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    display_name: row.get(2)?,
                    enabled: row.get::<_, i64>(3)? != 0,
                    created_at: row.get(4)?,
                    last_scanned_at: row.get(5)?,
                })
            })
            .map_err(|e| db_err("执行 library_roots 查询失败", e))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| db_err("读取 library_roots 失败", e))
    }

    fn add(&self, conn: &Connection, path: &str, display_name: &str) -> Result<LibraryRootDto, ApiError> {
        conn.execute(
            "INSERT INTO library_roots (path, display_name, enabled, created_at) VALUES (?1, ?2, 1, ?3)",
            params![path, display_name, now_utc()],
        )
        .map_err(|e| db_err("插入 library_root 失败", e))?;
        let id = conn.last_insert_rowid();
        self.list(conn)?
            .into_iter()
            .find(|r| r.id == id)
            .ok_or_else(|| ApiError::new(ApiErrorCode::Internal, "插入后读不到 library_root", true))
    }

    fn remove(&self, conn: &Connection, id: i64) -> Result<(), ApiError> {
        let affected = conn
            .execute("DELETE FROM library_roots WHERE id = ?1", params![id])
            .map_err(|e| db_err("删除 library_root 失败", e))?;
        if affected == 0 {
            return Err(ApiError::new(ApiErrorCode::NotFound, "找不到该文献库", false));
        }
        Ok(())
    }
}

impl DocumentRepo for SqlRepos {
    fn list_recent(&self, conn: &Connection, limit: i64) -> Result<Vec<DocumentDto>, ApiError> {
        let page = self.list_page(conn, 0, limit)?;
        Ok(page.items)
    }

    fn list_page(&self, conn: &Connection, offset: i64, limit: i64) -> Result<PageDto<DocumentDto>, ApiError> {
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .map_err(|e| db_err("统计 documents 失败", e))?;

        let mut stmt = conn
            .prepare(
                "SELECT d.id, d.library_root_id, d.file_name, d.rel_path, d.size_bytes, d.mtime_ms, \
                        d.page_count, d.pdf_title, d.pdf_author, d.meta_state, d.text_state, \
                        d.last_opened_at, \
                        (p.document_id IS NOT NULL) AS has_progress, p.page_no \
                 FROM documents d LEFT JOIN reading_progress p ON p.document_id = d.id \
                 WHERE d.deleted_at IS NULL \
                 ORDER BY COALESCE(d.last_opened_at, d.created_at) DESC, d.id DESC \
                 LIMIT ?1 OFFSET ?2",
            )
            .map_err(|e| db_err("准备 documents 查询失败", e))?;
        let rows = stmt
            .query_map(params![limit, offset], |row| {
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
                    meta_state: parse_meta_state(row.get::<_, String>(9)?),
                    text_state: parse_text_state(row.get::<_, String>(10)?),
                    last_opened_at: row.get(11)?,
                    has_progress: row.get::<_, i64>(12)? != 0,
                    progress_page: row.get(13)?,
                })
            })
            .map_err(|e| db_err("执行 documents 查询失败", e))?;
        let items = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| db_err("读取 documents 失败", e))?;

        Ok(PageDto { items, total, offset, limit })
    }

    fn insert_found(&self, conn: &Connection, new: NewDocument<'_>) -> Result<i64, ApiError> {
        let now = now_utc();
        conn.execute(
            "INSERT INTO documents (library_root_id, rel_path, rel_path_key, abs_path, abs_path_key, \
                                   file_name, size_bytes, mtime_ms, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![
                new.library_root_id,
                new.rel_path,
                path_key(new.rel_path),
                new.abs_path,
                path_key(new.abs_path),
                new.file_name,
                new.size_bytes,
                new.mtime_ms,
                now
            ],
        )
        .map_err(|e| db_err("插入 document 失败", e))?;
        Ok(conn.last_insert_rowid())
    }

    fn find_by_abs_path_key(&self, conn: &Connection, abs_path_key: &str) -> Result<Option<i64>, ApiError> {
        let mut stmt = conn
            .prepare("SELECT id FROM documents WHERE abs_path_key = ?1 AND deleted_at IS NULL")
            .map_err(|e| db_err("准备路径查询失败", e))?;
        let mut rows = stmt
            .query_map(params![abs_path_key], |row| row.get::<_, i64>(0))
            .map_err(|e| db_err("执行路径查询失败", e))?;
        match rows.next() {
            Some(Ok(id)) => Ok(Some(id)),
            Some(Err(e)) => Err(db_err("读取路径查询结果失败", e)),
            None => Ok(None),
        }
    }

    fn soft_delete(&self, conn: &Connection, id: i64) -> Result<(), ApiError> {
        let now = now_utc();
        let affected = conn
            .execute(
                "UPDATE documents SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
                params![now, id],
            )
            .map_err(|e| db_err("软删除 document 失败", e))?;
        if affected == 0 {
            return Err(ApiError::new(ApiErrorCode::NotFound, "找不到该文献", false));
        }
        Ok(())
    }
}

impl SettingsRepo for SqlRepos {
    fn get_all(&self, conn: &Connection) -> Result<std::collections::BTreeMap<String, String>, ApiError> {
        let mut stmt = conn
            .prepare("SELECT key, value FROM app_settings")
            .map_err(|e| db_err("准备 settings 查询失败", e))?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| db_err("执行 settings 查询失败", e))?;
        let mut out = std::collections::BTreeMap::new();
        for item in rows {
            let (k, v) = item.map_err(|e| db_err("读取 settings 失败", e))?;
            out.insert(k, v);
        }
        Ok(out)
    }

    fn set(&self, conn: &Connection, key: &str, value: &str) -> Result<(), ApiError> {
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now_utc()],
        )
        .map_err(|e| db_err("写入 setting 失败", e))?;
        Ok(())
    }
}

/// 一页写入：page_text 与 page_fts 必须同事务、同 rowid（docs/04 §4）。
/// 返回 page_text.id（同时是 page_fts.rowid）。
pub fn insert_page_with_fts(
    conn: &Connection,
    document_id: i64,
    page_no: i64,
    raw_text: &str,
    seg_text: &str,
) -> Result<i64, ApiError> {
    conn.execute(
        "INSERT INTO page_text (document_id, page_no, raw_text, char_count) VALUES (?1, ?2, ?3, ?4)",
        params![document_id, page_no, raw_text, raw_text.chars().count() as i64],
    )
    .map_err(|e| db_err("插入 page_text 失败", e))?;
    let id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO page_fts (rowid, seg_text) VALUES (?1, ?2)",
        params![id, seg_text],
    )
    .map_err(|e| db_err("插入 page_fts 失败", e))?;
    Ok(id)
}

/// 删除某文档全部索引：先 FTS 后 page_text（rowid 复用会把新行串到旧文档上，docs/04 §4）。
pub fn delete_document_index(conn: &Connection, document_id: i64) -> Result<usize, ApiError> {
    let ids: Vec<i64> = {
        let mut stmt = conn
            .prepare("SELECT id FROM page_text WHERE document_id = ?1")
            .map_err(|e| db_err("准备索引清理查询失败", e))?;
        let rows = stmt
            .query_map(params![document_id], |row| row.get::<_, i64>(0))
            .map_err(|e| db_err("执行索引清理查询失败", e))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| db_err("读取索引清理结果失败", e))?
    };

    for id in &ids {
        conn.execute("DELETE FROM page_fts WHERE rowid = ?1", params![id])
            .map_err(|e| db_err("删除 page_fts 失败", e))?;
    }
    conn.execute("DELETE FROM page_text WHERE document_id = ?1", params![document_id])
        .map_err(|e| db_err("删除 page_text 失败", e))?;
    Ok(ids.len())
}

fn parse_meta_state(raw: String) -> MetaState {
    match raw.as_str() {
        "ok" => MetaState::Ok,
        "failed" => MetaState::Failed,
        _ => MetaState::Pending,
    }
}

fn parse_text_state(raw: String) -> TextState {
    match raw.as_str() {
        "indexing" => TextState::Indexing,
        "indexed" => TextState::Indexed,
        "no_text" => TextState::NoText,
        "failed" => TextState::Failed,
        _ => TextState::Pending,
    }
}
