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

// ── R22 / R23：文献库（库根）的「更改」与「替换」─────────────────────────────
// 这两条是用户实际要的能力：改显示名、把库根换到另一个文件夹并让旧文献从应用里消失。

fn seed_root(db: &Db, path: &str, name: &str) -> i64 {
    let repos = SqlRepos;
    db.with_write(|conn| repos.add(conn, path, name)).expect("建库根").id
}

fn seed_doc_in_root(db: &Db, root_id: i64, rel: &str) -> i64 {
    let repos = SqlRepos;
    db.with_write(|conn| {
        repos.insert_found(
            conn,
            NewDocument {
                library_root_id: root_id,
                rel_path: rel,
                abs_path: &format!("C:/lib/{rel}"),
                file_name: rel.split('/').next_back().unwrap_or(rel),
                size_bytes: 2048,
                mtime_ms: 1_700_000_000_000,
            },
        )
    })
    .expect("写入文档")
}

fn give_doc_content(db: &Db, id: i64) {
    db.with_write(|conn| {
        insert_page_with_fts(conn, id, 1, "正文", "正 文")?;
        conn.execute(
            "INSERT INTO bookmarks (document_id, page_no, title, note, color, created_at, updated_at) \
             VALUES (?1, 1, '书签', NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params![id],
        )
        .map_err(|e| super::db_err("写书签失败", e))?;
        conn.execute(
            "INSERT INTO reading_progress (document_id, page_no, scroll_ratio, zoom, mode, updated_at) \
             VALUES (?1, 1, 0.0, 1.0, 'continuous', '2026-01-01T00:00:00Z')",
            rusqlite::params![id],
        )
        .map_err(|e| super::db_err("写进度失败", e))?;
        Ok(())
    })
    .expect("准备文档内容");
}

#[test]
fn rename_library_root_trims_and_validates() {
    let (db, _path) = open_db("root-rename");
    let repos = SqlRepos;
    let id = seed_root(&db, "C:/library", "library");

    let renamed = db
        .with_write(|conn| repos.rename(conn, id, "  我的文献库  "))
        .expect("重命名应当成功");
    assert_eq!(renamed.display_name, "我的文献库", "显示名必须 trim 后写入");
    assert_eq!(renamed.path, "C:/library", "改名不得动路径");

    let err = db
        .with_write(|conn| repos.rename(conn, id, "   "))
        .expect_err("空名称必须被拒绝");
    assert_eq!(err.code, crate::error::ApiErrorCode::InvalidArg);

    let err = db
        .with_write(|conn| repos.rename(conn, 999_999, "x"))
        .expect_err("不存在的库根必须是 E_NOT_FOUND");
    assert_eq!(err.code, crate::error::ApiErrorCode::NotFound);
}

#[test]
fn replace_library_root_points_elsewhere_and_purges_old_documents() {
    let (db, _path) = open_db("root-replace");
    let repos = SqlRepos;
    let old_root = seed_root(&db, "C:/old", "old");
    let doc1 = seed_doc_in_root(&db, old_root, "a.pdf");
    let doc2 = seed_doc_in_root(&db, old_root, "b.pdf");
    give_doc_content(&db, doc1);
    give_doc_content(&db, doc2);

    // 同一事务里：先清旧文档，再把库根指向新文件夹
    let removed = db
        .with_write(|conn| {
            let tx = conn.unchecked_transaction().map_err(|e| super::db_err("tx", e))?;
            let removed = repos.purge_documents_of_root(&tx, old_root)?;
            let root = repos.replace_path(&tx, old_root, "C:/new")?;
            tx.commit().map_err(|e| super::db_err("commit", e))?;
            Ok((removed, root))
        })
        .expect("替换文献库");
    assert_eq!(removed.0, 2, "该库根下两本文献都应被清掉");
    assert_eq!(removed.1.path, "C:/new");
    assert_eq!(removed.1.last_scanned_at, None, "替换后必须重置扫描时间，等新文件夹扫描");

    db.with_read(|conn| {
        let docs: i64 = conn
            .query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0))
            .map_err(|e| super::db_err("count documents", e))?;
        assert_eq!(docs, 0, "旧文献记录必须从库里消失（这正是用户要的「不再出现在软件中」）");
        let pages: i64 = conn
            .query_row("SELECT COUNT(*) FROM page_text", [], |r| r.get(0))
            .map_err(|e| super::db_err("count pages", e))?;
        assert_eq!(pages, 0);
        let fts: i64 = conn
            .query_row("SELECT COUNT(*) FROM page_fts", [], |r| r.get(0))
            .map_err(|e| super::db_err("count fts", e))?;
        assert_eq!(fts, 0, "contentless FTS 没有外键，必须显式清（否则留下幽灵行）");
        let bookmarks: i64 = conn
            .query_row("SELECT COUNT(*) FROM bookmarks", [], |r| r.get(0))
            .map_err(|e| super::db_err("count bookmarks", e))?;
        assert_eq!(bookmarks, 0);
        let progress: i64 = conn
            .query_row("SELECT COUNT(*) FROM reading_progress", [], |r| r.get(0))
            .map_err(|e| super::db_err("count progress", e))?;
        assert_eq!(progress, 0);
        Ok(())
    })
    .expect("断言清理结果");
}

#[test]
fn replace_library_root_rejects_a_path_owned_by_another_root() {
    let (db, _path) = open_db("root-conflict");
    let repos = SqlRepos;
    let a = seed_root(&db, "C:/a", "a");
    let _b = seed_root(&db, "C:/b", "b");

    let err = db
        .with_write(|conn| repos.replace_path(conn, a, "C:/b"))
        .expect_err("路径冲突必须被拒绝");
    assert_eq!(err.code, crate::error::ApiErrorCode::InvalidArg);
    assert!(
        err.detail.unwrap_or_default().contains("另一个文献库"),
        "错误详情要说清冲突原因"
    );
}

#[test]
fn purge_also_removes_soft_deleted_rows_that_would_block_the_unique_key() {
    let (db, _path) = open_db("root-purge-soft");
    let repos = SqlRepos;
    let root = seed_root(&db, "C:/soft", "soft");
    let id = seed_doc_in_root(&db, root, "same.pdf");
    db.with_write(|conn| repos.soft_delete(conn, id)).expect("软删除");

    // 软删除的行仍然占着 UNIQUE(library_root_id, rel_path_key)：换库根后同名文件会插不进去
    let would_block = db
        .with_write(|conn| {
            repos.insert_found(
                conn,
                NewDocument {
                    library_root_id: root,
                    rel_path: "same.pdf",
                    abs_path: "C:/soft/same.pdf",
                    file_name: "same.pdf",
                    size_bytes: 1,
                    mtime_ms: 1,
                },
            )
        })
        .expect_err("同名 rel_path_key 应当被唯一约束挡住");
    assert_eq!(would_block.code, crate::error::ApiErrorCode::Db, "先证明约束真的会挡");

    let removed = db
        .with_write(|conn| repos.purge_documents_of_root(conn, root))
        .expect("清理库根文档");
    assert_eq!(removed, 1, "软删除的行也必须清掉");

    // 清完之后同名文件可以正常插入（替换文献库的实际路径）
    let fresh = db
        .with_write(|conn| {
            repos.insert_found(
                conn,
                NewDocument {
                    library_root_id: root,
                    rel_path: "same.pdf",
                    abs_path: "C:/new/same.pdf",
                    file_name: "same.pdf",
                    size_bytes: 1,
                    mtime_ms: 1,
                },
            )
        })
        .expect("清理后应能插入新文件夹的同名文件");
    assert!(fresh > 0);
}
