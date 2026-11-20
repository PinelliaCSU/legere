// pdf:// 句柄 + 最近段缓存（P1-2）。
//
// 收益目标：同一本书连续滚动 / 重开时，重复的 range 请求不再重复「查库 + fs::metadata + File::open
// + 分配 Vec + 磁盘读」。三条硬约束：
//
// 1. 正确性优先：每个条目都绑定 (size, mtime) 指纹；指纹不一致立刻重开句柄并丢弃该文档的全部段，
//    绝不返回陈旧字节。缓存路径已不可用（删除/改名/无权限）时条目作废、回落到查库，错误码分派
//    仍由 status_for_lookup_error / status_for_io_error 完成，缓存不吞任何 IO 错误。
// 2. 有界：句柄 <= MAX_DOCS 本，段缓存总量 <= MAX_SEG_BYTES 且单段 <= RANGE_MAX_BYTES，
//    单本段条数 <= MAX_SEGS_PER_DOC；超出按 LRU 淘汰。
// 3. 锁只在同步代码里持有：协议处理器是同步语义（responder 在 IO 线程上直接跑），
//    所以这里的 Mutex 不存在跨 await 持锁的问题。

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::SystemTime;

use super::{read_span, RANGE_MAX_BYTES};

/// 句柄缓存上限：同时最多保持 4 本书的已打开句柄。
pub const MAX_DOCS: usize = 4;

/// 段缓存总字节上限（跨所有文档共享）。
pub const MAX_SEG_BYTES: usize = 16 * 1024 * 1024;

/// 单本文档的段条数上限。只有字节上限不够：大量几十字节的小段会让条目数（而非字节数）无界。
pub const MAX_SEGS_PER_DOC: usize = 32;

/// 文件指纹。同一份文件才会得到相同的 (size, modified)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fingerprint {
    pub size: u64,
    pub modified: Option<SystemTime>,
}

impl Fingerprint {
    pub fn of(meta: &std::fs::Metadata) -> Self {
        // modified() 理论上可失败（无 mtime 的文件系统）：失败时退化为只比 size，
        // 仍然比「不校验」安全，且不会误判为相同文件。
        Self { size: meta.len(), modified: meta.modified().ok() }
    }
}

/// 已解析的文档来源：路径 + 指纹。指纹有效时由缓存直接给出（省掉查库）。
#[derive(Debug, Clone)]
pub struct Source {
    doc_id: i64,
    pub path: PathBuf,
    pub size: u64,
    fp: Fingerprint,
}

/// 解析来源的失败：两类错误的分派方式不同，必须保留成因。
#[derive(Debug)]
pub enum SourceError {
    /// 查库失败 -> status_for_lookup_error（404/403/423/400/500）。
    Lookup(crate::error::ApiError),
    /// 打开文件 / 读元数据失败 -> status_for_io_error（410/403/423/500）。
    /// 带上路径：处理器要用同一条 io_error_reason 文案（含是哪个库根下的文件）。
    Io(PathBuf, std::io::Error),
}

/// 缓存命中统计。只给单测与 debug 日志用，不上报、不落盘。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct CacheStats {
    /// 直接用缓存路径（未查库）的次数。
    pub doc_hits: u64,
    /// 走查库的次数。
    pub doc_misses: u64,
    /// 段缓存命中次数。
    pub seg_hits: u64,
    /// 段缓存未命中（真读盘）的次数。
    pub seg_misses: u64,
    /// 因指纹变化而重开句柄的次数。
    pub invalidations: u64,
}

struct Segment {
    start: u64,
    bytes: Vec<u8>,
    tick: u64,
}

impl Segment {
    fn end(&self) -> u64 {
        self.start + self.bytes.len() as u64
    }

    /// 包含关系即命中：PDF.js 会重发同一段，也会发落在同一段内的更小段。
    fn covers(&self, start: u64, len: u64) -> bool {
        start >= self.start && start.saturating_add(len) <= self.end()
    }
}

