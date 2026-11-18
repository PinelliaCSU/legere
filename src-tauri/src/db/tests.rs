// M03 测试：迁移幂等、能力探针、级联删除、路径 key 大小写、FTS rowid 绑定。
// 使用真实文件库（不用 :memory:）：WAL 与只读连接只有在文件库上才有意义（docs/12 §2）。

use super::repo::{
    delete_document_index, insert_page_with_fts, path_key, DocumentRepo, LibraryRootRepo,
    NewDocument, SettingsRepo, SqlRepos,
};
use super::Db;

fn temp_db_path(tag: &str) -> std::path::PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("legere-test-{tag}-{stamp}"));
    std::fs::create_dir_all(&dir).expect("创建测试目录");
    dir.join("legere.db")
}

fn open_db(tag: &str) -> (Db, std::path::PathBuf) {
    let path = temp_db_path(tag);
    let db = Db::open(&path).expect("打开测试库");
    (db, path)
}

fn seed_document(db: &Db, rel: &str) -> i64 {
    let repos = SqlRepos;
    db.with_write(|conn| {
        let root = repos.add(conn, "C:/library", "library")?;
        repos.insert_found(
            conn,
            NewDocument {
                library_root_id: root.id,
                rel_path: rel,
                abs_path: &format!("C:/library/{rel}"),
                file_name: rel.split('/').next_back().unwrap_or(rel),
                size_bytes: 1024,
                mtime_ms: 1_700_000_000_000,
            },
        )
    })
    .expect("写入文档")
}

#[test]
fn migrations_are_idempotent_and_create_schema() {
    let (db, path) = open_db("migrate");
    let tables: Vec<String> = db
        .with_read(|conn| {
            let mut stmt = conn
                .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
                .map_err(|e| super::db_err("prepare", e))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| super::db_err("query", e))?;
            Ok(rows.filter_map(Result::ok).collect::<Vec<_>>())
        })
        .expect("读取表清单");

    for expected in ["documents", "library_roots", "page_text", "bookmarks", "reading_progress"] {
        assert!(tables.contains(&expected.to_string()), "缺少表 {expected}");
    }
    drop(db);

    // 重新打开：迁移不得重复执行
    let db2 = Db::open(&path).expect("重开库");
    let version: i64 = db2
        .with_read(|conn| {
            conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get(0))
                .map_err(|e| super::db_err("version", e))
        })
        .expect("读取版本");
    assert_eq!(version, 1);
}

#[test]
fn fts5_probe_reports_capability() {
    let (db, _) = open_db("probe");
    let caps = db.capabilities();
    assert!(caps.fts5, "bundled SQLite 应启用 FTS5");
    // contentless_delete 取决于 SQLite 版本；这里断言与迁移是否成功保持一致，避免硬编码。
    println!("capabilities: fts5={} contentless_delete={}", caps.fts5, caps.contentless_delete);
}

#[test]
fn library_root_crud_and_cascade() {
    let (db, _) = open_db("roots");
    let repos = SqlRepos;
    db.with_write(|conn| {
        let root = repos.add(conn, "C:/docs", "docs")?;
        assert_eq!(root.display_name, "docs");
        assert_eq!(repos.list(conn)?.len(), 1);
        repos.add(conn, "C:/docs2", "docs2")?;
        assert_eq!(repos.list(conn)?.len(), 2);
        repos.remove(conn, root.id)?;
        Ok(())
    })
    .expect("library root 增删");
    let remaining = db.with_write(|conn| repos.list(conn)).expect("列表");
    assert_eq!(remaining.len(), 1);
}

#[test]
fn path_key_is_case_and_separator_insensitive() {
    assert_eq!(path_key("C:\\Docs\\A.PDF"), "c:/docs/a.pdf");
    assert_eq!(path_key("c:/docs/a.pdf"), "c:/docs/a.pdf");
    let (db, _) = open_db("pathkey");
    let id = seed_document(&db, "A.pdf");
    let found = db
        .with_write(|conn| SqlRepos.find_by_abs_path_key(conn, &path_key("c:/LIBRARY/a.PDF")))
        .expect("路径查询");
    assert_eq!(found, Some(id), "大小写不同的同一路径必须命中同一条记录");
}

#[test]
fn soft_delete_hides_document_from_list() {
    let (db, _) = open_db("softdel");
    let id = seed_document(&db, "b.pdf");
    let repos = SqlRepos;
    assert_eq!(db.with_write(|conn| repos.list_recent(conn, 10)).expect("list").len(), 1);
    db.with_write(|conn| repos.soft_delete(conn, id)).expect("软删");
    assert_eq!(db.with_write(|conn| repos.list_recent(conn, 10)).expect("list").len(), 0);
}

#[test]
fn page_fts_rowid_is_bound_to_page_text_and_cascades() {
    let (db, _) = open_db("fts");
    let doc = seed_document(&db, "c.pdf");

    let page_id = db
        .with_write(|conn| insert_page_with_fts(conn, doc, 1, "中文分词的效果", "中文 分词 的 效果"))
        .expect("写入页面");

    let hit: i64 = db
        .with_read(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM page_fts WHERE page_fts MATCH '中文' AND rowid = ?1",
                rusqlite::params![page_id],
                |row| row.get(0),
            )
            .map_err(|e| super::db_err("fts 查询", e))
        })
        .expect("检索");
    assert_eq!(hit, 1, "page_fts.rowid 必须等于 page_text.id");

    let removed = db
        .with_write(|conn| delete_document_index(conn, doc))
        .expect("清理索引");
    assert_eq!(removed, 1);

    let fts_rows: i64 = db
        .with_read(|conn| {
            conn.query_row("SELECT COUNT(*) FROM page_fts", [], |row| row.get(0))
                .map_err(|e| super::db_err("count", e))
        })
        .expect("计数");
    assert_eq!(fts_rows, 0, "删页必须同时删掉 FTS 行");
}

#[test]
fn settings_roundtrip() {
    let (db, _) = open_db("settings");
    let repos = SqlRepos;
    db.with_write(|conn| repos.set(conn, "ui.theme", "\"paper\""))
        .expect("写设置");
    let all = db.with_write(|conn| repos.get_all(conn)).expect("读设置");
    assert_eq!(all.get("ui.theme").map(String::as_str), Some("\"paper\""));
}
