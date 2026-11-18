// 与 src/contracts/cmd.ts 的 CMD 一一对应（30 条）。改名 = 架构变更（docs/05 §13）。
pub const PING: &str = "ping";
pub const APP_INFO: &str = "app_info";

pub const LIBRARY_ROOT_LIST: &str = "library_root_list";
pub const LIBRARY_ROOT_ADD: &str = "library_root_add";
pub const LIBRARY_ROOT_REMOVE: &str = "library_root_remove";
pub const LIBRARY_ROOT_UPDATE: &str = "library_root_update";
pub const LIBRARY_ROOT_REPLACE: &str = "library_root_replace";
pub const LIBRARY_SCAN_START: &str = "library_scan_start";

pub const DOCUMENT_LIST: &str = "document_list";
pub const DOCUMENT_GET: &str = "document_get";
pub const DOCUMENT_URL: &str = "document_url";
pub const DOCUMENT_RECENT: &str = "document_recent";
pub const DOCUMENT_TOUCH_OPENED: &str = "document_touch_opened";
pub const DOCUMENT_RECORD_DELETE: &str = "document_record_delete";

pub const INDEX_ENQUEUE: &str = "index_enqueue";
pub const INDEX_CANCEL: &str = "index_cancel";
pub const INDEX_STATUS: &str = "index_status";
pub const INDEX_PAUSE: &str = "index_pause";
pub const INDEX_REBUILD_ALL: &str = "index_rebuild_all";

pub const SEARCH_GLOBAL: &str = "search_global";
pub const SEARCH_GLOBAL_COUNT: &str = "search_global_count";

pub const BOOKMARK_LIST: &str = "bookmark_list";
pub const BOOKMARK_CREATE: &str = "bookmark_create";
pub const BOOKMARK_UPDATE: &str = "bookmark_update";
pub const BOOKMARK_DELETE: &str = "bookmark_delete";

pub const PROGRESS_GET: &str = "progress_get";
pub const PROGRESS_SAVE: &str = "progress_save";

pub const SETTINGS_GET_ALL: &str = "settings_get_all";
pub const SETTINGS_SET: &str = "settings_set";

pub const DB_INTEGRITY_CHECK: &str = "db_integrity_check";

/// 注册表全集（数量与顺序以 docs/05 §3 为准）。M02 的比对测试依赖它。
pub const COMMAND_NAMES: [&str; 30] = [
    PING,
    APP_INFO,
    LIBRARY_ROOT_LIST,
    LIBRARY_ROOT_ADD,
    LIBRARY_ROOT_REMOVE,
    LIBRARY_ROOT_UPDATE,
    LIBRARY_ROOT_REPLACE,
    LIBRARY_SCAN_START,
    DOCUMENT_LIST,
    DOCUMENT_GET,
    DOCUMENT_URL,
    DOCUMENT_RECENT,
    DOCUMENT_TOUCH_OPENED,
    DOCUMENT_RECORD_DELETE,
    INDEX_ENQUEUE,
    INDEX_CANCEL,
    INDEX_STATUS,
    INDEX_PAUSE,
    INDEX_REBUILD_ALL,
    SEARCH_GLOBAL,
    SEARCH_GLOBAL_COUNT,
    BOOKMARK_LIST,
    BOOKMARK_CREATE,
    BOOKMARK_UPDATE,
    BOOKMARK_DELETE,
    PROGRESS_GET,
    PROGRESS_SAVE,
    SETTINGS_GET_ALL,
    SETTINGS_SET,
    DB_INTEGRITY_CHECK,
];
