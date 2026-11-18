// FTS5 能力探针（V-03 / 决策 D10）：决定 page_fts 走 contentless 分支还是降级为普通表。
// 探针在临时库里建同名结构的虚表，失败即降级；结果缓存进 DbCapabilities。

use rusqlite::Connection;

use super::DbCapabilities;

pub fn detect(conn: &Connection) -> DbCapabilities {
    let fts5 = conn
        .execute_batch("CREATE VIRTUAL TABLE temp.legere_fts_probe USING fts5(a)")
        .is_ok();
    if fts5 {
        let _ = conn.execute_batch("DROP TABLE temp.legere_fts_probe");
    }

    let contentless_delete = fts5
        && conn
            .execute_batch(
                "CREATE VIRTUAL TABLE temp.legere_fts_probe2 USING fts5(a, content='', contentless_delete=1)",
            )
            .is_ok();
    if contentless_delete {
        let _ = conn.execute_batch("DROP TABLE temp.legere_fts_probe2");
    }

    DbCapabilities { fts5, contentless_delete }
}
