// M10/M11 命令：索引任务控制与全局检索。

use tauri::{AppHandle, State};

use crate::contracts::dto::{
    GlobalSearchPageDto, GlobalSearchParams, IndexStatusDto, SearchCountDto,
};
use crate::error::{ApiError, ApiErrorCode};
// 命令函数名必须与契约一致（search_global / search_global_count），因此服务层函数起别名。
use crate::search::{search_count, search_global as run_search_global};
use crate::state::AppState;

const MAX_HITS_PER_DOC: i64 = 5;
const MAX_DOC_LIMIT: i64 = 50;

#[tauri::command]
pub async fn index_enqueue(
    state: State<'_, AppState>,
    document_id: i64,
    priority: Option<i32>,
) -> Result<serde_json::Value, ApiError> {
    // 文档必须存在，否则入队只会制造幽灵任务。
    state.with_db(|db| {
        let repos = crate::db::repo::SqlRepos;
        use crate::db::repo::DocumentRepo;
        db.with_read(|conn| repos.abs_path_of(conn, document_id))?;
        Ok(())
    })?;
    let job_id = state.index.enqueue(document_id, priority.unwrap_or(10));
    Ok(serde_json::json!({ "jobId": job_id }))
}

#[tauri::command]
pub async fn index_cancel(state: State<'_, AppState>, job_id: i64) -> Result<(), ApiError> {
    if state.index.cancel(job_id) {
        Ok(())
    } else {
        Err(ApiError::new(ApiErrorCode::NotFound, "找不到该任务", false))
    }
}

#[tauri::command]
pub async fn index_status(state: State<'_, AppState>) -> Result<IndexStatusDto, ApiError> {
    Ok(state.index.status())
}

#[tauri::command]
pub async fn index_pause(state: State<'_, AppState>, paused: bool) -> Result<(), ApiError> {
    state.index.set_paused(paused);
    Ok(())
}

/// 重建：清空索引表，把所有未删除文档打回 pending 并入队（docs/04 §6）。
#[tauri::command]
pub async fn index_rebuild_all(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, ApiError> {
    let ids: Vec<i64> = state.with_db(|db| {
        db.with_write(|conn| {
            conn.execute("DELETE FROM page_fts", [])
                .map_err(|e| crate::db::db_err("清空 page_fts 失败", e))?;
            conn.execute("DELETE FROM page_text", [])
                .map_err(|e| crate::db::db_err("清空 page_text 失败", e))?;
            conn.execute(
                "UPDATE documents SET text_state = 'pending', meta_state = 'pending' WHERE deleted_at IS NULL",
                [],
            )
            .map_err(|e| crate::db::db_err("重置索引状态失败", e))?;
            let mut stmt = conn
                .prepare("SELECT id FROM documents WHERE deleted_at IS NULL ORDER BY id")
                .map_err(|e| crate::db::db_err("准备重建列表失败", e))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, i64>(0))
                .map_err(|e| crate::db::db_err("查询重建列表失败", e))?;
            Ok(rows.filter_map(Result::ok).collect::<Vec<i64>>())
        })
    })?;

    let count = ids.len();
    for id in ids {
        state.index.enqueue(id, 10);
    }
    let _ = app;
    Ok(serde_json::json!({ "started": count > 0, "enqueued": count }))
}

fn validate_params(params: &GlobalSearchParams) -> Result<(), ApiError> {
    let q = params.query.trim();
    if q.is_empty() {
        return Ok(());
    }
    if q.chars().count() < 2 {
        // 单字查询在 token 级精确匹配下没有召回保证（裁决 T19），明确告知而不是默默返回 0。
        return Err(ApiError::new(ApiErrorCode::InvalidArg, "请输入至少 2 个字", false)
            .with_detail("单字查询无召回保证（token 级精确匹配）"));
    }
    if params.hits_per_document > MAX_HITS_PER_DOC || params.hits_per_document < 1 {
        return Err(ApiError::new(ApiErrorCode::InvalidArg, "参数不合法", false)
            .with_detail("hitsPerDocument 必须在 1..=5"));
    }
    if params.document_limit > MAX_DOC_LIMIT || params.document_limit < 1 {
        return Err(ApiError::new(ApiErrorCode::InvalidArg, "参数不合法", false)
            .with_detail("documentLimit 必须在 1..=50"));
    }
    Ok(())
}

#[tauri::command]
pub async fn search_global(
    state: State<'_, AppState>,
    params: GlobalSearchParams,
) -> Result<GlobalSearchPageDto, ApiError> {
    validate_params(&params)?;
    state.with_db(|db| run_search_global(db, &params))
}

#[tauri::command]
pub async fn search_global_count(
    state: State<'_, AppState>,
    params: GlobalSearchParams,
) -> Result<SearchCountDto, ApiError> {
    validate_params(&params)?;
    state.with_db(|db| search_count(db, &params))
}