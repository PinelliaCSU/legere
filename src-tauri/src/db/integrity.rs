// 一致性自检（docs/04 §6）：只报告，不自动修改。

use rusqlite::Connection;

use super::{db_err, Db};
use crate::contracts::dto::IntegrityReportDto;
use crate::error::ApiError;

pub fn check(db: &Db) -> Result<IntegrityReportDto, ApiError> {
    db.with_read(|conn| {
        let page_text_rows: i64 = scalar(conn, "SELECT COUNT(*) FROM page_text")?;
        let fts_rows: i64 = scalar(conn, "SELECT COUNT(*) FROM page_fts")?;

        // 孤儿：page_text 指向不存在的 document（外键应拦住，仍需对历史数据兜底检查）
        let orphan_pages: i64 = scalar(
            conn,
            "SELECT COUNT(*) FROM page_text p LEFT JOIN documents d ON d.id = p.document_id WHERE d.id IS NULL",
        )?;

        // 标记为 indexed 却一页文本都没有的文档
        let mut stmt = conn
            .prepare(
                "SELECT d.id FROM documents d \
                 WHERE d.text_state = 'indexed' AND d.deleted_at IS NULL \
                 AND NOT EXISTS (SELECT 1 FROM page_text p WHERE p.document_id = d.id) \
                 ORDER BY d.id",
            )
            .map_err(|e| db_err("准备一致性查询失败", e))?;
        let mislabeled = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(|e| db_err("执行一致性查询失败", e))?
            .collect::<Result<Vec<i64>, _>>()
            .map_err(|e| db_err("读取一致性结果失败", e))?;

        Ok(IntegrityReportDto { fts_rows, page_text_rows, orphan_pages, mislabeled_documents: mislabeled })
    })
}

fn scalar(conn: &Connection, sql: &str) -> Result<i64, ApiError> {
    conn.query_row(sql, [], |row| row.get(0))
        .map_err(|e| db_err("一致性计数失败", e))
}
