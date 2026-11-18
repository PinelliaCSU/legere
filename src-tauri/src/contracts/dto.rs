// DTO 与 docs/05-api-contracts.md §2 逐字对应。
// 字段名一律 snake_case，serde 统一转 camelCase；scripts/check-contracts.mjs 会比对两侧字段。
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetaState {
    Pending,
    Ok,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextState {
    Pending,
    Indexing,
    Indexed,
    NoText,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadMode {
    Continuous,
    Single,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchMode {
    Phrase,
    Terms,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageDto<T> {
    pub items: Vec<T>,
    pub total: i64,
    pub offset: i64,
    pub limit: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingDto {
    pub ok: bool,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfoDto {
    pub version: String,
    pub data_dir: String,
    pub db_path: String,
    pub fts_enabled: bool,
    pub contentless_delete: bool,
    pub text_engine: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRootDto {
    pub id: i64,
    pub path: String,
    pub display_name: String,
    pub enabled: bool,
    pub created_at: String,
    pub last_scanned_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDto {
    pub id: i64,
    pub library_root_id: i64,
    pub file_name: String,
    pub rel_path: String,
    pub size_bytes: i64,
    pub mtime_ms: i64,
    pub page_count: Option<i64>,
    pub pdf_title: Option<String>,
    pub pdf_author: Option<String>,
    pub meta_state: MetaState,
    pub text_state: TextState,
    pub last_opened_at: Option<String>,
    pub has_progress: bool,
    pub progress_page: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDetailDto {
    pub id: i64,
    pub library_root_id: i64,
    pub file_name: String,
    pub rel_path: String,
    pub size_bytes: i64,
    pub mtime_ms: i64,
    pub page_count: Option<i64>,
    pub pdf_title: Option<String>,
    pub pdf_author: Option<String>,
    pub meta_state: MetaState,
    pub text_state: TextState,
    pub last_opened_at: Option<String>,
    pub has_progress: bool,
    pub progress_page: Option<i64>,
    pub abs_path: String,
    pub pdf_subject: Option<String>,
    pub pdf_keywords: Option<String>,
    pub pdf_producer: Option<String>,
    pub pdf_creator: Option<String>,
    pub pdf_creation_date: Option<String>,
    pub index_error_code: Option<String>,
    pub index_error_msg: Option<String>,
    pub bookmarks: Vec<BookmarkDto>,
    pub progress: Option<ProgressDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentQuery {
    pub text: Option<String>,
    pub root_ids: Option<Vec<i64>>,
    pub text_states: Option<Vec<TextState>>,
    pub sort: DocumentSort,
    pub order: SortOrder,
    pub offset: i64,
    pub limit: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentSort {
    Name,
    Recent,
    Added,
    Size,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortOrder {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSourceDto {
    pub url: String,
    pub page_count: Option<i64>,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressDto {
    pub document_id: i64,
    pub page_no: i64,
    pub scroll_ratio: f64,
    pub zoom: f64,
    pub mode: ReadMode,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkDto {
    pub id: i64,
    pub document_id: i64,
    pub page_no: i64,
    pub title: String,
    pub note: Option<String>,
    pub color: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexCurrentDto {
    pub document_id: i64,
    pub page_no: i64,
    pub total_pages: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatusDto {
    pub paused: bool,
    pub workers: i64,
    pub queued: i64,
    pub running: i64,
    pub documents_indexed: i64,
    pub documents_pending: i64,
    pub documents_failed: i64,
    pub documents_no_text: i64,
    pub current: Option<IndexCurrentDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchParams {
    pub query: String,
    pub mode: SearchMode,
    pub root_ids: Option<Vec<i64>>,
    pub hits_per_document: i64,
    pub document_offset: i64,
    pub document_limit: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchHitDto {
    pub page_no: i64,
    pub snippet: String,
    pub ranges: Vec<(i64, i64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchResultDto {
    pub document: DocumentDto,
    pub hit_count: i64,
    pub hits: Vec<GlobalSearchHitDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchPageDto {
    pub items: Vec<GlobalSearchResultDto>,
    pub total_documents: i64,
    pub offset: i64,
    pub limit: i64,
    pub took_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCountDto {
    pub documents: i64,
    pub pages: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityReportDto {
    pub fts_rows: i64,
    pub page_text_rows: i64,
    pub orphan_pages: i64,
    pub mislabeled_documents: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStartedDto {
    pub started: bool,
    pub reason: Option<String>,
}

pub type SettingsMapDto = BTreeMap<String, String>;
