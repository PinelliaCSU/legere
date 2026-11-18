// 日志：tracing + 滚动文件（docs/02 §10、M01 Prompt F-03、裁决 T29）。
// 级别由 LEGERE_LOG 控制（默认 info）；文件保留 7 天、单文件上限由滚动策略保证。
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use std::path::{Path, PathBuf};

pub const LOG_RETENTION_DAYS: u64 = 7;

/// 返回 (log_dir, guard)。guard 必须活到进程结束，否则滚动写入会被提前关闭。
pub struct LogGuard {
    _file_guard: tracing_appender::non_blocking::WorkerGuard,
    pub log_dir: PathBuf,
}

/// 目录可由 `LEGERE_LOG_DIR` 覆盖：仅用于开发期探针把日志写到工作区内，默认仍为 appDataDir/logs。
pub fn init(default_dir: &Path) -> Result<LogGuard, std::io::Error> {
    let overridden = std::env::var_os("LEGERE_LOG_DIR").map(std::path::PathBuf::from);
    let log_dir = overridden.as_deref().unwrap_or(default_dir);
    std::fs::create_dir_all(log_dir)?;

    let appender = tracing_appender::rolling::daily(log_dir, "legere.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(appender);

    let filter = EnvFilter::try_from_env("LEGERE_LOG").unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(non_blocking).with_ansi(false))
        .try_init()
        .ok();

    purge_old_logs(log_dir, LOG_RETENTION_DAYS);

    Ok(LogGuard { _file_guard: guard, log_dir: log_dir.to_path_buf() })
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
            // 清理失败不影响启动：只记 warn。
            if std::fs::remove_file(entry.path()).is_err() {
                tracing::warn!(path = ?entry.path(), "旧日志清理失败");
            }
        }
    }
}
