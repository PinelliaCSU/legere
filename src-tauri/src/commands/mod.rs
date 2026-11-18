// Command 层只做参数校验 + DTO 转换，不写 SQL、不解析 PDF（docs/03 §M01）。
// M03/M04/M09 落地后，本模块的占位实现必须替换为真实调用；占位值一律显式标注，不许伪装。

use tauri::{Manager, State};

use crate::contracts::dto::{AppInfoDto, IntegrityReportDto, PingDto};
use crate::db::Db;
use crate::error::{ApiError, ApiErrorCode, DomainError};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[tauri::command]
pub async fn ping() -> Result<PingDto, ApiError> {
    Ok(PingDto { ok: true, version: VERSION.to_string() })
}

/// 占位实现：数据库与文本引擎由 M03/M09 提供。
/// 在它们就绪前返回 false/"none"，而不是编造 true —— 免得前端按"能力已就绪"分支。
/// M03 起能力字段来自真实能力探针（不再是占位）。
/// textEngine 仍为 "none"：文本提取由 M09 提供，届时替换。
#[tauri::command]
pub async fn app_info(app: tauri::AppHandle, db: State<'_, Db>) -> Result<AppInfoDto, ApiError> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| DomainError::Io(std::io::Error::other(e.to_string())))?;
    let capabilities = db.capabilities();

    Ok(AppInfoDto {
        version: VERSION.to_string(),
        data_dir: data_dir.to_string_lossy().to_string(),
        db_path: db.path().to_string_lossy().to_string(),
        fts_enabled: capabilities.fts5,
        contentless_delete: capabilities.contentless_delete,
        text_engine: "none".to_string(),
    })
}

#[tauri::command]
pub async fn db_integrity_check(db: State<'_, Db>) -> Result<IntegrityReportDto, ApiError> {
    crate::db::integrity::check(&db)
}

/// 未实现命令的统一形状：宁可显式 Unsupported，也不要返回假数据。
#[allow(dead_code)]
pub fn not_implemented(module: &str) -> ApiError {
    ApiError::new(ApiErrorCode::Unsupported, "当前环境不支持该功能", false)
        .with_detail(format!("{module} 尚未接入（等待对应模块交付）"))
}