struct DocEntry {
    doc_id: i64,
    path: PathBuf,
    file: std::fs::File,
    fp: Fingerprint,
    tick: u64,
    segs: Vec<Segment>,
}

struct Inner {
    max_docs: usize,
    max_seg_bytes: usize,
    docs: Vec<DocEntry>,
    tick: u64,
    stats: CacheStats,
}

pub struct DocCache {
    inner: Mutex<Inner>,
}

impl Default for DocCache {
    fn default() -> Self {
        Self::new()
    }
}

impl DocCache {
    pub fn new() -> Self {
        Self::with_limits(MAX_DOCS, MAX_SEG_BYTES)
    }

    /// 自定义上限：只给单测用（用小上限跑同一套淘汰逻辑，不必造几十 MiB 的临时文件）。
    pub fn with_limits(max_docs: usize, max_seg_bytes: usize) -> Self {
        Self {
            inner: Mutex::new(Inner {
                max_docs: max_docs.max(1),
                max_seg_bytes,
                docs: Vec::new(),
                tick: 0,
                stats: CacheStats::default(),
            }),
        }
    }

    /// 解析文档来源：缓存里的路径仍指向同一份文件（指纹一致）就直接复用，省掉一次查库；
    /// 否则回调 lookup 查库，并对新路径做一次带指纹的开句柄。
    pub fn source<F>(&self, doc_id: i64, lookup: F) -> Result<Source, SourceError>
    where
        F: FnOnce() -> Result<PathBuf, crate::error::ApiError>,
    {
        let cached = {
            let inner = self.lock();
            inner.docs.iter().find(|d| d.doc_id == doc_id).map(|d| (d.path.clone(), d.fp))
        };

        if let Some((path, fp)) = cached {
            match std::fs::metadata(&path) {
                Ok(meta) if Fingerprint::of(&meta) == fp => {
                    self.mark_used(doc_id);
                    tracing::debug!(
                        document_id = doc_id,
                        path = %path.display(),
                        "pdf:// 句柄缓存命中（未查库）"
                    );
                    return Ok(Source { doc_id, path, size: fp.size, fp });
                }
                Ok(_) => {
                    // 文件被改写：重开句柄并丢掉该文档的所有段。
                    return self.reopen(doc_id, path);
                }
                Err(_) => {
                    // 缓存路径已不可用：条目作废，回落到查库 + 打开，错误码照旧分派。
                    self.evict_doc(doc_id);
                }
            }
        }

        let path = lookup().map_err(SourceError::Lookup)?;
        let (file, fp) =
            open_with_fingerprint(&path).map_err(|err| SourceError::Io(path.clone(), err))?;
        {
            let mut inner = self.lock();
            inner.tick += 1;
            inner.stats.doc_misses += 1;
            inner.install(doc_id, path.clone(), file, fp);
        }
        Ok(Source { doc_id, path, size: fp.size, fp })
    }

    /// 读 [start, start+len)：段命中直接返回拷贝；未命中用缓存的句柄读一次并写入段缓存。
    /// IO 错误一律原样上抛（缓存不吞错误）。
    pub fn read(&self, source: &Source, start: u64, len: u64) -> std::io::Result<Vec<u8>> {
        let mut guard = self.lock();
        let Some(idx) = guard.docs.iter().position(|d| {
            d.doc_id == source.doc_id && d.path == source.path && d.fp == source.fp
        }) else {
            // 条目已被别的书挤掉：退化成无缓存读取，语义与 read_span 完全一致。
            drop(guard);
            return read_span(&source.path, start, len);
        };

        let inner = &mut *guard;
        inner.tick += 1;
        let tick = inner.tick;

        if let Some((seg_idx, offset)) = find_covering(&inner.docs[idx].segs, start, len) {
            let seg = &mut inner.docs[idx].segs[seg_idx];
            seg.tick = tick;
            let bytes = seg.bytes[offset..offset + len as usize].to_vec();
            inner.stats.seg_hits += 1;
            tracing::debug!(document_id = source.doc_id, start, len, "pdf:// 段缓存命中");
            return Ok(bytes);
        }

        let bytes = {
            let entry = &mut inner.docs[idx];
            entry.tick = tick;
            read_from(&mut entry.file, start, len)?
        };
        inner.stats.seg_misses += 1;
        inner.store_segment(idx, start, bytes.clone());
        Ok(bytes)
    }

