// M04 命令：库根管理、扫描、文档列表/详情/打开地址。
//
// pdf:// 的 URL 必须返回**当前平台可用形态**（契约 R21）：
// Windows 用 http://pdf.localhost/doc/{id}，其它平台用 pdf://localhost/doc/{id}。

use std::path::Path;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::contracts::dto::{
    DocumentDetailDto, DocumentDto, DocumentQuery, DocumentSourceDto, LibraryRootDto, PageDto,
    ScanStartedDto,
};
use crate::contracts::evt::{LibraryChangedEvent, LibraryChangeKind, ScanPhase, ScanProgressEvent,
    E_LIBRARY_CHANGED, E_LIBRARY_SCAN_PROGRESS};
use crate::db::repo::{LibraryRootRepo, SqlRepos};
use crate::db::repo::DocumentRepo;
use crate::error::{ApiError, ApiErrorCode};
use crate::library::{ensure_root_dir, scan_root, ScanOutcome};
use crate::state::AppState;

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;

/// 平台映射后的协议 URL（R21）。
pub fn document_url_for(id: i64, mtime_ms: i64) -> String {
    if cfg!(windows) {
        format!("http://pdf.localhost/doc/{id}?v={mtime_ms}")
    } else {
        format!("pdf://localhost/doc/{id}?v={mtime_ms}")
    }
}

#[tauri::command]
pub async fn library_root_list(state: State<'_, AppState>) -> Result<Vec<LibraryRootDto>, ApiError> {
    let repos = SqlRepos;
    state.with_db(|db| db.with_read(|conn| repos.list(conn)))
}

#[tauri::command]
pub async fn library_root_add(
    state: State<'_, AppState>,
    path: String,
) -> Result<LibraryRootDto, ApiError> {
    let dir = ensure_root_dir(&path)?;
    let display_name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let normalized = dir.to_string_lossy().replace('\\', "/");

    let repos = SqlRepos;
    state.with_db(|db| {
        db.with_write(|conn| {
            let tx = conn.unchecked_transaction().map_err(|e| {
                ApiError::new(ApiErrorCode::Db, "数据库错误", false).with_detail(e.to_string())
            })?;
            // 同一路径重复添加：直接返回已有根（幂等），不报 E_DB。
            let existing = repos.list(&tx)?;
            if let Some(found) = existing.iter().find(|r| r.path.eq_ignore_ascii_case(&normalized)) {
                return Ok(found.clone());
            }
            let created = repos.add(&tx, &normalized, &display_name)?;
            tx.commit().map_err(|e| {
                ApiError::new(ApiErrorCode::Db, "数据库错误", false).with_detail(e.to_string())
            })?;
            Ok(created)
        })
    })
}

#[tauri::command]
pub async fn library_root_remove(
    state: State<'_, AppState>,
    id: i64,
    purge: bool,
) -> Result<(), ApiError> {
    let repos = SqlRepos;
    state.with_db(|db| {
        db.with_write(|conn| {
            let tx = conn.unchecked_transaction().map_err(|e| {
                ApiError::new(ApiErrorCode::Db, "数据库错误", false).with_detail(e.to_string())
            })?;
            repos.remove(&tx, id)?;
            tx.commit().map_err(|e| {
                ApiError::new(ApiErrorCode::Db, "数据库错误", false).with_detail(e.to_string())
            })?;
            // purge 只回收磁盘空间，绝不删除用户文件（契约 R16）。
            if purge {
                conn.execute_batch("VACUUM").map_err(|e| {
                    ApiError::new(ApiErrorCode::Db, "数据库错误", false).with_detail(e.to_string())
                })?;
            }
            Ok(())
        })
    })
}

/// 扫描：立即返回 started，进度走 library://scan-progress，完成发 library://changed。
#[tauri::command]
pub async fn library_scan_start(
    app: AppHandle,
    state: State<'_, AppState>,
    root_id: Option<i64>,
) -> Result<ScanStartedDto, ApiError> {
    let repos = SqlRepos;
    let targets: Vec<LibraryRootDto> = state.with_db(|db| {
        db.with_read(|conn| {
            let all = repos.list(conn)?;
            Ok(match root_id {
                Some(id) => all.into_iter().filter(|r| r.id == id && r.enabled).collect(),
                None => all.into_iter().filter(|r| r.enabled).collect(),
            })
        })
    })?;

    if targets.is_empty() {
        return Ok(ScanStartedDto { started: false, reason: Some("没有可扫描的文献库".into()) });
    }

    // 扫描是阻塞 IO + 递归遍历：放到阻塞线程池，命令本身立即返回。
    // State 借用 app，而 app 会被移动进闭包，因此在闭包内重新取一次 State。
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        for root in targets {
            let db_state = handle.state::<AppState>();
            let _ = handle.emit(
                E_LIBRARY_SCAN_PROGRESS,
                ScanProgressEvent {
                    root_id: Some(root.id),
                    phase: ScanPhase::Walking,
                    scanned: 0,
                    added: 0,
                    updated: 0,
                    removed: 0,
                    error: None,
                },
            );

            let outcome: Result<ScanOutcome, ApiError> =
                db_state.with_db(|db| scan_root(db, root.id, Path::new(&root.path)));

            match outcome {
                Ok(out) => {
                    let _ = handle.emit(
                        E_LIBRARY_SCAN_PROGRESS,
                        ScanProgressEvent {
                            root_id: Some(root.id),
                            phase: ScanPhase::Done,
                            scanned: out.scanned as i64,
                            added: out.added as i64,
                            updated: out.updated as i64,
                            removed: out.removed as i64,
                            error: None,
                        },
                    );
                    if out.added + out.updated + out.removed + out.revived > 0 {
                        let _ = handle.emit(
                            E_LIBRARY_CHANGED,
                            LibraryChangedEvent {
                                kinds: vec![LibraryChangeKind::Added],
                                document_ids: Vec::new(),
                                root_id: Some(root.id),
                            },
                        );
                    }
                }
                Err(err) => {
                    tracing::error!(?err, root = %root.path, "扫描失败");
                    let _ = handle.emit(
                        E_LIBRARY_SCAN_PROGRESS,
                        ScanProgressEvent {
                            root_id: Some(root.id),
                            phase: ScanPhase::Done,
                            scanned: 0,
                            added: 0,
                            updated: 0,
                            removed: 0,
                            error: Some(err),
                        },
                    );
                }
            }
        }
    });

    Ok(ScanStartedDto { started: true, reason: None })
}

