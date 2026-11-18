pub mod misc;
pub mod index;
pub mod library;

// Command 层只做参数校验 + DTO 转换，不写 SQL、不解析 PDF（docs/03 §M01）。
//
// 数据库可能不可用（目录不可写、迁移失败等）：此时返回 E_DB + detail，
// 让前端把原因显示出来 —— 绝不 panic、绝不静默。

use tauri::State;

use crate::contracts::dto::{AppInfoDto, IntegrityReportDto, PingDto};
use crate::error::{ApiError, ApiErrorCode};
use crate::state::AppState;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[tauri::command]
pub async fn ping() -> Result<PingDto, ApiError> {
    Ok(PingDto { ok: true, version: VERSION.to_string() })
}

/// textEngine 仍为 "none"：文本提取由 M09 提供，届时替换。
#[tauri::command]
pub async fn app_info(state: State<'_, AppState>) -> Result<AppInfoDto, ApiError> {
    let data_dir = state.data_dir.clone();
    let db_path = data_dir.join("legere.db");

    let (fts_enabled, contentless_delete) = state.with_db(|db| {
        let caps = db.capabilities();
        Ok((caps.fts5, caps.contentless_delete))
    })?;

    Ok(AppInfoDto {
        version: VERSION.to_string(),
        data_dir: data_dir.to_string_lossy().to_string(),
        db_path: db_path.to_string_lossy().to_string(),
        fts_enabled,
        contentless_delete,
        text_engine: "none".to_string(),
    })
}

#[tauri::command]
pub async fn db_integrity_check(state: State<'_, AppState>) -> Result<IntegrityReportDto, ApiError> {
    state.with_db(|db| crate::db::integrity::check(db))
}

/// 未实现命令的统一形状：宁可显式 Unsupported，也不要返回假数据。
#[allow(dead_code)]
pub fn not_implemented(module: &str) -> ApiError {
    ApiError::new(ApiErrorCode::Unsupported, "当前环境不支持该功能", false)
        .with_detail(format!("{module} 尚未接入（等待对应模块交付）"))
}
