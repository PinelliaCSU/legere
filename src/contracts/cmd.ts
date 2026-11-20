// Command 注册表（docs/05-api-contracts.md §3 的 30 条 + doc 说明的 debug-only 那条不在表内）。
// 入参一律为单对象；返回与错误码以 05 为准。本表是 "前端能调什么" 的唯一来源。

import type {
  AppInfoDto,
  BookmarkDto,
  DocumentDetailDto,
  DocumentDto,
  DocumentQuery,
  DocumentSourceDto,
  GlobalSearchPageDto,
  GlobalSearchParams,
  IntegrityReportDto,
  IndexStatusDto,
  LibraryRootDto,
  PageDto,
  PingDto,
  ProgressDto,
  ScanOutcomeDto,
  ScanStartedDto,
  SearchCountDto,
  SettingsMapDto,
} from "./types";

export const CMD = {
  PING: "ping",
  APP_INFO: "app_info",

  LIBRARY_ROOT_LIST: "library_root_list",
  LIBRARY_ROOT_ADD: "library_root_add",
  LIBRARY_ROOT_REMOVE: "library_root_remove",
  LIBRARY_ROOT_UPDATE: "library_root_update",
  LIBRARY_ROOT_REPLACE: "library_root_replace",
  LIBRARY_SCAN_START: "library_scan_start",
  LIBRARY_SCAN_NOW: "library_scan_now",
  LIBRARY_PICK_FOLDER: "library_pick_folder",

  DOCUMENT_LIST: "document_list",
  DOCUMENT_GET: "document_get",
  DOCUMENT_URL: "document_url",
  DOCUMENT_RECENT: "document_recent",
  DOCUMENT_TOUCH_OPENED: "document_touch_opened",
  DOCUMENT_RECORD_DELETE: "document_record_delete",

  INDEX_ENQUEUE: "index_enqueue",
  INDEX_CANCEL: "index_cancel",
  INDEX_STATUS: "index_status",
  INDEX_PAUSE: "index_pause",
  INDEX_REBUILD_ALL: "index_rebuild_all",

  SEARCH_GLOBAL: "search_global",
  SEARCH_GLOBAL_COUNT: "search_global_count",

  BOOKMARK_LIST: "bookmark_list",
  BOOKMARK_CREATE: "bookmark_create",
  BOOKMARK_UPDATE: "bookmark_update",
  BOOKMARK_DELETE: "bookmark_delete",

  PROGRESS_GET: "progress_get",
  PROGRESS_SAVE: "progress_save",

  SETTINGS_GET_ALL: "settings_get_all",
  SETTINGS_SET: "settings_set",

  DB_INTEGRITY_CHECK: "db_integrity_check",
} as const;

export type CmdName = (typeof CMD)[keyof typeof CMD];

export interface CommandMap {
  ping: { args: Record<string, never>; result: PingDto };
  app_info: { args: Record<string, never>; result: AppInfoDto };

  library_root_list: { args: Record<string, never>; result: LibraryRootDto[] };
  library_root_add: { args: { path: string }; result: LibraryRootDto };
  library_root_remove: { args: { id: number; purge: boolean }; result: void };
  library_root_update: { args: { id: number; displayName: string }; result: LibraryRootDto };
  library_root_replace: { args: { id: number; path: string }; result: LibraryRootDto };
  library_scan_start: { args: { rootId?: number }; result: ScanStartedDto };
  library_scan_now: { args: { rootId?: number }; result: ScanOutcomeDto };
  library_pick_folder: { args: Record<string, never>; result: string | null };

  document_list: { args: { query: DocumentQuery }; result: PageDto<DocumentDto> };
  document_get: { args: { id: number }; result: DocumentDetailDto };
  document_url: { args: { id: number }; result: DocumentSourceDto };
  document_recent: { args: { limit: number }; result: DocumentDto[] };
  document_touch_opened: { args: { id: number }; result: void };
  document_record_delete: { args: { id: number }; result: void };

  index_enqueue: { args: { documentId: number; priority?: number }; result: { jobId: number } };
  index_cancel: { args: { jobId: number }; result: void };
  index_status: { args: Record<string, never>; result: IndexStatusDto };
  index_pause: { args: { paused: boolean }; result: void };
  index_rebuild_all: { args: { rootId?: number }; result: { started: boolean } };

  search_global: { args: { params: GlobalSearchParams }; result: GlobalSearchPageDto };
  search_global_count: { args: { params: GlobalSearchParams }; result: SearchCountDto };

  bookmark_list: { args: { documentId: number }; result: BookmarkDto[] };
  bookmark_create: {
    args: { documentId: number; pageNo: number; title: string; note?: string | null; color?: string | null };
    result: BookmarkDto;
  };
  bookmark_update: {
    args: { id: number; title?: string | null; note?: string | null; color?: string | null };
    result: BookmarkDto;
  };
  bookmark_delete: { args: { id: number }; result: void };

  progress_get: { args: { documentId: number }; result: ProgressDto | null };
  progress_save: { args: { progress: ProgressDto }; result: void };

  settings_get_all: { args: Record<string, never>; result: SettingsMapDto };
  settings_set: { args: { key: string; value: string }; result: void };

  db_integrity_check: { args: Record<string, never>; result: IntegrityReportDto };
}

export const COMMAND_NAMES: readonly CmdName[] = Object.values(CMD);
