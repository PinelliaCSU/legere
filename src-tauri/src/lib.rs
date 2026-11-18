// 应用装配顺序（有意为之）：
//   1. 解析数据目录（多级回退）  2. 初始化日志（多级回退 + panic 落盘）
//   3. 建窗口  4. 打开数据库（失败只降级）  5. 广播 ready
// 先建窗口再开库：任何后端初始化失败都不能让用户看到「双击后什么都没有」。

pub mod commands;
pub mod contracts;
pub mod db;
pub mod error;
pub mod logging;
pub mod protocol;
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

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let candidates = data_dir_candidates(app.handle());

            // 日志目录：候选目录下的 logs/，依次尝试；全部失败也不 panic（只是没有文件日志）。
            let log_candidates: Vec<PathBuf> = candidates.iter().map(|d| d.join("logs")).collect();
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
            let mut builder = tauri::WebviewWindowBuilder::new(
                app,
                WINDOW_LABEL,
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title(WINDOW_TITLE)
            .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
            .min_inner_size(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT);

            if let Some(dir) = std::env::var_os("LEGERE_WEBVIEW_DATA_DIR") {
                std::fs::create_dir_all(&dir).ok();
                builder = builder.data_directory(PathBuf::from(dir));
            }

            match builder.build() {
                Ok(_) => tracing::info!("窗口已创建"),
                Err(err) => {
                    tracing::error!(?err, "窗口创建失败");
                    eprintln!("window build failed: {err:?}");
                    // release 没有控制台：把原因写到 exe 同级，避免「双击后什么都没有」。
                    if let Ok(exe) = std::env::current_exe() {
                        if let Some(dir) = exe.parent() {
                            let msg = format!("窗口创建失败: {err:?}\n数据目录: {}\n", data_dir.display());
                            let _ = std::fs::write(dir.join("startup-error.txt"), msg);
                        }
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

            app.emit(
                contracts::evt::E_APP_READY,
                contracts::evt::AppReadyPayload { version: commands::VERSION.to_string() },
            )
            .ok();

            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol(PDF_SCHEME, |_app, request, responder| {
            let uri = request.uri().to_string();
            let range_header = request.headers().get("range").and_then(|v| v.to_str().ok());

            // V-06 取证点：真实客户端请求时记录 URI 形态与 Range 头。
            tracing::info!(%uri, range = ?range_header, method = %request.method(), "pdf:// 请求进入");

            let response = match protocol::parse_document_id(&uri) {
                Some(_doc_id) => {
                    let sample: &[u8] = include_bytes!("../assets/sample.pdf");
                    protocol::respond(sample, range_header)
                }
                None => protocol::ProtocolResponse { status: 400, content_range: None, body: Vec::new() },
            };

            tracing::info!(
                status = response.status,
                content_range = ?response.content_range,
                body_len = response.body.len(),
                "pdf:// 响应"
            );

            let mut builder = tauri::http::Response::builder()
                .status(response.status)
                .header("Content-Type", "application/pdf")
                .header("Accept-Ranges", "bytes")
                .header("Content-Length", response.body.len().to_string());
            if let Some(content_range) = response.content_range {
                builder = builder.header("Content-Range", content_range);
            }

            let built = builder.body(response.body).unwrap_or_else(|_| {
                tauri::http::Response::builder().status(500).body(Vec::new()).expect("构造 500 响应不应失败")
            });
            responder.respond(built);
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::app_info,
            commands::db_integrity_check
        ])
        .run(tauri::generate_context!())
        .expect("Legere 启动失败");
}
