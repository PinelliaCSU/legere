// M03 · SQLite 连接、PRAGMA、迁移与能力探针（docs/04 §2/§5，决策 D10/V-03）。
//
// 并发模型：一个写连接（Mutex 串行化）+ 多个只读连接。WAL 下读写互不阻塞；
// 写事务必须短（批提交由调用方控制）。

pub mod integrity;
pub mod probe;
pub mod repo;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::{ApiError, ApiErrorCode, DomainError};

/// 迁移脚本按序号嵌入二进制；新增迁移只追加，不改旧文件（docs/04 §5）。
const MIGRATIONS: &[(i64, &str, &str)] =
    &[(1, "001_init", include_str!("../../migrations/001_init.sql"))];

#[derive(Debug, Clone, Copy, Default)]
pub struct DbCapabilities {
    pub fts5: bool,
    pub contentless_delete: bool,
}

pub struct Db {
    path: PathBuf,
    write: Mutex<Connection>,
    capabilities: DbCapabilities,
}

impl Db {
    /// 打开（或创建）数据库：PRAGMA -> 迁移 -> 能力探针。
    pub fn open(path: &Path) -> Result<Self, ApiError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_err("创建数据目录失败", e))?;
        }

        let conn = Connection::open(path).map_err(|e| db_err("打开数据库失败", e))?;
        apply_pragmas(&conn)?;
        run_migrations(&conn)?;
        let capabilities = probe::detect(&conn);

        Ok(Self { path: path.to_path_buf(), write: Mutex::new(conn), capabilities })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn capabilities(&self) -> DbCapabilities {
        self.capabilities
    }

    /// 写操作串行化入口。调用方在闭包内开启事务并自行 commit/rollback。
    pub fn with_write<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, ApiError>,
    ) -> Result<T, ApiError> {
        let mut guard = self
            .write
            .lock()
            .map_err(|_| ApiError::new(ApiErrorCode::Internal, "数据库写锁已中毒", true))?;
        f(&mut guard)
    }

    /// 只读查询：单独开连接（WAL 下与写并发）。
    pub fn with_read<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, ApiError>,
    ) -> Result<T, ApiError> {
        let conn = Connection::open_with_flags(
            &self.path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|e| db_err("打开只读连接失败", e))?;
        conn.busy_timeout(std::time::Duration::from_millis(5000))
            .map_err(|e| db_err("设置 busy_timeout 失败", e))?;
        f(&conn)
    }
}

fn apply_pragmas(conn: &Connection) -> Result<(), ApiError> {
    // journal_mode 会返回一行，必须用 query_row 而不是 execute。
    conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))
        .map_err(|e| db_err("设置 WAL 失败", e))?;
    for pragma in [
        "PRAGMA foreign_keys = ON",
        "PRAGMA busy_timeout = 5000",
        "PRAGMA synchronous = NORMAL",
    ] {
        conn.execute_batch(pragma)
            .map_err(|e| db_err("设置 PRAGMA 失败", e))?;
    }
    Ok(())
}

/// UTC 时间戳（ISO-8601，秒精度）。只需字典序可排序，因此不引入 chrono。
pub fn now_utc() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format_iso8601(now.as_secs() as i64)
}

fn format_iso8601(unix_secs: i64) -> String {
    let days = unix_secs.div_euclid(86_400);
    let secs_of_day = unix_secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60
    )
}

/// Howard Hinnant 的 civil_from_days 算法。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn run_migrations(conn: &Connection) -> Result<(), ApiError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    )
    .map_err(|e| db_err("创建 schema_migrations 失败", e))?;

    let current: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(|e| db_err("读取迁移版本失败", e))?;

    for (version, name, sql) in MIGRATIONS {
        if *version <= current {
            continue;
        }
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| db_err("开启迁移事务失败", e))?;
        tx.execute_batch(sql)
            .map_err(|e| db_err("执行迁移 SQL 失败", e))?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![version, name, now_utc()],
        )
        .map_err(|e| db_err("写入迁移版本失败", e))?;
        tx.commit().map_err(|e| db_err("提交迁移事务失败", e))?;
    }

    Ok(())
}

pub(crate) fn db_err(context: &str, err: rusqlite::Error) -> ApiError {
    ApiError::new(ApiErrorCode::Db, "数据库错误", false)
        .with_detail(format!("{context}: {err}"))
}

pub(crate) fn io_err(context: &str, err: std::io::Error) -> ApiError {
    let api: ApiError = DomainError::Io(err).into();
    api.with_detail(context.to_string())
}

#[cfg(test)]
mod tests;
