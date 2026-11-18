// 与 src/contracts/evt.ts 的 EVT 一一对应（5 个事件，docs/05 §4）。
use serde::{Deserialize, Serialize};

use crate::error::ApiError;

pub const E_APP_READY: &str = "app://ready";
pub const E_LIBRARY_SCAN_PROGRESS: &str = "library://scan-progress";
pub const E_LIBRARY_CHANGED: &str = "library://changed";
pub const E_INDEX_PROGRESS: &str = "index://progress";
pub const E_INDEX_JOB_FINISHED: &str = "index://job-finished";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppReadyPayload {
    pub version: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanPhase {
    Walking,
    Finalizing,
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgressEvent {
    pub root_id: Option<i64>,
    pub phase: ScanPhase,
    pub scanned: i64,
    pub added: i64,
    pub updated: i64,
    pub removed: i64,
    pub error: Option<ApiError>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LibraryChangeKind {
    Added,
    Updated,
    Removed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryChangedEvent {
    pub kinds: Vec<LibraryChangeKind>,
    pub document_ids: Vec<i64>,
    pub root_id: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobFinishState {
    Done,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexJobFinishedEvent {
    pub job_id: i64,
    pub document_id: i64,
    pub state: JobFinishState,
    pub error: Option<ApiError>,
}