    pub fn stats(&self) -> CacheStats {
        self.lock().stats
    }

    /// (已缓存句柄数, 段缓存字节数)：给单测校验「有界」用。
    pub fn retained(&self) -> (usize, usize) {
        let inner = self.lock();
        (inner.docs.len(), inner.seg_bytes())
    }

    fn reopen(&self, doc_id: i64, path: PathBuf) -> Result<Source, SourceError> {
        let opened = open_with_fingerprint(&path);
        let (file, fp) = match opened {
            Ok(pair) => pair,
            Err(err) => {
                // 打不开就把条目丢掉：留着只会让后续请求反复走同一条失败路径。
                self.evict_doc(doc_id);
                return Err(SourceError::Io(path, err));
            }
        };
        {
            let mut inner = self.lock();
            inner.tick += 1;
            inner.stats.invalidations += 1;
            inner.install(doc_id, path.clone(), file, fp);
        }
        tracing::debug!(
            document_id = doc_id,
            path = %path.display(),
            "pdf:// 文件已改写：重开句柄并丢弃旧段"
        );
        Ok(Source { doc_id, path, size: fp.size, fp })
    }

    fn mark_used(&self, doc_id: i64) {
        let mut inner = self.lock();
        inner.tick += 1;
        inner.stats.doc_hits += 1;
        let tick = inner.tick;
        if let Some(doc) = inner.docs.iter_mut().find(|d| d.doc_id == doc_id) {
            doc.tick = tick;
        }
    }

