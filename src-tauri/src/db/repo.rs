// Repository 层（docs/05 §11 的 8 个 trait，本模块先实现 M04/M12/M13 直接依赖的三个）。
// 约定：读方法收 &Connection，写方法收 &mut Connection 并由调用方控制事务边界；
// trait 实现自己不开事务（保证「删 FTS + 删 page_text + 删 documents」同事务）。
//
// 注意：M03 交付范围只到「表可写、可读、可级联」。FTS 写入统一由 M09/M10 通过
// insert_page_with_fts 完成，避免两处各写一套 rowid 绑定逻辑。

use rusqlite::{params, Connection, OptionalExtension};

use super::{db_err, now_utc};
use crate::contracts::dto::{
    DocumentDto, LibraryRootDto, MetaState, PageDto, TextState,
};
use crate::error::{ApiError, ApiErrorCode};

pub trait LibraryRootRepo {
    fn list(&self, conn: &Connection) -> Result<Vec<LibraryRootDto>, ApiError>;
    fn add(&self, conn: &Connection, path: &str, display_name: &str) -> Result<LibraryRootDto, ApiError>;
    fn remove(&self, conn: &Connection, id: i64) -> Result<(), ApiError>;
    /// 按 id 读一个库根（更改/替换之后要把最新值回给前端）。
    fn get(&self, conn: &Connection, id: i64) -> Result<LibraryRootDto, ApiError>;
    /// 更改文献库：只改显示名（docs/05 §13 R22）。
    fn rename(&self, conn: &Connection, id: i64, display_name: &str) -> Result<LibraryRootDto, ApiError>;
    /// 替换文献库：把库根指向另一个文件夹（docs/05 §13 R23）。
    /// 只改 path 与 last_scanned_at，**不动 documents**——旧文档的清理由
    /// DocumentRepo::purge_documents_of_root 在同一事务里显式完成。
    fn replace_path(&self, conn: &Connection, id: i64, path: &str) -> Result<LibraryRootDto, ApiError>;
}

/// 扫描比对所需的最小事实集（不携带正文，避免大对象进出）。
#[derive(Debug, Clone)]
pub struct DocFact {
    pub id: i64,
    pub rel_path: String,
    pub rel_path_key: String,
    pub abs_path: String,
    pub size_bytes: i64,
    pub mtime_ms: i64,
    pub deleted_at: Option<String>,
}

