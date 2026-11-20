// 本地 Range 服务器：支持 bytes=a-b / bytes=a- / bytes=-N，206 + Content-Range + Accept-Ranges，
// 单次响应上限对齐仓库常量 RANGE_MAX_BYTES = 8 MiB（src-tauri/src/protocol/range.rs:8,71）。
// 响应体分块写出并遵守背压，客户端中止时停止计数，因此统计的是"实际写出"的字节而非"打算写的"。
import { createServer } from "node:http";
import { closeSync, openSync, readSync, statSync } from "node:fs";

export const RANGE_MAX_BYTES = 8 * 1024 * 1024;
const WRITE_CHUNK = 64 * 1024;

function parseRange(header, size) {
  if (header == null) return { kind: "full" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null) return { kind: "invalid" };
  const [, startRaw, endRaw] = m;
  if (startRaw === "" && endRaw === "") return { kind: "invalid" };
  if (size === 0) return { kind: "unsatisfiable" };
  let start;
  let wantedEnd;
  if (startRaw === "") {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return { kind: "unsatisfiable" };
    start = Math.max(0, size - suffix);
    wantedEnd = size - 1;
  } else {
    start = Number(startRaw);
    if (!Number.isFinite(start) || start >= size) return { kind: "unsatisfiable" };
    if (endRaw === "") wantedEnd = size - 1;
    else {
      const end = Number(endRaw);
      if (!Number.isFinite(end) || end < start) return { kind: "invalid" };
      wantedEnd = Math.min(end, size - 1);
    }
  }
  return { kind: "partial", start, end: Math.min(wantedEnd, start + RANGE_MAX_BYTES - 1) };
}

export async function startRangeServer(filePath, { maxLog = 4000 } = {}) {
  const size = statSync(filePath).size;
  const fd = openSync(filePath, "r");
  let counters = freshCounters();

  function freshCounters() {
    return {
      requests: 0,
      fullRequests: 0,
      rangeRequests: 0,
      responseBytes: 0,
      maxResponseBytes: 0,
      abortedRequests: 0,
      unsatisfiable: 0,
      invalid: 0,
      log: [],
    };
  }

  const readSlice = (start, length) => {
    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, buf, got, length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    return got === length ? buf : buf.subarray(0, got);
  };

  const sendBody = (req, res, body, record, c) =>
    new Promise((resolve) => {
      let off = 0;
      let settled = false;
      const settle = (aborted) => {
        if (settled) return;
        settled = true;
        record.bytesWritten = off;
        record.aborted = aborted;
        c.responseBytes += off;
        if (off > c.maxResponseBytes) c.maxResponseBytes = off;
        if (aborted) c.abortedRequests += 1;
        resolve();
      };
      res.on("close", () => settle(record.completed !== true));
      res.on("error", () => settle(true));
      if (req.method === "HEAD") {
        record.completed = true;
        res.end();
        settle(false);
        return;
      }
      const pump = () => {
        if (settled) return;
        while (off < body.length) {
          const next = Math.min(off + WRITE_CHUNK, body.length);
          const ok = res.write(body.subarray(off, next));
          off = next;
          if (!ok) {
            res.once("drain", pump);
            return;
          }
        }
        record.completed = true;
        res.end();
        settle(false);
      };
      pump();
    });

  const server = createServer(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const c = counters; // 本次请求只记到它开始时那一刻的计数器（reset() 后旧请求不能污染新统计）
    c.requests += 1;
    const parsed = parseRange(req.headers.range, size);
    if (parsed.kind === "invalid" || parsed.kind === "unsatisfiable") {
      if (parsed.kind === "invalid") c.invalid += 1;
      else c.unsatisfiable += 1;
      res.writeHead(416, { "Content-Range": "bytes */" + size, "Accept-Ranges": "bytes" }).end();
      return;
    }
    const record = {
      status: parsed.kind === "full" ? 200 : 206,
      range: req.headers.range ?? null,
      start: parsed.kind === "full" ? 0 : parsed.start,
      end: parsed.kind === "full" ? size - 1 : parsed.end,
      bytesWritten: 0,
      aborted: false,
      completed: false,
    };
    if (c.log.length < maxLog) c.log.push(record);
    if (parsed.kind === "full") {
      c.fullRequests += 1;
      const body = readSlice(0, size);
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": String(size),
        "Accept-Ranges": "bytes",
      });
      await sendBody(req, res, body, record, c);
      return;
    }
    c.rangeRequests += 1;
    const body = readSlice(parsed.start, parsed.end - parsed.start + 1);
    res.writeHead(206, {
      "Content-Type": "application/pdf",
      "Content-Range": "bytes " + parsed.start + "-" + parsed.end + "/" + size,
      "Content-Length": String(body.length),
      "Accept-Ranges": "bytes",
    });
    await sendBody(req, res, body, record, c);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: "http://127.0.0.1:" + port + "/sample.pdf",
    size,
    snapshot() {
      let bytes200 = 0;
      let bytes206 = 0;
      for (const r of counters.log) {
        if (r.status === 200) bytes200 += r.bytesWritten;
        else bytes206 += r.bytesWritten;
      }
      return {
        requests: counters.requests,
        fullRequests: counters.fullRequests,
        rangeRequests: counters.rangeRequests,
        responseBytes: counters.responseBytes,
        maxResponseBytes: counters.maxResponseBytes,
        abortedRequests: counters.abortedRequests,
        unsatisfiable: counters.unsatisfiable,
        bytes200,
        bytes206,
        log: counters.log.map((r) => ({ ...r })),
      };
    },
    reset() {
      counters = freshCounters();
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    },
  };
}