    fn evict_doc(&self, doc_id: i64) {
        let mut inner = self.lock();
        inner.docs.retain(|d| d.doc_id != doc_id);
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // 中毒说明有线程在持锁时 panic：缓存只是加速层，继续用一个可能不一致的状态仍然安全
        // （每次读取都会重新校验指纹），直接恢复比让 pdf:// 整体挂掉更合理。
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Inner {
    fn seg_bytes(&self) -> usize {
        self.docs.iter().flat_map(|d| d.segs.iter()).map(|s| s.bytes.len()).sum()
    }

    fn install(&mut self, doc_id: i64, path: PathBuf, file: std::fs::File, fp: Fingerprint) {
        let tick = self.tick;
        if let Some(idx) = self.docs.iter().position(|d| d.doc_id == doc_id) {
            if self.docs[idx].fp != fp {
                // 指纹变了：旧段对应的字节不再可信。
                self.docs[idx].segs.clear();
            }
            let doc = &mut self.docs[idx];
            doc.path = path;
            doc.file = file;
            doc.fp = fp;
            doc.tick = tick;
            return;
        }

        while self.docs.len() >= self.max_docs {
            if !self.evict_oldest_doc() {
                break;
            }
        }
        self.docs.push(DocEntry { doc_id, path, file, fp, tick, segs: Vec::new() });
    }

    fn store_segment(&mut self, idx: usize, start: u64, bytes: Vec<u8>) {
        let single_cap = self.max_seg_bytes.min(RANGE_MAX_BYTES as usize);
        if bytes.is_empty() || bytes.len() > single_cap {
            return;
        }

        // 新段完全覆盖的旧段先删掉，否则同一段会被重复计费。
        let new_end = start + bytes.len() as u64;
        self.docs[idx].segs.retain(|s| !(s.start >= start && s.end() <= new_end));

        while self.seg_bytes() + bytes.len() > self.max_seg_bytes {
            if !self.evict_oldest_segment() {
                return;
            }
        }
        while self.docs[idx].segs.len() >= MAX_SEGS_PER_DOC {
            if !self.evict_oldest_segment_in(idx) {
                break;
            }
        }

        let tick = self.tick;
        self.docs[idx].segs.push(Segment { start, bytes, tick });
    }

    fn evict_oldest_doc(&mut self) -> bool {
        let Some((idx, _)) =
            self.docs.iter().enumerate().map(|(i, d)| (i, d.tick)).min_by_key(|(_, t)| *t)
        else {
            return false;
        };
        self.docs.remove(idx);
        true
    }

    fn evict_oldest_segment(&mut self) -> bool {
        let mut victim: Option<(usize, usize, u64)> = None;
        for (di, doc) in self.docs.iter().enumerate() {
            for (si, seg) in doc.segs.iter().enumerate() {
                if victim.map_or(true, |(_, _, t)| seg.tick < t) {
                    victim = Some((di, si, seg.tick));
                }
            }
        }
        match victim {
            Some((di, si, _)) => {
                self.docs[di].segs.remove(si);
                true
            }
            None => false,
        }
    }

    fn evict_oldest_segment_in(&mut self, idx: usize) -> bool {
        let Some(si) = self.docs[idx]
            .segs
            .iter()
            .enumerate()
            .min_by_key(|(_, s)| s.tick)
            .map(|(i, _)| i)
        else {
            return false;
        };
        self.docs[idx].segs.remove(si);
        true
    }
}

fn find_covering(segs: &[Segment], start: u64, len: u64) -> Option<(usize, usize)> {
    segs.iter().enumerate().find(|(_, s)| s.covers(start, len)).map(|(i, s)| (i, (start - s.start) as usize))
}

/// 打开文件并用「句柄自身的元数据」做指纹：stat 与 open 之间被改写也不会记错指纹。
fn open_with_fingerprint(path: &std::path::Path) -> std::io::Result<(std::fs::File, Fingerprint)> {
    let file = std::fs::File::open(path)?;
    let meta = file.metadata()?;
    Ok((file, Fingerprint::of(&meta)))
}

/// 与 read_span 同一套读取语义，只是复用已打开的句柄（省掉每次 File::open）。
fn read_from(file: &mut std::fs::File, start: u64, len: u64) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};

