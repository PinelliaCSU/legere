// 文件监控（docs/02 §8）：notify 只作为「触发器」，真正的差异判定仍在 scan_root 里。
//
// 这样做的好处：监控与手动扫描共用同一套 diff，不会出现两套判定逻辑互相打架。
// 防抖：同一根目录下 800ms 内的连续事件合并成一次扫描（编辑器保存/批量复制会产生大量事件）。

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

use crate::contracts::evt::{E_LIBRARY_CHANGED, E_LIBRARY_SCAN_PROGRESS, LibraryChangeKind,
    LibraryChangedEvent, ScanPhase, ScanProgressEvent};
use crate::library::scan_root;
use crate::state::AppState;

pub const DEBOUNCE_WINDOW: Duration = Duration::from_millis(800);

/// 防抖聚合器：纯逻辑，便于单测（不依赖真实时钟）。
#[derive(Debug)]
pub struct Debouncer {
    window: Duration,
    pending: BTreeSet<PathBuf>,
    last_event: Option<Instant>,
}

impl Debouncer {
    pub fn new(window: Duration) -> Self {
        Self { window, pending: BTreeSet::new(), last_event: None }
    }

    /// 收到一个事件；返回 true 表示窗口内已静止，可冲刷。
    pub fn push(&mut self, path: PathBuf, now: Instant) -> bool {
        self.pending.insert(path);
        self.last_event = Some(now);
        false
    }

    /// 判断是否到了可以冲刷的时刻（距最后一次事件已超过窗口）。
    pub fn ready(&self, now: Instant) -> bool {
        match self.last_event {
            Some(last) => now.duration_since(last) >= self.window,
            None => false,
        }
    }

    /// 取走累积事件（冲刷）。
    pub fn take(&mut self) -> Vec<PathBuf> {
        self.last_event = None;
        std::mem::take(&mut self.pending).into_iter().collect()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

/// 为某个库根启动监控；watcher 必须被持有，否则立即停止。
pub fn start_watcher(app: AppHandle, root_id: i64, root_path: PathBuf) -> Option<RecommendedWatcher> {
    let (tx, rx) = channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        // 发送失败说明接收端已退出（应用关闭），忽略即可。
        let _ = tx.send(res);
    })
    .ok()?;

    watcher.watch(&root_path, RecursiveMode::Recursive).ok()?;

    // 独立线程处理事件：不占用 async 运行时。
    std::thread::spawn(move || {
        let mut debouncer = Debouncer::new(DEBOUNCE_WINDOW);
        loop {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(Ok(event)) => {
                    for path in event.paths {
                        // 只关心 PDF（其它类型的变更不会影响文献库）。
                        if path
                            .extension()
                            .map(|e| e.eq_ignore_ascii_case("pdf"))
                            .unwrap_or(false)
                        {
                            debouncer.push(path, Instant::now());
                        }
                    }
                }
                Ok(Err(err)) => {
                    tracing::warn!(?err, root_id, "文件监控事件异常");
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }

            if !debouncer.is_empty() && debouncer.ready(Instant::now()) {
                let changed = debouncer.take();
                tracing::info!(root_id, files = changed.len(), "监控触发增量扫描");

                let _ = app.emit(
                    E_LIBRARY_CHANGED,
                    LibraryChangedEvent {
                        kinds: vec![LibraryChangeKind::Updated],
                        document_ids: Vec::new(),
                        root_id: Some(root_id),
                    },
                );

                let state = app.state::<AppState>();
                match state.with_db(|db| scan_root(db, root_id, &root_path)) {
                    Ok(outcome) => {
                        tracing::info!(
                            root_id,
                            added = outcome.added,
                            updated = outcome.updated,
                            removed = outcome.removed,
                            "监控扫描完成"
                        );
                        let _ = app.emit(
                            E_LIBRARY_SCAN_PROGRESS,
                            ScanProgressEvent {
                                root_id: Some(root_id),
                                phase: ScanPhase::Done,
                                scanned: outcome.scanned as i64,
                                added: outcome.added as i64,
                                updated: outcome.updated as i64,
                                removed: outcome.removed as i64,
                                error: None,
                            },
                        );
                    }
                    Err(err) => tracing::error!(?err, root_id, "监控扫描失败"),
                }
            }
        }
    });

    Some(watcher)
}
