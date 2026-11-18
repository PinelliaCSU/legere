// 防抖聚合器单测：用显式 Instant 模拟时钟，不依赖真实等待。

use std::path::PathBuf;
use std::time::{Duration, Instant};

use super::watch::{Debouncer, DEBOUNCE_WINDOW};

fn p(name: &str) -> PathBuf {
    PathBuf::from(name)
}

#[test]
fn window_is_800ms() {
    assert_eq!(DEBOUNCE_WINDOW, Duration::from_millis(800));
}

#[test]
fn events_within_window_do_not_flush() {
    let t0 = Instant::now();
    let mut d = Debouncer::new(DEBOUNCE_WINDOW);
    d.push(p("a.pdf"), t0);
    assert!(!d.ready(t0 + Duration::from_millis(500)));
    d.push(p("b.pdf"), t0 + Duration::from_millis(500));
    assert!(!d.ready(t0 + Duration::from_millis(900)), "最后一次事件后不足 800ms");
    assert!(d.ready(t0 + Duration::from_millis(1300)));
}

#[test]
fn take_drains_and_resets() {
    let t0 = Instant::now();
    let mut d = Debouncer::new(DEBOUNCE_WINDOW);
    d.push(p("a.pdf"), t0);
    d.push(p("a.pdf"), t0);
    let drained = d.take();
    assert_eq!(drained.len(), 1, "同一路径应去重");
    assert!(d.is_empty());
    assert!(!d.ready(t0 + Duration::from_secs(10)), "冲刷后不应再触发");
}

#[test]
fn multiple_paths_flush_together() {
    let t0 = Instant::now();
    let mut d = Debouncer::new(DEBOUNCE_WINDOW);
    d.push(p("a.pdf"), t0);
    d.push(p("b.pdf"), t0 + Duration::from_millis(100));
    assert!(d.ready(t0 + Duration::from_millis(1000)));
    assert_eq!(d.take().len(), 2);
}