pub trait DocumentRepo {
    fn list_recent(&self, conn: &Connection, limit: i64) -> Result<Vec<DocumentDto>, ApiError>;
    fn list_page(&self, conn: &Connection, offset: i64, limit: i64) -> Result<PageDto<DocumentDto>, ApiError>;
    fn insert_found(&self, conn: &Connection, new: NewDocument<'_>) -> Result<i64, ApiError>;
    fn find_by_abs_path_key(&self, conn: &Connection, abs_path_key: &str) -> Result<Option<i64>, ApiError>;
    fn soft_delete(&self, conn: &Connection, id: i64) -> Result<(), ApiError>;

    // —— M04 扫描所需 ——
    /// 列表查询：支持文件名/标题模糊匹配与排序；不支持的过滤条件（rootIds/textStates）由命令层显式拒绝，
    /// 不允许「收到但忽略」。
    fn list_filtered(
        &self,
        conn: &Connection,
        text: Option<&str>,
        sort: &str,
        order: &str,
        offset: i64,
        limit: i64,
    ) -> Result<PageDto<DocumentDto>, ApiError>;

    fn facts_by_root(&self, conn: &Connection, root_id: i64) -> Result<Vec<DocFact>, ApiError>;
    fn update_facts(&self, conn: &Connection, id: i64, size_bytes: i64, mtime_ms: i64) -> Result<(), ApiError>;
    fn revive(&self, conn: &Connection, id: i64) -> Result<(), ApiError>;
    fn touch_opened(&self, conn: &Connection, id: i64) -> Result<(), ApiError>;
    fn get_detail(&self, conn: &Connection, id: i64) -> Result<crate::contracts::dto::DocumentDetailDto, ApiError>;
    fn abs_path_of(&self, conn: &Connection, id: i64) -> Result<(String, Option<i64>, String, i64), ApiError>;
    fn delete_record(&self, conn: &Connection, id: i64) -> Result<(), ApiError>;
    /// 删除某库根下的全部文档记录，返回删除条数（替换文献库时用，R23）。
    ///
    /// 必须逐条走 delete_record：page_fts 是 contentless 表、没有外键，
    /// 只靠 documents 的 ON DELETE CASCADE 会留下永远检索不到也删不掉的幽灵 FTS 行。
    fn purge_documents_of_root(&self, conn: &Connection, root_id: i64) -> Result<usize, ApiError>;
    /// 某库根下的文档 id 列表（软删除的也算：它们占着 rel_path_key 的唯一约束）。
    fn ids_of_root(&self, conn: &Connection, root_id: i64) -> Result<Vec<i64>, ApiError>;
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
        LibraryRootRepo::list(self, conn)?
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

    fn get(&self, conn: &Connection, id: i64) -> Result<LibraryRootDto, ApiError> {
        LibraryRootRepo::list(self, conn)?
            .into_iter()
            .find(|r| r.id == id)
            .ok_or_else(|| ApiError::new(ApiErrorCode::NotFound, "找不到该文献库", false))
    }

    fn rename(&self, conn: &Connection, id: i64, display_name: &str) -> Result<LibraryRootDto, ApiError> {
        let name = display_name.trim();
        if name.is_empty() {
            return Err(ApiError::new(ApiErrorCode::InvalidArg, "参数不合法", false)
                .with_detail("文献库名称不能为空"));
        }
        let affected = conn
            .execute(
                "UPDATE library_roots SET display_name = ?1 WHERE id = ?2",
                params![name, id],
            )
            .map_err(|e| db_err("更新 library_root 名称失败", e))?;
        if affected == 0 {
            return Err(ApiError::new(ApiErrorCode::NotFound, "找不到该文献库", false));
        }
        LibraryRootRepo::get(self, conn, id)
    }

    fn replace_path(&self, conn: &Connection, id: i64, path: &str) -> Result<LibraryRootDto, ApiError> {
        // 先确认要替换的库根存在，避免后续 UPDATE 只是「影响 0 行」。
        let _ = LibraryRootRepo::get(self, conn, id)?;
        // path 上有 UNIQUE 约束：前置检查能给出可读的错误，而不是把 E_DB 抛给前端。
        let conflict: Option<i64> = conn
            .query_row(
                "SELECT id FROM library_roots WHERE path = ?1 AND id <> ?2",
                params![path, id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| db_err("检查库根路径冲突失败", e))?;
        if conflict.is_some() {
            return Err(ApiError::new(ApiErrorCode::InvalidArg, "参数不合法", false)
                .with_detail(format!("该文件夹已经是另一个文献库：{path}")));
        }
        conn.execute(
            "UPDATE library_roots SET path = ?1, last_scanned_at = NULL WHERE id = ?2",
            params![path, id],
        )
        .map_err(|e| db_err("替换 library_root 路径失败", e))?;
        LibraryRootRepo::get(self, conn, id)
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
    fn list_filtered(
        &self,
        conn: &Connection,
        text: Option<&str>,
        sort: &str,
        order: &str,
        offset: i64,
        limit: i64,
    ) -> Result<PageDto<DocumentDto>, ApiError> {
        let order_sql = match sort {
            "name" => "d.file_name COLLATE NOCASE",
            "size" => "d.size_bytes",
            "added" => "d.created_at",
            _ => "COALESCE(d.last_opened_at, d.created_at)",
        };
        let dir = if order.eq_ignore_ascii_case("asc") { "ASC" } else { "DESC" };
        // LIKE 的通配符必须**转义**而不是删掉：删掉会让「文件名里带 _ 或 %」的文献
        // 用自己的名字搜不到（本库大部分文件名是 _ 分隔的，等于过滤框对它们完全失效）。
        // 转义后配合 ESCAPE '\'，用户输入的 % 和 _ 就是普通字符。
        let pattern = text.map(|t| {
            let escaped = t
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            format!("%{escaped}%")
        });

        let count_sql = "SELECT COUNT(*) FROM documents d WHERE d.deleted_at IS NULL \
                         AND (?1 IS NULL OR d.file_name LIKE ?1 ESCAPE '\\' OR COALESCE(d.pdf_title,'') LIKE ?1 ESCAPE '\\')";
        let total: i64 = conn
            .query_row(count_sql, params![pattern], |row| row.get(0))
            .map_err(|e| db_err("统计 documents 失败", e))?;

        let sql = format!(
            "SELECT d.id, d.library_root_id, d.file_name, d.rel_path, d.size_bytes, d.mtime_ms, \
                    d.page_count, d.pdf_title, d.pdf_author, d.meta_state, d.text_state, \
                    d.last_opened_at, (p.document_id IS NOT NULL), p.page_no \
             FROM documents d LEFT JOIN reading_progress p ON p.document_id = d.id \
             WHERE d.deleted_at IS NULL \
               AND (?1 IS NULL OR d.file_name LIKE ?1 ESCAPE '\\' OR COALESCE(d.pdf_title,'') LIKE ?1 ESCAPE '\\') \
             ORDER BY {order_sql} {dir}, d.id {dir} LIMIT ?2 OFFSET ?3"
        );

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| db_err("准备列表查询失败", e))?;
        let rows = stmt
            .query_map(params![pattern, limit, offset], |row| {
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
            .map_err(|e| db_err("执行列表查询失败", e))?;
        let items = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| db_err("读取列表失败", e))?;

        Ok(PageDto { items, total, offset, limit })
    }

    fn facts_by_root(&self, conn: &Connection, root_id: i64) -> Result<Vec<DocFact>, ApiError> {
        let mut stmt = conn
            .prepare(
                "SELECT id, rel_path, rel_path_key, abs_path, size_bytes, mtime_ms, deleted_at \
                 FROM documents WHERE library_root_id = ?1",
            )
            .map_err(|e| db_err("准备 facts 查询失败", e))?;
        let rows = stmt
            .query_map(params![root_id], |row| {
                Ok(DocFact {
                    id: row.get(0)?,
                    rel_path: row.get(1)?,
                    rel_path_key: row.get(2)?,
                    abs_path: row.get(3)?,
                    size_bytes: row.get(4)?,
                    mtime_ms: row.get(5)?,
                    deleted_at: row.get(6)?,
                })
            })
            .map_err(|e| db_err("执行 facts 查询失败", e))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| db_err("读取 facts 失败", e))
    }

    fn update_facts(&self, conn: &Connection, id: i64, size_bytes: i64, mtime_ms: i64) -> Result<(), ApiError> {
        // 文件内容变了：清掉旧索引并把状态打回 pending，交由 M10 重新入队。
        conn.execute(
            "UPDATE documents SET size_bytes = ?1, mtime_ms = ?2, text_state = 'pending', \
                    meta_state = 'pending', index_error_code = NULL, index_error_msg = NULL, \
                    updated_at = ?3 WHERE id = ?4",
            params![size_bytes, mtime_ms, super::now_utc(), id],
        )
        .map_err(|e| db_err("更新文档事实失败", e))?;
        delete_document_index(conn, id)?;
        Ok(())
    }

    fn revive(&self, conn: &Connection, id: i64) -> Result<(), ApiError> {
        conn.execute(
            "UPDATE documents SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
            params![super::now_utc(), id],
        )
        .map_err(|e| db_err("复活文档失败", e))?;
        Ok(())
    }

    fn touch_opened(&self, conn: &Connection, id: i64) -> Result<(), ApiError> {
        let affected = conn
            .execute(
                "UPDATE documents SET last_opened_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
                params![super::now_utc(), id],
            )
            .map_err(|e| db_err("更新最近打开时间失败", e))?;
        if affected == 0 {
            return Err(ApiError::new(ApiErrorCode::NotFound, "找不到该文献", false));
        }
        Ok(())
    }

    fn get_detail(&self, conn: &Connection, id: i64) -> Result<crate::contracts::dto::DocumentDetailDto, ApiError> {
        use crate::contracts::dto::{BookmarkDto, DocumentDetailDto, ProgressDto, ReadMode};

        let mut stmt = conn
            .prepare(
                "SELECT d.id, d.library_root_id, d.file_name, d.rel_path, d.size_bytes, d.mtime_ms, \
                        d.page_count, d.pdf_title, d.pdf_author, d.meta_state, d.text_state, \
                        d.last_opened_at, d.abs_path, d.pdf_subject, d.pdf_keywords, d.pdf_producer, \
                        d.pdf_creator, d.pdf_creation_date, d.index_error_code, d.index_error_msg, \
                        p.document_id, p.page_no, p.scroll_ratio, p.zoom, p.mode, p.updated_at \
                 FROM documents d LEFT JOIN reading_progress p ON p.document_id = d.id \
                 WHERE d.id = ?1",
            )
            .map_err(|e| db_err("准备文档详情查询失败", e))?;

        let mut detail = stmt
            .query_row(params![id], |row| {
                let progress: Option<ProgressDto> = match row.get::<_, Option<i64>>(20)? {
                    Some(_) => Some(ProgressDto {
                        document_id: id,
                        page_no: row.get(21)?,
                        scroll_ratio: row.get(22)?,
                        zoom: row.get(23)?,
                        mode: match row.get::<_, String>(24)?.as_str() {
                            "single" => ReadMode::Single,
                            _ => ReadMode::Continuous,
                        },
                        updated_at: row.get(25)?,
                    }),
                    None => None,
                };
                Ok(DocumentDetailDto {
                    id,
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
                    has_progress: progress.is_some(),
                    progress_page: progress.as_ref().map(|p| p.page_no),
                    abs_path: row.get(12)?,
                    pdf_subject: row.get(13)?,
                    pdf_keywords: row.get(14)?,
                    pdf_producer: row.get(15)?,
                    pdf_creator: row.get(16)?,
                    pdf_creation_date: row.get(17)?,
                    index_error_code: row.get(18)?,
                    index_error_msg: row.get(19)?,
                    bookmarks: Vec::<BookmarkDto>::new(),
                    progress,
                })
            })
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    ApiError::new(ApiErrorCode::NotFound, "找不到该文献", false)
                }
                other => db_err("读取文档详情失败", other),
            })?;

