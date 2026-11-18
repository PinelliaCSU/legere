// 日志：tracing + 滚动文件（docs/02 §10、M01 Prompt F-03、裁决 T29）。
//
// 关键约束（2026-11-18 事故）：release 构建是 windows_subsystem="windows"，没有控制台，
// 任何 panic 或 eprintln 用户都看不到。因此：
//   1) 日志目录必须有多级回退，不能因为首选目录不可写就整体失效；
//   2) 必须安装 panic hook，把崩溃原因落到文件，杜绝「双击后什么也没发生」。

use std::path::{Path, PathBuf};

use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

pub const LOG_RETENTION_DAYS: u64 = 7;

/// 返回 (log_dir, guard)。guard 必须活到进程结束，否则滚动写入会被提前关闭。
pub struct LogGuard {
    _file_guard: tracing_appender::non_blocking::WorkerGuard,
    pub log_dir: PathBuf,
}

/// 按优先级尝试多个目录，第一个能创建的胜出。
pub fn init(candidates: &[PathBuf]) -> Result<LogGuard, std::io::Error> {
    let mut last_err: Option<std::io::Error> = None;
    for dir in candidates {
        match try_init_at(dir) {
            Ok(guard) => return Ok(guard),
            Err(err) => last_err = Some(err),
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("没有可用的日志目录")))
}

fn try_init_at(log_dir: &Path) -> Result<LogGuard, std::io::Error> {
    std::fs::create_dir_all(log_dir)?;

    // 目录存在不代表可写：显式探测一次，否则 tracing 会静默丢日志。
    let probe = log_dir.join(".write-probe");
    std::fs::write(&probe, b"ok")?;
    std::fs::remove_file(&probe).ok();

    let appender = tracing_appender::rolling::daily(log_dir, "legere.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(appender);
    let filter = EnvFilter::try_from_env("LEGERE_LOG").unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(non_blocking).with_ansi(false))
        .try_init()
        .ok();

    install_panic_hook(log_dir);
    purge_old_logs(log_dir, LOG_RETENTION_DAYS);

    Ok(LogGuard { _file_guard: guard, log_dir: log_dir.to_path_buf() })
}

/// 崩溃原因落到文件：release 无控制台时这是唯一证据来源。
fn install_panic_hook(log_dir: &Path) {
    let path = log_dir.join("panic.log");
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload();
        let msg = if let Some(s) = payload.downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "<非字符串 panic>".to_string()
        };
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let line = format!("[panic] {location} :: {msg}\n");
        // 追加写，保留历史崩溃记录。
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            use std::io::Write;
            let _ = file.write_all(line.as_bytes());
        }
        eprintln!("{line}");
    }));
}

fn purge_old_logs(dir: &Path, keep_days: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let Ok(modified) = meta.modified() else { continue };
        let Ok(age) = now.duration_since(modified) else { continue };
        if age.as_secs() > keep_days * 24 * 60 * 60 {
            if std::fs::remove_file(entry.path()).is_err() {
                tracing::warn!(path = ?entry.path(), "旧日志清理失败");
            }
        }
    }
}
