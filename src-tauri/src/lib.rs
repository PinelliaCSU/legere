// 应用装配顺序（有意为之）：
//   1. 解析数据目录（多级回退）  2. 初始化日志（多级回退 + panic 落盘）
//   3. 建窗口  4. 打开数据库（失败只降级）  5. 广播 ready
// 先建窗口再开库：任何后端初始化失败都不能让用户看到「双击后什么都没有」。

pub mod commands;
pub mod contracts;
pub mod db;
pub mod error;
pub mod index;
pub mod jobs;
pub mod library;
pub mod logging;
pub mod protocol;
pub mod search;
pub mod state;

use std::path::PathBuf;

use tauri::{Emitter, Manager};

use state::AppState;

const PDF_SCHEME: &str = "pdf";

// 窗口由代码创建而非 tauri.conf.json：只有程序化创建才能指定 WebView2 数据目录，
// 而受限环境/便携模式下必须能把该目录指到可写位置（见 docs/18 §10）。
const WINDOW_LABEL: &str = "main";
const WINDOW_TITLE: &str = "Legere";
const WINDOW_WIDTH: f64 = 1280.0;
const WINDOW_HEIGHT: f64 = 860.0;
const WINDOW_MIN_WIDTH: f64 = 960.0;
const WINDOW_MIN_HEIGHT: f64 = 640.0;

/// 数据目录候选：显式覆盖 -> appDataDir -> LOCALAPPDATA\Legere -> 临时目录。
fn data_dir_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(dir) = std::env::var_os("LEGERE_DATA_DIR") {
        out.push(PathBuf::from(dir));
    }
    if let Ok(dir) = app.path().app_data_dir() {
        out.push(dir);
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        out.push(PathBuf::from(local).join("Legere"));
    }
    out.push(std::env::temp_dir().join("legere"));
    out
}

