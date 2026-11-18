// 应用装配：日志 -> 数据库 -> 协议壳 -> Command 注册 -> 事件。
//
// 注意：本机环境 WebView2 窗口创建被拒绝（PermissionDenied），因此运行时探针 V-06
// 只能在具备桌面 WebView2 权限的机器上关闭；逻辑侧的 Range/URI 判定已有单测覆盖。

pub mod commands;
pub mod contracts;
pub mod db;
pub mod error;
pub mod logging;
pub mod protocol;

use tauri::{Emitter, Manager};

const PDF_SCHEME: &str = "pdf";

// 窗口由代码创建而非 tauri.conf.json：只有程序化创建才能指定 WebView2 数据目录，
// 而受限环境/便携模式下必须能把该目录指到可写位置（见 docs/18 §10）。
const WINDOW_LABEL: &str = "main";
const WINDOW_TITLE: &str = "Legere";
const WINDOW_WIDTH: f64 = 1280.0;
const WINDOW_HEIGHT: f64 = 860.0;
const WINDOW_MIN_WIDTH: f64 = 960.0;
const WINDOW_MIN_HEIGHT: f64 = 640.0;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 数据目录：默认 appDataDir；LEGERE_DATA_DIR 可覆盖（便携模式 / 受限环境调试）。
            let data_dir = std::env::var_os("LEGERE_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    app.path()
                        .app_data_dir()
                        .unwrap_or_else(|_| std::env::temp_dir().join("legere"))
                });

            // 日志句柄必须活到进程结束；用 manage 持有。
            match logging::init(&data_dir.join("logs")) {
                Ok(guard) => {
                    tracing::info!(
                        log_dir = ?guard.log_dir,
                        version = commands::VERSION,
                        "Legere 启动"
                    );
                    app.manage(guard);
                }
                Err(err) => {
                    // 日志目录不可写不应阻塞启动，但要留下痕迹。
                    eprintln!("日志初始化失败: {err}");
                }
            }

            // 数据库：打开/迁移失败属于致命问题，必须显式报错而不是静默降级。
            let db_path = data_dir.join("legere.db");
            match db::Db::open(&db_path) {
                Ok(handle) => {
                    tracing::info!(
                        db = ?handle.path(),
                        fts5 = handle.capabilities().fts5,
                        contentless_delete = handle.capabilities().contentless_delete,
                        "数据库就绪"
                    );
                    app.manage(handle);
                }
                Err(err) => {
                    eprintln!("数据库初始化失败: {err:?}");
                    return Err(Box::new(std::io::Error::other(format!("db init failed: {err:?}"))) as Box<dyn std::error::Error>);
                }
            }

            // 建窗：数据目录可由 LEGERE_WEBVIEW_DATA_DIR 覆盖（默认交给 wry）。
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
                builder = builder.data_directory(std::path::PathBuf::from(dir));
            }

            match builder.build() {
                Ok(_) => tracing::info!("窗口已创建"),
                Err(err) => {
                    // 建窗失败不 panic：让日志与命令仍可用，便于诊断环境问题。
                    tracing::error!(?err, "窗口创建失败");
                    eprintln!("window build failed: {err:?}");
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
            // M01/M03 阶段：只解析路由与 Range，返回内置样本；真实取文件由 M04 的
            // DocumentPathResolver 提供（docs/05 §12），届时替换此处实现。
            let uri = request.uri().to_string();
            let range_header = request.headers().get("range").and_then(|v| v.to_str().ok());

            // V-06 取证点：真实客户端请求时记录 URI 形态与 Range 头。
            tracing::info!(
                %uri,
                range = ?range_header,
                method = %request.method(),
                "pdf:// 请求进入"
            );

            let response = match protocol::parse_document_id(&uri) {
                Some(_doc_id) => {
                    let sample: &[u8] = include_bytes!("../assets/sample.pdf");
                    protocol::respond(sample, range_header)
                }
                None => protocol::ProtocolResponse {
                    status: 400,
                    content_range: None,
                    body: Vec::new(),
                },
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
                tauri::http::Response::builder()
                    .status(500)
                    .body(Vec::new())
                    .expect("构造 500 响应不应失败")
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