    file.seek(SeekFrom::Start(start))?;
    let mut buf = vec![0u8; len as usize];
    let mut filled = 0usize;
    while filled < buf.len() {
        let read = file.read(&mut buf[filled..])?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    buf.truncate(filled);
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::path::Path;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("legere-cache-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    fn write_file(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).expect("写临时文件");
        path
    }

    fn pattern(len: usize, seed: u8) -> Vec<u8> {
        (0..len).map(|i| seed.wrapping_add(i as u8)).collect()
    }

    #[test]
    fn second_read_hits_segment_cache_with_identical_bytes() {
        let dir = temp_dir("hit");
        let payload = pattern(200 * 1024, 7);
        let path = write_file(&dir, "book.pdf", &payload);

        let cache = DocCache::new();
        let lookups = Cell::new(0u32);
        let src = cache
            .source(7, || {
                lookups.set(lookups.get() + 1);
                Ok(path.clone())
            })
            .expect("解析来源");
        assert_eq!(src.size, payload.len() as u64);
        assert_eq!(lookups.get(), 1);

        let first = cache.read(&src, 1000, 4096).expect("首次读");
        let second = cache.read(&src, 1000, 4096).expect("二次读");
        assert_eq!(first, payload[1000..5096].to_vec(), "首次读必须等于磁盘字节");
        assert_eq!(second, first, "二次读命中缓存且字节一致");

        let stats = cache.stats();
        assert_eq!(stats.seg_misses, 1, "首次读应未命中");
        assert_eq!(stats.seg_hits, 1, "二次读应命中");
        assert_eq!(stats.doc_misses, 1, "首次解析必须查库");

        // 落在同一段内的小段同样命中，不发生额外读盘。
        assert_eq!(cache.read(&src, 1200, 16).expect("子段读"), payload[1200..1216].to_vec());
        assert_eq!(cache.stats().seg_hits, 2);

        // 同一本书的第二个请求不应再查库：路径 + 指纹仍有效。
        let again = cache
            .source(7, || {
                lookups.set(lookups.get() + 1);
                Ok(path.clone())
            })
            .expect("再次解析来源");
        assert_eq!(again.size, payload.len() as u64);
        assert_eq!(lookups.get(), 1, "命中句柄缓存时不得再查库");
        assert_eq!(cache.stats().doc_hits, 1);
        assert_eq!(cache.read(&again, 1000, 4096).expect("复读"), first);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rewritten_file_invalidates_cache_and_returns_fresh_bytes() {
        let dir = temp_dir("rewrite");
        let old = pattern(64 * 1024, 0xAA);
        let path = write_file(&dir, "book.pdf", &old);

        let cache = DocCache::new();
        let src = cache.source(3, || Ok(path.clone())).expect("解析来源");
        let stale = cache.read(&src, 0, 1024).expect("读旧文件");
        assert_eq!(stale, old[..1024].to_vec());

        // 改写：连长度一起变，size 与 mtime 两个维度都变。
        let fresh = pattern(72 * 1024, 0x11);
        std::fs::write(&path, &fresh).expect("改写文件");

        let src2 = cache.source(3, || Ok(path.clone())).expect("改写后重新解析");
        assert_eq!(src2.size, fresh.len() as u64, "长度必须取改写后的");
        assert_eq!(cache.stats().invalidations, 1, "指纹变化必须触发重开");
        let bytes = cache.read(&src2, 0, 1024).expect("读新文件");
        assert_eq!(bytes, fresh[..1024].to_vec(), "必须返回新字节");
        assert_ne!(bytes, stale, "绝不返回陈旧字节");

        // 旧 Source 的指纹已失效：不会再从旧段里取字节。
        let via_old = cache.read(&src, 0, 1024).expect("旧来源读取");
        assert_eq!(via_old, fresh[..1024].to_vec());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn lru_eviction_keeps_bounds_without_panic() {
        let dir = temp_dir("lru");
        let payload = pattern(8 * 1024, 0x33);
        let paths: Vec<PathBuf> =
            (1..=4).map(|i| write_file(&dir, &format!("book{i}.pdf"), &payload)).collect();

        // 句柄上限 2 本：装第 3/4 本时按 LRU 淘汰最早用的那本。
        let cache = DocCache::with_limits(2, 8 * 1024);
        let mut sources = Vec::new();
        for (i, path) in paths.iter().enumerate() {
            let doc_id = i as i64 + 1;
            let src = cache.source(doc_id, || Ok(path.clone())).expect("解析来源");
            assert_eq!(cache.read(&src, 0, 1024).expect("读").len(), 1024);
            sources.push(src);
        }
        assert_eq!(cache.retained().0, 2, "句柄数必须 <= max_docs");
        assert!(cache.retained().1 <= 8 * 1024, "段缓存字节必须 <= 预算");
        assert_eq!(cache.stats().doc_misses, 4);

        // 被淘汰的第一本要重新查库，且字节仍然正确。
        let lookups = Cell::new(0u32);
        let again = cache
            .source(1, || {
                lookups.set(lookups.get() + 1);
                Ok(paths[0].clone())
            })
            .expect("重新解析来源");
        assert_eq!(lookups.get(), 1, "被淘汰的句柄必须重新查库");
        assert_eq!(cache.read(&again, 0, 1024).expect("读"), payload[..1024].to_vec());
        assert_eq!(cache.retained().0, 2);

        // 段预算不足时按 LRU 淘汰，不留超限状态。
        let tight = DocCache::with_limits(4, 4096);
        let a = tight.source(1, || Ok(paths[0].clone())).expect("解析 a");
        let b = tight.source(2, || Ok(paths[1].clone())).expect("解析 b");
        tight.read(&a, 0, 3000).expect("读 a");
        tight.read(&b, 0, 3000).expect("读 b");
        assert!(tight.retained().1 <= 4096, "总字节必须 <= 预算");
        // a 的段已被挤掉：再读是一次真实读盘，字节仍正确。
        let before = tight.stats().seg_misses;
        assert_eq!(tight.read(&a, 0, 3000).expect("复读 a"), payload[..3000].to_vec());
        assert_eq!(tight.stats().seg_misses, before + 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn oversized_span_is_not_cached() {
        let dir = temp_dir("oversize");
        let payload = pattern(RANGE_MAX_BYTES as usize + 4096, 0x5A);
        let path = write_file(&dir, "big.pdf", &payload);

        let cache = DocCache::new();
        let src = cache.source(11, || Ok(path.clone())).expect("解析来源");
        let over = cache.read(&src, 0, RANGE_MAX_BYTES + 1).expect("读超限跨度");
        assert_eq!(over.len() as u64, RANGE_MAX_BYTES + 1);
        assert_eq!(cache.retained().1, 0, "单段超过 RANGE_MAX_BYTES 不缓存");

        let ok = cache.read(&src, 0, RANGE_MAX_BYTES).expect("读上限跨度");
        assert_eq!(ok.len() as u64, RANGE_MAX_BYTES);
        assert_eq!(cache.retained().1 as u64, RANGE_MAX_BYTES);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn error_paths_keep_their_existing_semantics() {
        let dir = temp_dir("errors");
        let payload = pattern(4096, 0x77);
        let path = write_file(&dir, "book.pdf", &payload);

        let cache = DocCache::new();

        // 查库失败：仍然走 status_for_lookup_error。
        let missing_doc = cache.source(1, || {
            Err(crate::error::ApiError::new(
                crate::error::ApiErrorCode::NotFound,
                "找不到该文献",
                false,
            ))
        });
        let err = missing_doc.expect_err("查库失败必须向上抛");
        match err {
            SourceError::Lookup(ref api) => {
                assert_eq!(crate::protocol::status_for_lookup_error(api), 404)
            }
            SourceError::Io(_, other) => panic!("查库失败被误判为 IO 错误: {other}"),
        }

        // 库里有记录但磁盘上没有：IO NotFound -> 410（与 read_span 的失败路径一致）。
        let absent = dir.join("nope.pdf");
        let err = cache.source(2, || Ok(absent.clone())).expect_err("文件缺失必须向上抛");
        match err {
            SourceError::Io(io_path, io) => {
                assert_eq!(io_path, absent, "错误文案要带真实路径");
                assert_eq!(io.kind(), std::io::ErrorKind::NotFound);
                assert_eq!(crate::protocol::status_for_io_error(&io), 410);
            }
            SourceError::Lookup(_) => panic!("文件缺失被误判为查库失败"),
        }

        // 0 长度与越界 start：与 read_span 逐字节一致，不 panic。
        let src = cache.source(3, || Ok(path.clone())).expect("解析来源");
        assert_eq!(cache.read(&src, 0, 0).expect("0 长度"), read_span(&path, 0, 0).expect("基准"));
        let beyond = payload.len() as u64 + 512;
        assert_eq!(
            cache.read(&src, beyond, 16).expect("越界 start"),
            read_span(&path, beyond, 16).expect("基准越界")
        );
        assert!(cache.read(&src, beyond, 16).expect("越界 start").is_empty());

        // 缓存后被删除：条目作废，绝不返回旧段字节。
        std::fs::remove_file(&path).expect("删除文件");
        let err = cache.source(3, || Ok(path.clone())).expect_err("文件删除后必须失败");
        assert!(matches!(err, SourceError::Io(..)));
        assert_eq!(cache.retained().0, 0, "失败的条目必须被清掉");

        std::fs::remove_dir_all(&dir).ok();
    }
}
