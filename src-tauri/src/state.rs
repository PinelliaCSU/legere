// 应用共享状态。
//
// 为什么不是直接 manage(Db)：数据库可能因为目录不可写/FTS 缺失而初始化失败。
// 那种情况下应用仍必须起得来、窗口必须可见、错误必须能被前端读到（E_DB + detail），
// 而不是 panic 后一片空白（2026-11-18 事故）。

use std::path::PathBuf;
use std::sync::Mutex;

use crate::db::Db;

pub struct AppState {
    pub data_dir: PathBuf,
    pub db: Mutex<Option<Db>>,
    pub db_error: Mutex<Option<String>>,
    /// 文件监控句柄：必须被持有，否则 watch 会随 watcher drop 立刻停止。
    pub watchers: Mutex<Vec<notify::RecommendedWatcher>>,
    /// 索引任务调度器（M10）。
    pub index: std::sync::Arc<crate::jobs::IndexService>,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            db: Mutex::new(None),
            db_error: Mutex::new(None),
            watchers: Mutex::new(Vec::new()),
            index: std::sync::Arc::new(crate::jobs::IndexService::new()),
        }
    }

    pub fn install_db(&self, db: Db) {
        if let Ok(mut slot) = self.db.lock() {
            *slot = Some(db);
        }
    }

    pub fn set_db_error(&self, message: String) {
        if let Ok(mut slot) = self.db_error.lock() {
            *slot = Some(message);
        }
    }

    pub fn keep_watcher(&self, watcher: notify::RecommendedWatcher) {
        if let Ok(mut slot) = self.watchers.lock() {
            slot.push(watcher);
        }
    }

    pub fn db_error(&self) -> Option<String> {
        self.db_error.lock().ok().and_then(|guard| guard.clone())
    }

    /// 借出数据库；不可用时返回带 detail 的 E_DB，前端据此展示原因。
    pub fn with_db<T>(
        &self,
        f: impl FnOnce(&Db) -> Result<T, crate::error::ApiError>,
    ) -> Result<T, crate::error::ApiError> {
        let guard = self.db.lock().map_err(|_| {
            crate::error::ApiError::new(crate::error::ApiErrorCode::Internal, "状态锁已中毒", true)
        })?;
        match guard.as_ref() {
            Some(db) => f(db),
            None => Err(crate::error::ApiError::new(
                crate::error::ApiErrorCode::Db,
                "数据库错误",
                true,
            )
            .with_detail(format!(
                "数据目录 {} :: {}",
                self.data_dir.display(),
                self.db_error().unwrap_or_else(|| "数据库尚未初始化".to_string())
            ))),
        }
    }
}