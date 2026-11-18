// 应用装配：日志 -> 协议壳 -> Command 注册 -> 事件。
// pdf:// 的 glue 以 Tauri 2 的 register_asynchronous_uri_scheme_protocol 为准，
// 该 API 的确切签名需按 V-06 探针在目标版本上确认（见 docs/02 §1 与 M01 Prompt §11）。

pub mod commands;
pub mod contracts;
pub mod error;
pub mod logging;
pub mod protocol;

use tauri::{Emitter, Manager};

const PDF_SCHEME: &str = "pdf";

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("legere"));

            // 日志句柄必须活到进程结束；用 manage 持有。
            match logging::init(&data_dir.join("logs")) {
                Ok(guard) => {
                    tracing::info!(log_dir = ?guard.log_dir, version = commands::VERSION, "Legere 启动");
                    app.manage(guard);
                }
                Err(err) => {
                    // 日志目录不可写不应阻塞启动，但要留下痕迹。
                    eprintln!("日志初始化失败: {err}");
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
            // M01 阶段：只解析路由与 Range，返回内置样本；真实取文件由 M04 的
            // DocumentPathResolver 提供（docs/05 §12），届时替换此处实现。
            let uri = request.uri().to_string();
            tracing::debug!(%uri, "pdf:// 请求");

            let response = match protocol::parse_document_id(&uri) {
                Some(_doc_id) => {
                    let sample: &[u8] = include_bytes!("../assets/sample.pdf");
                    protocol::respond(sample, request.headers().get("range").and_then(|v| v.to_str().ok()))
                }
                None => protocol::ProtocolResponse { status: 400, content_range: None, body: Vec::new() },
            };

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
        .invoke_handler(tauri::generate_handler![commands::ping, commands::app_info])
        .run(tauri::generate_context!())
        .expect("Legere 启动失败");
}
