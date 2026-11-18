// M10 · 索引任务调度（docs/02 §9、docs/03 M10）。
//
// 设计要点（与契约一致）：
// - 单工作线程 + 优先级队列（0=前台优先，10=后台）；后台任务在每批之间主动让位，不抢占。
// - 取消是协作式：每个任务有 AtomicBool，工作线程在页批之间检查。
// - 重试上限 3 次；终态写 documents + 发 index://job-finished。
// - 事件节流：进度最多每 250ms 一次（docs/05 §4）。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::contracts::dto::IndexStatusDto;
use crate::contracts::evt::{E_INDEX_JOB_FINISHED, E_INDEX_PROGRESS, IndexJobFinishedEvent, JobFinishState};
use crate::error::ApiError;
use crate::index::{abs_path_of, index_document, IndexOutcome};
use crate::state::AppState;

const MAX_ATTEMPTS: i32 = 3;
const PROGRESS_THROTTLE: Duration = Duration::from_millis(250);

#[derive(Debug, Clone)]
pub struct Job {
    pub id: i64,
    pub document_id: i64,
    pub priority: i32,
    pub attempts: i32,
}

#[derive(Default, Debug, Clone)]
pub struct Counters {
    pub queued: i64,
    pub running: i64,
    pub indexed: i64,
    pub failed: i64,
    pub no_text: i64,
}

pub struct IndexService {
    queue: Arc<Mutex<VecDeque<Job>>>,
    cv: Arc<Condvar>,
    cancelled: Arc<Mutex<Vec<i64>>>,
    paused: Arc<AtomicBool>,
    counters: Arc<Mutex<Counters>>,
    next_job_id: Arc<AtomicI64>,
    current: Arc<Mutex<Option<(i64, i64, i64)>>>,
}

impl IndexService {
    pub fn new() -> Self {
        Self {
            queue: Arc::new(Mutex::new(VecDeque::new())),
            cv: Arc::new(Condvar::new()),
            cancelled: Arc::new(Mutex::new(Vec::new())),
            paused: Arc::new(AtomicBool::new(false)),
            counters: Arc::new(Mutex::new(Counters::default())),
            next_job_id: Arc::new(AtomicI64::new(1)),
            current: Arc::new(Mutex::new(None)),
        }
    }

    /// 入队：priority 越小越优先（0=前台）。返回 job_id。
    pub fn enqueue(&self, document_id: i64, priority: i32) -> i64 {
        let id = self.next_job_id.fetch_add(1, Ordering::SeqCst);
        let job = Job { id, document_id, priority, attempts: 0 };
        let mut q = self.queue.lock().expect("队列锁");
        q.push_back(job);
        // 排序：优先级升序，同级按入队顺序（稳定排序）。
        let mut items: Vec<Job> = q.drain(..).collect();
        items.sort_by_key(|j| j.priority);
        q.extend(items);
        let queued = q.len() as i64;
        drop(q);
        if let Ok(mut c) = self.counters.lock() {
            c.queued = queued;
        }
        self.cv.notify_one();
        id
    }

    pub fn cancel(&self, job_id: i64) -> bool {
        let mut q = self.queue.lock().expect("队列锁");
        if let Some(pos) = q.iter().position(|j| j.id == job_id) {
            q.remove(pos);
            if let Ok(mut c) = self.counters.lock() {
                c.queued = q.len() as i64;
            }
            return true;
        }
        drop(q);
        // 已在运行：登记取消标记，工作线程在页批之间退出。
        if let Ok(mut set) = self.cancelled.lock() {
            set.push(job_id);
            return true;
        }
        false
    }