        // 书签单独查，避免主查询过于复杂。
        let mut bs = conn
            .prepare(
                "SELECT id, document_id, page_no, title, note, color, created_at, updated_at \
                 FROM bookmarks WHERE document_id = ?1 ORDER BY page_no ASC, created_at ASC",
            )
            .map_err(|e| db_err("准备书签查询失败", e))?;
        let bookmarks = bs
            .query_map(params![id], |row| {
                Ok(BookmarkDto {
                    id: row.get(0)?,
                    document_id: row.get(1)?,
                    page_no: row.get(2)?,
                    title: row.get(3)?,
                    note: row.get(4)?,
                    color: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })
            .map_err(|e| db_err("执行书签查询失败", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| db_err("读书签失败", e))?;
        detail.bookmarks = bookmarks;
        Ok(detail)
    }

    fn abs_path_of(&self, conn: &Connection, id: i64) -> Result<(String, Option<i64>, String, i64), ApiError> {
        conn.query_row(
            "SELECT abs_path, page_count, file_name, mtime_ms FROM documents WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => ApiError::new(ApiErrorCode::NotFound, "找不到该文献", false),
            other => db_err("读取文档路径失败", other),
        })
    }

    fn delete_record(&self, conn: &Connection, id: i64) -> Result<(), ApiError> {
        // 先清 FTS（无外键），再删文档行（级联清 page_text/bookmarks/progress/jobs）。
        delete_document_index(conn, id)?;
        let affected = conn
            .execute("DELETE FROM documents WHERE id = ?1", params![id])
            .map_err(|e| db_err("删除文档记录失败", e))?;
        if affected == 0 {
            return Err(ApiError::new(ApiErrorCode::NotFound, "找不到该文献", false));
        }
        Ok(())
    }

    fn ids_of_root(&self, conn: &Connection, root_id: i64) -> Result<Vec<i64>, ApiError> {
        let mut stmt = conn
            .prepare("SELECT id FROM documents WHERE library_root_id = ?1 ORDER BY id")
            .map_err(|e| db_err("准备库根文档查询失败", e))?;
        let rows = stmt
            .query_map(params![root_id], |row| row.get::<_, i64>(0))
            .map_err(|e| db_err("执行库根文档查询失败", e))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| db_err("读取库根文档失败", e))
    }

