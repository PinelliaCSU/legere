// 递归扫描 + 增量 diff（纯函数部分可单测，落库部分走 Repository）。

use std::path::{Path, PathBuf};

use crate::db::repo::{path_key, DocFact, DocumentRepo, NewDocument, SqlRepos};
use crate::db::{db_err, now_utc, Db};
use crate::error::{ApiError, ApiErrorCode};

/// 半写保护：mtime 距今 < 2s 的文件跳过本轮，避免读到下载中的半个文件。
const SETTLE_MS: i64 = 2_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundFile {
    pub rel_path: String,
    pub abs_path: String,
    pub size_bytes: i64,
    pub mtime_ms: i64,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ScanOutcome {
    pub scanned: usize,
    pub added: usize,
    pub updated: usize,
    pub revived: usize,
    pub removed: usize,
}

/// 递归收集 *.pdf（大小写不敏感），跳过隐藏目录与系统目录。
pub fn collect_pdfs(root: &Path, now_ms: i64) -> Vec<FoundFile> {
    let mut out = Vec::new();
    walk(root, root, now_ms, &mut out);
    out
}

fn walk(root: &Path, dir: &Path, now_ms: i64, out: &mut Vec<FoundFile>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            walk(root, &path, now_ms, out);
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        let lower = name.to_lowercase();
        if !lower.ends_with(".pdf") {
            continue;
        }
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if now_ms.saturating_sub(mtime_ms) < SETTLE_MS {
            // 正在写入：本轮跳过，下一轮会补上（不提示，属实现细节）。
            continue;
        }
        let Ok(rel) = path.strip_prefix(root) else { continue };
        out.push(FoundFile {
            rel_path: rel.to_string_lossy().replace('\\', "/"),
            abs_path: path.to_string_lossy().replace('\\', "/"),
            size_bytes: meta.len() as i64,
            mtime_ms,
        });
    }
}

/// 纯 diff：算出新增/变更/复活/移除。不触库，便于单测。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ScanDiff {
    pub insert: Vec<FoundFile>,
    pub update: Vec<(i64, FoundFile)>,
    pub revive: Vec<(i64, FoundFile)>,
    pub remove: Vec<i64>,
}

pub fn diff(existing: &[DocFact], found: &[FoundFile]) -> ScanDiff {
    let mut d = ScanDiff::default();
    let mut by_key: std::collections::HashMap<&str, &DocFact> = std::collections::HashMap::new();
    for fact in existing {
        by_key.insert(fact.rel_path_key.as_str(), fact);
    }

    for file in found {
        let key = path_key(&file.rel_path);
        match by_key.get(key.as_str()) {
            None => d.insert.push(file.clone()),
            Some(fact) => {
                let changed = fact.size_bytes != file.size_bytes || fact.mtime_ms != file.mtime_ms;
                if fact.deleted_at.is_some() {
                    d.revive.push((fact.id, file.clone()));
                } else if changed {
                    d.update.push((fact.id, file.clone()));
                }
            }
        }
    }

    let found_keys: std::collections::HashSet<String> =
        found.iter().map(|f| path_key(&f.rel_path)).collect();
    for fact in existing {
        // 文件已消失且之前未软删 -> 软删除；C3 分支只清理，不排任务（契约 R12）。
        if fact.deleted_at.is_none() && !found_keys.contains(&fact.rel_path_key) {
            d.remove.push(fact.id);
        }
    }
    d
}

pub fn scan_root(db: &Db, root_id: i64, root_path: &Path) -> Result<ScanOutcome, ApiError> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    scan_root_with_now(db, root_id, root_path, now_ms)
}

pub fn scan_root_with_now(
    db: &Db,
    root_id: i64,
    root_path: &Path,
    now_ms: i64,
) -> Result<ScanOutcome, ApiError> {
    let found = collect_pdfs(root_path, now_ms);
    let repos = SqlRepos;

    let mut outcome = ScanOutcome { scanned: found.len(), ..Default::default() };

    let existing = db.with_write(|conn| repos.facts_by_root(conn, root_id))?;
    let d = diff(&existing, &found);

    db.with_write(|conn| {
        let tx_save = conn.savepoint().map_err(|e| db_err("创建扫描保存点失败", e))?;

        for file in &d.insert {
            let file_name = PathBuf::from(&file.rel_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| file.rel_path.clone());
            repos.insert_found(
                &tx_save,
                NewDocument {
                    library_root_id: root_id,
                    rel_path: &file.rel_path,
                    abs_path: &file.abs_path,
                    file_name: &file_name,
                    size_bytes: file.size_bytes,
                    mtime_ms: file.mtime_ms,
                },
            )?;
        }
        for (id, file) in &d.update {
            repos.update_facts(&tx_save, *id, file.size_bytes, file.mtime_ms)?;
        }
        for (id, file) in &d.revive {
            repos.revive(&tx_save, *id)?;
            repos.update_facts(&tx_save, *id, file.size_bytes, file.mtime_ms)?;
        }
        for id in &d.remove {
            repos.soft_delete(&tx_save, *id)?;
        }

        tx_save.commit().map_err(|e| db_err("提交扫描保存点失败", e))?;
        Ok(())
    })?;

    outcome.added = d.insert.len();
    outcome.updated = d.update.len();
    outcome.revived = d.revive.len();
    outcome.removed = d.remove.len();

    tracing::info!(
        root_id,
        scanned = outcome.scanned,
        added = outcome.added,
        updated = outcome.updated,
        revived = outcome.revived,
        removed = outcome.removed,
        at = %now_utc(),
        "扫描完成"
    );

    if outcome.scanned == 0 && outcome.removed == 0 && outcome.added == 0 {
        // 空目录不是错误，但值得留痕（常见于根目录选错）。
        tracing::warn!(root = %root_path.display(), "扫描未发现任何 PDF");
    }

    Ok(outcome)
}

/// 供命令层复用的根路径校验。
pub fn ensure_root_dir(path: &str) -> Result<PathBuf, ApiError> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err(ApiError::new(ApiErrorCode::NotFound, "找不到该目录", false)
            .with_detail(path.to_string()));
    }
    if !p.is_dir() {
        return Err(ApiError::new(ApiErrorCode::InvalidArg, "参数不合法", false)
            .with_detail(format!("{path} 不是目录")));
    }
    // 只读探测：能列目录才认为有权限（Windows 上目录属性 ≠ 访问权）。
    if std::fs::read_dir(&p).is_err() {
        return Err(ApiError::new(ApiErrorCode::Permission, "没有访问权限", false)
            .with_detail(path.to_string()));
    }
    Ok(p)
}