/// 依次尝试若干个 WebView2 用户数据目录来创建主窗口。
///
/// 全部失败时返回 (目录, 错误) 列表，供 startup-error.txt 记录。
fn build_main_window(
    app: &tauri::AppHandle,
    data_dir: &std::path::Path,
) -> Result<tauri::WebviewWindow, Vec<(String, String)>> {
    // 1) 显式覆盖（测试 / 便携模式）2) WebView2 默认目录 3) 数据目录下的唯一目录（必然不冲突）
    let mut candidates: Vec<(String, Option<PathBuf>)> = Vec::new();
    if let Some(dir) = std::env::var_os("LEGERE_WEBVIEW_DATA_DIR") {
        candidates.push((dir.to_string_lossy().to_string(), Some(PathBuf::from(dir))));
    }
    candidates.push(("<WebView2 默认目录>".to_string(), None));
    // 稳定的回退目录：不用 per-pid，否则每次启动都会多出一份 57 MB 的 WebView2 配置。
    let fallback = data_dir.join("webview-fallback");
    candidates.push((fallback.to_string_lossy().to_string(), Some(fallback)));

    let mut errors: Vec<(String, String)> = Vec::new();
    for (label, dir) in candidates {
        let mut builder = tauri::WebviewWindowBuilder::new(
            app,
            WINDOW_LABEL,
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title(WINDOW_TITLE)
        .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
        .min_inner_size(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT)
        // app://ready 若只在 setup 里发，会早于页面订阅（实测前端显示"未收到"）。
        // 页面加载完成后补发一次，让事件成为可靠的"已就绪"信号。
        .on_page_load(|window, _payload| {
            let version = commands::VERSION.to_string();
            let _ = window.app_handle().emit(
                contracts::evt::E_APP_READY,
                contracts::evt::AppReadyPayload { version },
            );
        });
        // v0.11 程序图标：exe 的文件/窗口图标由 tauri-build 在编译期从
        // icons/icon.ico（源自 design_pictures/legereicon.png）嵌入 Windows 资源段，
        // 窗口因此继承进程图标；无需运行期解码 PNG，也就不引入 image 依赖。
        if let Some(dir) = &dir {
            std::fs::create_dir_all(dir).ok();
            builder = builder.data_directory(dir.clone());
        }
        match builder.build() {
            Ok(window) => {
                tracing::info!(webview_data_dir = %label, "窗口已创建");
                return Ok(window);
            }
            Err(err) => {
                tracing::warn!(webview_data_dir = %label, ?err, "该 WebView2 目录建窗口失败，换下一个");
                errors.push((label, format!("{err:?}")));
            }
        }
    }
    Err(errors)
}
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let candidates = data_dir_candidates(app.handle());

            // 日志目录候选：LEGERE_LOG_DIR 优先，其次各数据目录下的 logs/；全部失败也不 panic。
            let mut log_candidates: Vec<PathBuf> = Vec::new();
            if let Some(dir) = std::env::var_os("LEGERE_LOG_DIR") {
                log_candidates.push(PathBuf::from(dir));
            }
            log_candidates.extend(candidates.iter().map(|d| d.join("logs")));
            match logging::init(&log_candidates) {
                Ok(guard) => {
                    tracing::info!(
                        log_dir = ?guard.log_dir,
                        version = commands::VERSION,
                        candidates = ?candidates,
                        "Legere 启动"
                    );
                    app.manage(guard);
                }
                Err(err) => {
                    eprintln!("日志初始化失败（继续运行）: {err}");
                }
            }

            // 数据目录：取第一个可写候选。
            let data_dir = candidates
                .iter()
                .find(|dir| {
                    std::fs::create_dir_all(dir).is_ok()
                        && std::fs::write(dir.join(".write-probe"), b"ok").is_ok()
                })
                .cloned()
                .unwrap_or_else(|| std::env::temp_dir().join("legere"));
            tracing::info!(?data_dir, "数据目录已选定");

            app.manage(AppState::new(data_dir.clone()));

            // 先建窗口：即使后端全挂，用户也要看到界面与原因。
            //
            // 为什么这里要「多目录重试」：WebView2 的用户数据目录同一时刻只能被一个进程占用，
            // 抢不到时 CreateWebview 直接返回 0x800700AA（ERROR_BUSY，「请求的资源在使用中」）。
            // 以前遇到这种情况只写一个 startup-error.txt 就没有窗口了 —— 用户看到的就是
            // 「窗口闪一下然后消失」（双击连按两次、或上一个进程的 WebView2 还没退干净都会触发）。
            // 现在依次尝试：显式指定的目录 → WebView2 默认目录 → 数据目录下的唯一目录，
            // 只要有一个能建出窗口，应用就能正常启动。
            match build_main_window(app.handle(), &data_dir) {
                Ok(_) => tracing::info!("窗口已创建"),
                Err(errors) => {
                    tracing::error!(?errors, "窗口创建失败（已尝试全部 WebView2 数据目录）");
                    eprintln!("window build failed: {errors:?}");
                    // release 没有控制台：把原因写到 exe 同级，避免「双击后什么都没有」。
                    if let Ok(exe) = std::env::current_exe() {
                        if let Some(dir) = exe.parent() {
                            let mut msg = String::from("窗口创建失败：所有 WebView2 数据目录都不可用\n");
                            msg.push_str(&format!("应用数据目录: {}\n\n", data_dir.display()));
                            for (candidate, error) in &errors {
                                msg.push_str(&format!("- {} => {}\n", candidate, error));
                            }
                            msg.push_str("\n处理建议：\n  1. 关闭其它 Legere 窗口后重试；\n  2. 仍失败可把 WebView2 默认目录下的 EBWebView 改名后再启动；\n  3. 三个目录全失败时，先检查这个 exe 的完整性标签：\n     icacls legere.exe\n     若出现 \"Low Mandatory Level\"，说明它是被低完整性进程构建出来的：低完整性进程\n     既写不了 AppData，也起不了 WebView2。执行下面这行改回 Medium 后重试：\n     icacls legere.exe /setintegritylevel Medium\n");
                            let _ = std::fs::write(dir.join("startup-error.txt"), msg);
                        }
                        // 没有窗口就不要留一个僵尸进程在后台：任务管理器里会看到一个「看不见的 Legere」，
                        // 反而让人以为启动成功了。
                        eprintln!("no window could be created, exiting");
                        std::process::exit(1);
                    }
                }
            }
            // 再开数据库：失败只登记错误，不阻断启动。
            let db_path = data_dir.join("legere.db");
            match db::Db::open(&db_path) {
                Ok(handle) => {
                    tracing::info!(
                        db = ?handle.path(),
                        fts5 = handle.capabilities().fts5,
                        contentless_delete = handle.capabilities().contentless_delete,
                        "数据库就绪"
                    );
                    if let Some(state) = app.try_state::<AppState>() {
                        state.install_db(handle);
                    }
                }
                Err(err) => {
                    tracing::error!(?err, "数据库初始化失败（降级运行）");
                    eprintln!("数据库初始化失败（降级运行）: {err:?}");
                    if let Some(state) = app.try_state::<AppState>() {
                        state.set_db_error(format!("{err:?}"));
                    }
                }
            }

            // 为已启用的库根启动文件监控（触发器，真正的 diff 在 scan_root）。
            if let Some(state) = app.try_state::<AppState>() {
                let repos = db::repo::SqlRepos;
                let roots = state
                    .with_db(|db| {
                        use db::repo::LibraryRootRepo;
                        db.with_read(|conn| db::repo::LibraryRootRepo::list(&repos, conn))
                    })
                    .unwrap_or_default();
                for root in roots.into_iter().filter(|r| r.enabled) {
                    if let Some(watcher) = library::watch::start_watcher(
                        app.handle().clone(),
                        root.id,
                        PathBuf::from(&root.path),
                    ) {
                        state.keep_watcher(watcher);
                        tracing::info!(root_id = root.id, path = %root.path, "已启动文件监控");
                    } else {
                        tracing::warn!(root_id = root.id, path = %root.path, "文件监控启动失败");
                    }
                }
            }

            // 索引工作线程（M10）：随应用启动一次。
            if let Some(state) = app.try_state::<AppState>() {
                state.index.spawn_worker(app.handle().clone());
                tracing::info!("索引工作线程已启动");
            }

            app.emit(
                contracts::evt::E_APP_READY,
                contracts::evt::AppReadyPayload { version: commands::VERSION.to_string() },
            )
            .ok();

            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol(PDF_SCHEME, |app, request, responder| {
            // 真实实现：按 document_id 从数据库解析绝对路径，用 Range 读文件（docs/05 §6 / R15）。
            // 之前这里永远返回内置 sample.pdf —— 这正是「打开任何书都只有一行字」的根因。
            // 现在每种失败都映射到可区分的状态码：404 记录缺失 / 410 文件不存在 / 403 无权限 /
            // 423 被占用 / 416 Range 不可满足 / 400 Range 或 id 非法 / 500 其它读取失败。
            let uri = request.uri().to_string();
            let is_head = request.method() == tauri::http::Method::HEAD;
            let range_header = request.headers().get("range").and_then(|v| v.to_str().ok());

            if request.method() == tauri::http::Method::OPTIONS {
                // Range 不在 CORS 安全列表内，浏览器必先发预检。
                responder.respond(protocol::build_preflight_response());
                return;
            }

            let Some(doc_id) = protocol::parse_document_id(&uri) else {
                tracing::warn!(%uri, "pdf:// 无法解析 document id");
                let plan = protocol::plan_error(400, "无法从 URL 解析 document id");
                let body = plan.body_bytes();
                responder.respond(protocol::build_response(&plan, body));
                return;
            };

            // Tauri 2 传入的是 UriSchemeContext，需先取 AppHandle 才能访问受管状态。
            let handle = app.app_handle();
            let state = handle.state::<AppState>();

            // P1-2：pdf:// 句柄 + 最近段缓存。命中时省掉查库与 File::open，只留一次指纹校验的 stat；
            // 文件被库扫描/用户改写（size 或 mtime 变化）则重开句柄并丢段，绝不返回陈旧字节。
            let source = match state.pdf_cache.source(doc_id, || {
                state
                    .with_db(|db| {
                        let repos = db::repo::SqlRepos;
                        db.with_read(|conn| {
                            use db::repo::DocumentRepo;
                            repos.abs_path_of(conn, doc_id)
                        })
                    })
                    .map(|(abs_path, _, _, _)| std::path::PathBuf::from(abs_path))
            }) {
                Ok(source) => source,
                Err(protocol::cache::SourceError::Lookup(err)) => {
                    // 只有「数据库里没有这条记录」才是 404，其余查库失败是 500。
                    let status = protocol::status_for_lookup_error(&err);
                    tracing::warn!(document_id = doc_id, status, ?err, "pdf:// 查库失败");
                    let plan = protocol::plan_error(status, protocol::lookup_error_reason(&err));
                    let body = plan.body_bytes();
                    responder.respond(protocol::build_response(&plan, body));
                    return;
                }
                Err(protocol::cache::SourceError::Io(path, err)) => {
                    // 记录在库但磁盘上读不到：410 不存在 / 403 无权限 / 423 被占用 / 500 其它。
                    let status = protocol::status_for_io_error(&err);
                    tracing::warn!(?path, status, ?err, "pdf:// 打开文件失败");
                    let plan = protocol::plan_error(status, protocol::io_error_reason(&path, &err));
                    let body = plan.body_bytes();
                    responder.respond(protocol::build_response(&plan, body));
                    return;
                }
            };

            let mut plan = protocol::plan_ok(range_header, source.size);
            // HEAD 只回头部：同一份计划，但不读 plan.span 的字节，Content-Length 仍是真实长度。
            let mut body = if is_head { Vec::new() } else { plan.body_bytes() };
            if !is_head {
                if let Some((start, len)) = plan.span {
                    // 段命中直接返回缓存字节；未命中才用缓存句柄读盘（失败分派与原先一致）。
                    match state.pdf_cache.read(&source, start, len) {
                        Ok(bytes) => body = bytes,
                        Err(err) => {
                            let status = protocol::status_for_io_error(&err);
                            tracing::error!(
                                path = %source.path.display(),
                                status,
                                start,
                                len,
                                ?err,
                                "pdf:// 区间读取失败"
                            );
                            plan = protocol::plan_error(
                                status,
                                protocol::io_error_reason(&source.path, &err),
                            );
                            body = plan.body_bytes();
                        }
                    }
                }
            }

            tracing::debug!(
                document_id = doc_id,
                %uri,
                range = ?range_header,
                status = plan.status,
                body_len = body.len(),
                "pdf:// 响应"
            );

            responder.respond(protocol::build_response(&plan, body));
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::app_info,
            commands::db_integrity_check,
            commands::library::library_root_list,
            commands::library::library_root_add,
            commands::library::library_root_remove,
            commands::library::library_scan_start,
            commands::library::library_scan_now,
            commands::library::library_pick_folder,
            commands::library::document_list,
            commands::library::document_recent,
            commands::library::document_get,
            commands::library::document_url,
            commands::library::document_touch_opened,
            commands::library::document_record_delete,
            commands::library::library_root_update,
            commands::library::library_root_replace,
            commands::index::index_enqueue,
            commands::index::index_cancel,
            commands::index::index_status,
            commands::index::index_pause,
            commands::index::index_rebuild_all,
            commands::index::search_global,
            commands::index::search_global_count,
            commands::misc::bookmark_list,
            commands::misc::bookmark_create,
            commands::misc::bookmark_update,
            commands::misc::bookmark_delete,
            commands::misc::progress_get,
            commands::misc::progress_save,
            commands::misc::settings_get_all,
            commands::misc::settings_set
        ])
        .run(tauri::generate_context!())
        .expect("Legere 启动失败");
}