#[tauri::command]
pub async fn document_list(
    state: State<'_, AppState>,
    query: DocumentQuery,
) -> Result<PageDto<DocumentDto>, ApiError> {
    // 明确拒绝尚未实现的过滤维度，而不是静默忽略（否则前端会以为已生效）。
    if query.root_ids.as_ref().is_some_and(|v| !v.is_empty()) {
        return Err(ApiError::new(ApiErrorCode::Unsupported, "当前环境不支持该功能", false)
            .with_detail("document_list: rootIds 过滤尚未实现"));
    }
    if query.text_states.as_ref().is_some_and(|v| !v.is_empty()) {
        return Err(ApiError::new(ApiErrorCode::Unsupported, "当前环境不支持该功能", false)
            .with_detail("document_list: textStates 过滤尚未实现"));
    }
    let limit = query.limit.clamp(1, MAX_LIMIT);
    let offset = query.offset.max(0);
    let sort = match query.sort {
        crate::contracts::dto::DocumentSort::Name => "name",
        crate::contracts::dto::DocumentSort::Size => "size",
        crate::contracts::dto::DocumentSort::Added => "added",
        crate::contracts::dto::DocumentSort::Recent => "recent",
    };
    let order = match query.order {
        crate::contracts::dto::SortOrder::Asc => "asc",
        crate::contracts::dto::SortOrder::Desc => "desc",
    };
    let repos = SqlRepos;
    state.with_db(|db| {
        db.with_read(|conn| repos.list_filtered(conn, query.text.as_deref(), sort, order, offset, limit))
    })
}

#[tauri::command]
pub async fn document_recent(
    state: State<'_, AppState>,
    limit: i64,
) -> Result<Vec<DocumentDto>, ApiError> {
    let limit = limit.clamp(1, MAX_LIMIT);
    let repos = SqlRepos;
    state.with_db(|db| db.with_read(|conn| repos.list_recent(conn, limit)))
}

#[tauri::command]
pub async fn document_get(
    state: State<'_, AppState>,
    id: i64,
) -> Result<DocumentDetailDto, ApiError> {
    let repos = SqlRepos;
    state.with_db(|db| db.with_write(|conn| repos.get_detail(conn, id)))
}

#[tauri::command]
pub async fn document_url(
    state: State<'_, AppState>,
    id: i64,
) -> Result<DocumentSourceDto, ApiError> {
    let repos = SqlRepos;
    let (abs_path, page_count, file_name, mtime_ms) =
        state.with_db(|db| db.with_read(|conn| repos.abs_path_of(conn, id)))?;

    // 文件可能在扫描后被外部删除：明确报 NOT_FOUND，而不是给一个必然 404 的 URL。
    if !Path::new(&abs_path).exists() {
        return Err(ApiError::new(ApiErrorCode::NotFound, "找不到该文献", false)
            .with_detail(format!("文件已不在此位置：{abs_path}")));
    }

    Ok(DocumentSourceDto { url: document_url_for(id, mtime_ms), page_count, file_name })
}

#[tauri::command]
pub async fn document_touch_opened(
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), ApiError> {
    let repos = SqlRepos;
    state.with_db(|db| db.with_write(|conn| repos.touch_opened(conn, id)))
}

#[tauri::command]
pub async fn document_record_delete(
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), ApiError> {
    let repos = SqlRepos;
    state.with_db(|db| {
        db.with_write(|conn| {
            let tx = conn.unchecked_transaction().map_err(|e| {
                ApiError::new(ApiErrorCode::Db, "数据库错误", false).with_detail(e.to_string())
            })?;
            repos.delete_record(&tx, id)?;
            tx.commit().map_err(|e| {
                ApiError::new(ApiErrorCode::Db, "数据库错误", false).with_detail(e.to_string())
            })?;
            Ok(())
        })
    })
}