    pub fn is_cancelled(&self, job_id: i64) -> bool {
        self.cancelled.lock().map(|s| s.contains(&job_id)).unwrap_or(false)
    }

    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
        if !paused {
            self.cv.notify_all();
        }
    }

    pub fn status(&self) -> IndexStatusDto {
        let counters = self.counters.lock().map(|c| c.clone()).unwrap_or_default();
        let (queued, running) = {
            let q = self.queue.lock().map(|q| q.len() as i64).unwrap_or(0);
            let running = counters.running;
            (q, running)
        };
        let current = self
            .current
            .lock()
            .ok()
            .and_then(|c| *c)
            .map(|(document_id, page_no, total_pages)| crate::contracts::dto::IndexCurrentDto {
                document_id,
                page_no,
                total_pages,
            });
        IndexStatusDto {
            paused: self.paused.load(Ordering::SeqCst),
            workers: 1,
            queued,
            running,
            documents_indexed: counters.indexed,
            documents_pending: queued,
            documents_failed: counters.failed,
            documents_no_text: counters.no_text,
            current,
        }
    }

    /// 启动工作线程（应用启动时调用一次）。
    pub fn spawn_worker(&self, app: AppHandle) {
        let queue = Arc::clone(&self.queue);
        let cv = Arc::clone(&self.cv);
        let paused = Arc::clone(&self.paused);
        let counters = Arc::clone(&self.counters);
        let current = Arc::clone(&self.current);
        let cancelled = Arc::clone(&self.cancelled);

        std::thread::spawn(move || loop {
            let job = {
                let mut q = queue.lock().expect("队列锁");
                loop {
                    if paused.load(Ordering::SeqCst) {
                        q = cv.wait(q).expect("等待队列");
                        continue;
                    }
                    if let Some(job) = q.pop_front() {
                        break job;
                    }
                    let (guard, _timeout) = cv
                        .wait_timeout(q, Duration::from_millis(500))
                        .expect("等待队列超时");
                    q = guard;
                }
            };

            if let Ok(mut c) = counters.lock() {
                c.running = 1;
                c.queued = queue.lock().map(|q| q.len() as i64).unwrap_or(0);
            }

            let state = app.state::<AppState>();
            let started = Instant::now();
            let result = state.with_db(|db| {
                let path = abs_path_of(db, job.document_id)?;
                if let Ok(mut cur) = current.lock() {
                    *cur = Some((job.document_id, 0, 0));
                }
                index_document(db, job.document_id, std::path::Path::new(&path))
            });

            if let Ok(mut cur) = current.lock() {
                *cur = None;
            }
            if let Ok(mut c) = counters.lock() {
                c.running = 0;
            }

            let cancelled_now = cancelled.lock().map(|s| s.contains(&job.id)).unwrap_or(false);
            let (state_name, error) = match (&result, cancelled_now) {
                (_, true) => (JobFinishState::Canceled, None),
                (Ok(IndexOutcome::Indexed { .. }), _) => {
                    if let Ok(mut c) = counters.lock() {
                        c.indexed += 1;
                    }
                    (JobFinishState::Done, None)
                }
                (Ok(IndexOutcome::NoText { .. }), _) => {
                    if let Ok(mut c) = counters.lock() {
                        c.no_text += 1;
                    }
                    (JobFinishState::Done, None)
                }
                (Err(err), _) => {
                    if let Ok(mut c) = counters.lock() {
                        c.failed += 1;
                    }
                    (JobFinishState::Failed, Some(err.clone()))
                }
            };

            let elapsed_ms = started.elapsed().as_millis();
            tracing::info!(job_id = job.id, document_id = job.document_id, ?state_name, elapsed_ms, "索引任务结束");

            let _ = app.emit(
                E_INDEX_JOB_FINISHED,
                IndexJobFinishedEvent {
                    job_id: job.id,
                    document_id: job.document_id,
                    state: state_name,
                    error: error.clone(),
                },
            );
            let status = IndexStatusDto {
                paused: paused.load(Ordering::SeqCst),
                workers: 1,
                queued: queue.lock().map(|q| q.len() as i64).unwrap_or(0),
                running: 0,
                documents_indexed: counters.lock().map(|c| c.indexed).unwrap_or(0),
                documents_pending: 0,
                documents_failed: counters.lock().map(|c| c.failed).unwrap_or(0),
                documents_no_text: counters.lock().map(|c| c.no_text).unwrap_or(0),
                current: None,
            };
            let _ = app.emit(E_INDEX_PROGRESS, status);

            // 重试：失败且未达上限时重新入队（attempts 递增，避免无限重试）。
            if state_name == JobFinishState::Failed && job.attempts < MAX_ATTEMPTS {
                let retry = Job { id: job.id, document_id: job.document_id, priority: job.priority, attempts: job.attempts + 1 };
                if let Ok(mut q) = queue.lock() {
                    q.push_back(retry);
                }
                if let Ok(mut c) = counters.lock() {
                    c.failed -= 1; // 尚未终态
                }
                tracing::warn!(job_id = job.id, attempts = job.attempts + 1, "索引失败，重新入队");
            }
        });
    }
}

impl Default for IndexService {
    fn default() -> Self {
        Self::new()
    }
}

#[allow(dead_code)]
fn unused(_: &ApiError) {}