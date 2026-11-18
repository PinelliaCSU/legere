// M12/M13 命令：书签、阅读进度、设置。
// 文件名不能用 aux.rs：AUX 是 Windows 保留设备名，git/文件系统都会失败。

use tauri::State;

use crate::contracts::dto::{BookmarkDto, ProgressDto, SettingsMapDto};
use crate::db::repo::{BookmarkRepo, ProgressRepo, SettingsRepo, SqlRepos};
use crate::error::{ApiError, ApiErrorCode};
use crate::state::AppState;

#[tauri::command]
pub async fn bookmark_list(
    state: State<'_, AppState>,
    document_id: i64,
) -> Result<Vec<BookmarkDto>, ApiError> {
    let repos = SqlRepos;
    // 契约 R19：未知文档返回空数组，不报错。
    state.with_db(|db| db.with_read(|conn| BookmarkRepo::list(&repos, conn, document_id)))
}

#[tauri::command]
pub async fn bookmark_create(
    state: State<'_, AppState>,
    document_id: i64,
    page_no: i64,
    title: String,
    note: Option<String>,
    color: Option<String>,
) -> Result<BookmarkDto, ApiError> {
    let repos = SqlRepos;
    state.with_db(|db| {
        db.with_write(|conn| {
            repos.create(conn, document_id, page_no, &title, note.as_deref(), color.as_deref())
        })
    })
}

#[tauri::command]
pub async fn bookmark_update(
    state: State<'_, AppState>,
    id: i64,
    title: Option<String>,
    note: Option<String>,
    color: Option<String>,
) -> Result<BookmarkDto, ApiError> {
    let repos = SqlRepos;
    state.with_db(|db| {
        db.with_write(|conn| repos.update(conn, id, title.as_deref(), note.as_deref(), color.as_deref()))
    })
}

#[tauri::command]
pub async fn bookmark_delete(state: State<'_, AppState>, id: i64) -> Result<(), ApiError> {
    let repos = SqlRepos;
    state.with_db(|db| db.with_write(|conn| repos.delete(conn, id)))
}

#[tauri::command]
pub async fn progress_get(
    state: State<'_, AppState>,
    document_id: i64,
) -> Result<Option<ProgressDto>, ApiError> {
    let repos = SqlRepos;
    state.with_db(|db| db.with_read(|conn| repos.get(conn, document_id)))
}

#[tauri::command]
pub async fn progress_save(
    state: State<'_, AppState>,
    progress: ProgressDto,
) -> Result<(), ApiError> {
    let repos = SqlRepos;
    // 契约 R19：未知文档返回 E_NOT_FOUND（而不是让它变成外键错误 E_DB）。
    state.with_db(|db| {
        db.with_write(|conn| {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM documents WHERE id = ?1 AND deleted_at IS NULL",
                    rusqlite::params![progress.document_id],
                    |row| row.get(0),
                )
                .map_err(|e| crate::db::db_err("校验文档存在性失败", e))?;
            if exists == 0 {
                return Err(ApiError::new(ApiErrorCode::NotFound, "找不到该文献", false));
            }
            repos.upsert(conn, &progress)
        })
    })
}

#[tauri::command]
pub async fn settings_get_all(state: State<'_, AppState>) -> Result<SettingsMapDto, ApiError> {
    let repos = SqlRepos;
    state.with_db(|db| db.with_read(|conn| repos.get_all(conn)))
}

#[tauri::command]
pub async fn settings_set(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), ApiError> {
    if key.trim().is_empty() || key.len() > 128 {
        return Err(ApiError::new(ApiErrorCode::InvalidArg, "参数不合法", false)
            .with_detail("settings key 长度必须在 1..=128"));
    }
    let repos = SqlRepos;
    state.with_db(|db| db.with_write(|conn| repos.set(conn, &key, &value)))
}