    fn purge_documents_of_root(&self, conn: &Connection, root_id: i64) -> Result<usize, ApiError> {
        let ids = DocumentRepo::ids_of_root(self, conn, root_id)?;
        for id in &ids {
            DocumentRepo::delete_record(self, conn, *id)?;
        }
        Ok(ids.len())
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

pub trait BookmarkRepo {
    fn list(&self, conn: &Connection, document_id: i64) -> Result<Vec<crate::contracts::dto::BookmarkDto>, ApiError>;
    fn create(&self, conn: &Connection, document_id: i64, page_no: i64, title: &str, note: Option<&str>, color: Option<&str>) -> Result<crate::contracts::dto::BookmarkDto, ApiError>;
    fn update(&self, conn: &Connection, id: i64, title: Option<&str>, note: Option<&str>, color: Option<&str>) -> Result<crate::contracts::dto::BookmarkDto, ApiError>;
    fn delete(&self, conn: &Connection, id: i64) -> Result<(), ApiError>;
}

pub trait ProgressRepo {
    fn get(&self, conn: &Connection, document_id: i64) -> Result<Option<crate::contracts::dto::ProgressDto>, ApiError>;
    fn upsert(&self, conn: &Connection, p: &crate::contracts::dto::ProgressDto) -> Result<(), ApiError>;
}

impl BookmarkRepo for SqlRepos {
    fn list(&self, conn: &Connection, document_id: i64) -> Result<Vec<crate::contracts::dto::BookmarkDto>, ApiError> {
        use crate::contracts::dto::BookmarkDto;
        let mut stmt = conn
            .prepare(
                "SELECT id, document_id, page_no, title, note, color, created_at, updated_at \
                 FROM bookmarks WHERE document_id = ?1 ORDER BY page_no ASC, created_at ASC",
            )
            .map_err(|e| db_err("准备书签列表失败", e))?;
        let rows = stmt
            .query_map(params![document_id], |row| {
                Ok(BookmarkDto {
                    id: row.get(0)?,
                    document_id: row.get(1)?,
                    page_no: row.get(2)?,
                    title: row.get(3)?,
                    note: row.get(4)?,
                    color: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })
            .map_err(|e| db_err("执行书签列表失败", e))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| db_err("读书签失败", e))
    }

    fn create(&self, conn: &Connection, document_id: i64, page_no: i64, title: &str, note: Option<&str>, color: Option<&str>) -> Result<crate::contracts::dto::BookmarkDto, ApiError> {
        if page_no < 1 {
            return Err(ApiError::new(ApiErrorCode::InvalidArg, "参数不合法", false)
                .with_detail("pageNo 必须 >= 1"));
        }
        let now = now_utc();
        conn.execute(
            "INSERT INTO bookmarks (document_id, page_no, title, note, color, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![document_id, page_no, title, note, color, now],
        )
        .map_err(|e| db_err("插入书签失败", e))?;
        let id = conn.last_insert_rowid();
        BookmarkRepo::list(self, conn, document_id)?
            .into_iter()
            .find(|b| b.id == id)
            .ok_or_else(|| ApiError::new(ApiErrorCode::Internal, "插入后读不到书签", true))
    }

    fn update(&self, conn: &Connection, id: i64, title: Option<&str>, note: Option<&str>, color: Option<&str>) -> Result<crate::contracts::dto::BookmarkDto, ApiError> {
        // 语义：未提供 = 不改，提供则整体覆盖（note/color 传空串视为清空）。
        let affected = conn
            .execute(
                "UPDATE bookmarks SET title = COALESCE(?1, title), note = COALESCE(?2, note), \
                        color = COALESCE(?3, color), updated_at = ?4 WHERE id = ?5",
                params![title, note, color, now_utc(), id],
            )
            .map_err(|e| db_err("更新书签失败", e))?;
        if affected == 0 {
            return Err(ApiError::new(ApiErrorCode::NotFound, "找不到该书签", false));
        }
        let document_id: i64 = conn
            .query_row("SELECT document_id FROM bookmarks WHERE id = ?1", params![id], |r| r.get(0))
            .map_err(|e| db_err("读取书签所属文档失败", e))?;
        BookmarkRepo::list(self, conn, document_id)?
            .into_iter()
            .find(|b| b.id == id)
            .ok_or_else(|| ApiError::new(ApiErrorCode::Internal, "更新后读不到书签", true))
    }

    fn delete(&self, conn: &Connection, id: i64) -> Result<(), ApiError> {
        let affected = conn
            .execute("DELETE FROM bookmarks WHERE id = ?1", params![id])
            .map_err(|e| db_err("删除书签失败", e))?;
        if affected == 0 {
            return Err(ApiError::new(ApiErrorCode::NotFound, "找不到该书签", false));
        }
        Ok(())
    }
}

impl ProgressRepo for SqlRepos {
    fn get(&self, conn: &Connection, document_id: i64) -> Result<Option<crate::contracts::dto::ProgressDto>, ApiError> {
        use crate::contracts::dto::{ProgressDto, ReadMode};
        let mut stmt = conn
            .prepare(
                "SELECT document_id, page_no, scroll_ratio, zoom, mode, updated_at \
                 FROM reading_progress WHERE document_id = ?1",
            )
            .map_err(|e| db_err("准备进度查询失败", e))?;
        let mut rows = stmt
            .query_map(params![document_id], |row| {
                Ok(ProgressDto {
                    document_id: row.get(0)?,
                    page_no: row.get(1)?,
                    scroll_ratio: row.get(2)?,
                    zoom: row.get(3)?,
                    mode: match row.get::<_, String>(4)?.as_str() {
                        "single" => ReadMode::Single,
                        _ => ReadMode::Continuous,
                    },
                    updated_at: row.get(5)?,
                })
            })
            .map_err(|e| db_err("执行进度查询失败", e))?;
        match rows.next() {
            Some(Ok(p)) => Ok(Some(p)),
            Some(Err(e)) => Err(db_err("读取进度失败", e)),
            None => Ok(None),
        }
    }

    fn upsert(&self, conn: &Connection, p: &crate::contracts::dto::ProgressDto) -> Result<(), ApiError> {
        if p.page_no < 1 {
            return Err(ApiError::new(ApiErrorCode::InvalidArg, "参数不合法", false)
                .with_detail("pageNo 必须 >= 1"));
        }
        let ratio = p.scroll_ratio.clamp(0.0, 1.0);
        conn.execute(
            "INSERT INTO reading_progress (document_id, page_no, scroll_ratio, zoom, mode, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT(document_id) DO UPDATE SET page_no = excluded.page_no, \
                 scroll_ratio = excluded.scroll_ratio, zoom = excluded.zoom, \
                 mode = excluded.mode, updated_at = excluded.updated_at",
            params![p.document_id, p.page_no, ratio, p.zoom, match p.mode { crate::contracts::dto::ReadMode::Single => "single", _ => "continuous" }, p.updated_at],
        )
        .map_err(|e| db_err("写入进度失败", e))?;
        conn.execute(
            "UPDATE documents SET last_opened_at = ?1 WHERE id = ?2",
            params![p.updated_at, p.document_id],
        )
        .map_err(|e| db_err("更新最近打开时间失败", e))?;
        Ok(())
    }
}