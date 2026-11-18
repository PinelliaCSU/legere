use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 前端唯一可分支的错误标识（docs/05-api-contracts.md §1）。
/// 变体显式写 serde rename，避免 SNAKE_CASE 推导出错导致两侧字符串不一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ApiErrorCode {
    #[serde(rename = "E_INVALID_ARG")]
    InvalidArg,
    #[serde(rename = "E_NOT_FOUND")]
    NotFound,
    #[serde(rename = "E_DB")]
    Db,
    #[serde(rename = "E_IO")]
    Io,
    #[serde(rename = "E_PERMISSION")]
    Permission,
    #[serde(rename = "E_PDF_CORRUPT")]
    PdfCorrupt,
    #[serde(rename = "E_PDF_ENCRYPTED")]
    PdfEncrypted,
    #[serde(rename = "E_PDF_NO_TEXT")]
    PdfNoText,
    #[serde(rename = "E_BUSY")]
    Busy,
    #[serde(rename = "E_UNSUPPORTED")]
    Unsupported,
    #[serde(rename = "E_CANCELED")]
    Canceled,
    #[serde(rename = "E_INTERNAL")]
    Internal,
}

impl ApiErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidArg => "E_INVALID_ARG",
            Self::NotFound => "E_NOT_FOUND",
            Self::Db => "E_DB",
            Self::Io => "E_IO",
            Self::Permission => "E_PERMISSION",
            Self::PdfCorrupt => "E_PDF_CORRUPT",
            Self::PdfEncrypted => "E_PDF_ENCRYPTED",
            Self::PdfNoText => "E_PDF_NO_TEXT",
            Self::Busy => "E_BUSY",
            Self::Unsupported => "E_UNSUPPORTED",
            Self::Canceled => "E_CANCELED",
            Self::Internal => "E_INTERNAL",
        }
    }
}

/// 跨 IPC 的唯一错误形状。message 面向用户，detail 只进日志/调试。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiError {
    pub code: ApiErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub retriable: bool,
}

impl ApiError {
    pub fn new(code: ApiErrorCode, message: impl Into<String>, retriable: bool) -> Self {
        Self { code, message: message.into(), detail: None, retriable }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn internal(detail: impl Into<String>) -> Self {
        Self::new(ApiErrorCode::Internal, "出现内部错误", true).with_detail(detail)
    }
}

/// 领域错误：内部用 thiserror，Command 层统一转 ApiError。
/// 禁止把 anyhow 的字符串直接抛给前端。
#[derive(Debug, Error)]
pub enum DomainError {
    #[error("参数不合法: {0}")]
    InvalidArg(String),
    #[error("找不到: {0}")]
    NotFound(String),
    #[error("IO 失败: {0}")]
    Io(#[from] std::io::Error),
    #[error("权限不足: {0}")]
    Permission(String),
    #[error("尚未实现: {0}")]
    NotImplemented(String),
}

impl From<DomainError> for ApiError {
    fn from(err: DomainError) -> Self {
        match &err {
            DomainError::InvalidArg(msg) => ApiError::new(ApiErrorCode::InvalidArg, msg.clone(), false),
            DomainError::NotFound(msg) => ApiError::new(ApiErrorCode::NotFound, msg.clone(), false),
            DomainError::Io(io) => ApiError::new(ApiErrorCode::Io, "读写文件失败", true).with_detail(io.to_string()),
            DomainError::Permission(msg) => ApiError::new(ApiErrorCode::Permission, msg.clone(), false),
            DomainError::NotImplemented(msg) => ApiError::new(ApiErrorCode::Internal, "尚未实现", false).with_detail(msg.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_code_strings_are_stable() {
        // 这些字符串是前端分支依据，改名即破坏契约。
        assert_eq!(ApiErrorCode::InvalidArg.as_str(), "E_INVALID_ARG");
        assert_eq!(ApiErrorCode::PdfNoText.as_str(), "E_PDF_NO_TEXT");
        assert_eq!(ApiErrorCode::Internal.as_str(), "E_INTERNAL");
    }

    #[test]
    fn io_error_is_retriable() {
        let err: ApiError = DomainError::Io(std::io::Error::new(std::io::ErrorKind::Other, "x")).into();
        assert!(err.retriable);
        assert_eq!(err.code, ApiErrorCode::Io);
    }
}
