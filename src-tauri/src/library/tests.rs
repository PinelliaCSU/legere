// M04 测试：diff 四分支 + 端到端扫描（新增/变更/删除/复活）。

use std::path::Path;

use super::scan::{diff, scan_root_with_now, FoundFile};
use crate::db::repo::{path_key, DocumentRepo, LibraryRootRepo, SqlRepos};
use crate::db::Db;

fn f(rel: &str, size: i64, mtime: i64) -> FoundFile {
    FoundFile { rel_path: rel.to_string(), abs_path: format!("C:/lib/{rel}"), size_bytes: size, mtime_ms: mtime }
}

fn fact(id: i64, rel: &str, size: i64, mtime: i64, deleted: bool) -> crate::db::repo::DocFact {
    crate::db::repo::DocFact {
        id,
        rel_path: rel.to_string(),
        rel_path_key: path_key(rel),
        abs_path: format!("C:/lib/{rel}"),
        size_bytes: size,
        mtime_ms: mtime,
        deleted_at: if deleted { Some("2026-01-01T00:00:00Z".into()) } else { None },
    }
}

#[test]
fn diff_detects_insert() {
    let d = diff(&[], &[f("a.pdf", 10, 1), f("sub/b.pdf", 20, 2)]);
    assert_eq!(d.insert.len(), 2);
    assert!(d.update.is_empty() && d.remove.is_empty() && d.revive.is_empty());
}

#[test]
fn diff_ignores_unchanged() {
    let d = diff(&[fact(1, "a.pdf", 10, 1, false)], &[f("a.pdf", 10, 1)]);
    assert!(d.insert.is_empty() && d.update.is_empty() && d.remove.is_empty());
}

#[test]
fn diff_detects_size_or_mtime_change() {
    let d = diff(&[fact(1, "a.pdf", 10, 1, false)], &[f("a.pdf", 11, 1), f("b.pdf", 5, 2)]);
    assert_eq!(d.update.len(), 1);
    assert_eq!(d.update[0].0, 1);
    assert_eq!(d.insert.len(), 1);
}

#[test]
fn diff_revives_soft_deleted_and_removes_missing() {
    let existing = vec![fact(1, "gone.pdf", 10, 1, false), fact(2, "back.pdf", 10, 1, true)];
    let d = diff(&existing, &[f("back.pdf", 10, 1)]);
    assert_eq!(d.revive.len(), 1);
    assert_eq!(d.revive[0].0, 2);
    assert_eq!(d.remove, vec![1]);
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("legere-scan-{tag}-{stamp}"));
    std::fs::create_dir_all(&dir).expect("创建测试目录");
    dir
}

fn write_pdf(dir: &Path, name: &str, body: &[u8]) {
    let path = dir.join(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("创建子目录");
    }
    std::fs::write(path, body).expect("写测试文件");
}

// 用「未来时间」绕过 2s 半写保护：mtime 距今足够远。
fn far_future() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
        + 60_000
}

#[test]
fn scan_end_to_end_add_update_remove_revive() {
    let lib = temp_dir("lib");
    let db_path = temp_dir("db").join("legere.db");
    let db = Db::open(&db_path).expect("打开测试库");
    let repos = SqlRepos;

    let root_id = db
        .with_write(|conn| {
            let root = repos.add(conn, &lib.to_string_lossy().replace('\\', "/"), "lib")?;
            Ok(root.id)
        })
        .expect("建库根");

    write_pdf(&lib, "a.pdf", b"%PDF-1.4 a");
    write_pdf(&lib, "sub/b.pdf", b"%PDF-1.4 b longer");
    write_pdf(&lib, "notes.txt", b"ignored");

    let first = scan_root_with_now(&db, root_id, &lib, far_future()).expect("首次扫描");
    assert_eq!(first.scanned, 2, "只应收集 .pdf");
    assert_eq!(first.added, 2);

    write_pdf(&lib, "a.pdf", b"%PDF-1.4 a grows to a longer body");
    let second = scan_root_with_now(&db, root_id, &lib, far_future()).expect("二次扫描");
    assert_eq!(second.updated, 1, "内容变化应进入 update");
    assert_eq!(second.added, 0);

    std::fs::remove_file(lib.join("sub/b.pdf")).expect("删文件");
    let third = scan_root_with_now(&db, root_id, &lib, far_future()).expect("三次扫描");
    assert_eq!(third.removed, 1);
    let visible = db.with_write(|conn| repos.list_recent(conn, 10)).expect("列表");
    assert_eq!(visible.len(), 1, "软删除的文档不应出现在列表里");

    write_pdf(&lib, "sub/b.pdf", b"%PDF-1.4 b longer");
    let fourth = scan_root_with_now(&db, root_id, &lib, far_future()).expect("四次扫描");
    assert_eq!(fourth.revived, 1);
    assert_eq!(db.with_write(|conn| repos.list_recent(conn, 10)).expect("列表").len(), 2);
}

#[test]
fn document_url_shape_is_platform_correct() {
    let url = crate::commands::library::document_url_for(7, 1234);
    if cfg!(windows) {
        assert_eq!(url, "http://pdf.localhost/doc/7?v=1234");
    } else {
        assert_eq!(url, "pdf://localhost/doc/7?v=1234");
    }
}
