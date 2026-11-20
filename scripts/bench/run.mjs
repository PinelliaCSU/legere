// legere 测量脚本入口：node scripts/bench/run.mjs
// A 文内搜索文本提取成本（旧/新路径等价模型） / B rangeChunkSize / C disableAutoFetch
// stdout 只打印两张 markdown 表格 + 一行结论；完整明细写 .tmp/bench/results.json。
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { writePdf } from "./gen-pdf.mjs";
import { ByteBudgetLRU, pageCostBytes } from "./lru.mjs";
import { startRangeServer, RANGE_MAX_BYTES } from "./range-server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT_DIR = join(ROOT, ".tmp", "bench");
const PDF_PATH = join(OUT_DIR, "pages-300-text.pdf");
const STAMP_PATH = join(OUT_DIR, "gen-stamp.json");

const GENERATOR_VERSION = "img176-v2";
const PAGES = 300;
const CACHE_BUDGET_BYTES = 64 * 1024 * 1024;
const A_ROUNDS = 5;
const C_WINDOW_MS = 3000;
const B_SETTLE_MS = 500;
const B_REPEATS = 3;
const SEARCH_QUERY = "range request";
const RANGE_MODE = { disableStream: true, disableAutoFetch: true };

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith("--" + name + "="));
  return hit === undefined ? dflt : hit.slice(name.length + 3);
};
const ONLY = String(flag("only", "a,b,c")).split(",").map((s) => s.trim());
const A_ROUNDS_ACTUAL = Number(flag("rounds", A_ROUNDS));

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

let docSeq = 0;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const round1 = (x) => Math.round(x * 10) / 10;
const fmtBytes = (n) => n.toLocaleString("en-US");

function ensurePdf() {
  mkdirSync(OUT_DIR, { recursive: true });
  let stamp = null;
  if (existsSync(STAMP_PATH)) {
    try {
      stamp = JSON.parse(readFileSync(STAMP_PATH, "utf8"));
    } catch {
      stamp = null;
    }
  }
  const fresh =
    existsSync(PDF_PATH) && stamp !== null && stamp.version === GENERATOR_VERSION && stamp.pages === PAGES;
  if (fresh) return { generatedNow: false, stats: stamp.stats };
  const stats = writePdf(PDF_PATH, { pages: PAGES });
  writeFileSync(STAMP_PATH, JSON.stringify({ version: GENERATOR_VERSION, pages: PAGES, stats }, null, 2));
  return { generatedNow: true, stats };
}

function newTask(server, extra) {
  docSeq += 1;
  return pdfjs.getDocument({ url: server.url, verbosity: 0, cacheKey: "legere-bench-" + docSeq, ...extra });
}

// 与 ReaderView.tsx:428-433 等价：逐页 getPage + getTextContent，跨次搜索无复用。
async function oldSearchExtract(doc) {
  const t0 = performance.now();
  let items = 0;
  let chars = 0;
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    items += tc.items.length;
    for (const it of tc.items) chars += it.str.length;
  }
  return { ms: performance.now() - t0, items, chars };
}

async function cachedFirstPass(doc, lru) {
  const t0 = performance.now();
  let items = 0;
  let chars = 0;
  let costBytes = 0;
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const cost = pageCostBytes(tc);
    costBytes += cost;
    lru.set(p, tc, cost);
    items += tc.items.length;
    for (const it of tc.items) chars += it.str.length;
  }
  return { ms: performance.now() - t0, items, chars, costBytes };
}

async function cachedSecondPass(doc, lru) {
  const t0 = performance.now();
  let hits = 0;
  let misses = 0;
  let chars = 0;
  for (let p = 1; p <= doc.numPages; p += 1) {
    let tc = lru.get(p);
    if (tc === undefined) {
      misses += 1;
      const page = await doc.getPage(p);
      tc = await page.getTextContent();
      lru.set(p, tc, pageCostBytes(tc));
    } else {
      hits += 1;
    }
    for (const it of tc.items) chars += it.str.length;
  }
  return { ms: performance.now() - t0, hits, misses, chars };
}

function matchCost(texts, query) {
  const t0 = performance.now();
  let pagesMatched = 0;
  for (const tc of texts) {
    const text = tc.items.map((i) => i.str).join("\n").toLowerCase();
    if (text.includes(query)) pagesMatched += 1;
  }
  return { ms: performance.now() - t0, pagesMatched };
}

async function runA(server, meta) {
  const rounds = [];
  let matchDetail = null;
  for (let r = 1; r <= A_ROUNDS_ACTUAL; r += 1) {
    // 旧路径：同一个 doc 上「搜索两次」，各自全量重提取（模型即 ReaderView 的循环本身）。
    server.reset();
    const oldTask = newTask(server);
    const oldDoc = await oldTask.promise;
    const oldFirst = await oldSearchExtract(oldDoc);
    const oldSecond = await oldSearchExtract(oldDoc);
    await oldTask.destroy();

    // 新路径：空缓存 + 全新 doc（等价于「刚打开文档后的第一次搜索」）。
    server.reset();
    const newTaskObj = newTask(server);
    const newDoc = await newTaskObj.promise;
    const lru = new ByteBudgetLRU(CACHE_BUDGET_BYTES, "pages");
    const newFirst = await cachedFirstPass(newDoc, lru);
    const newSecond = await cachedSecondPass(newDoc, lru);
    const lruStats = lru.stats();
    await newTaskObj.destroy();

    if (matchDetail === null) {
      server.reset();
      const t = newTask(server);
      const d = await t.promise;
      const texts = [];
      for (let p = 1; p <= d.numPages; p += 1) texts.push(await (await d.getPage(p)).getTextContent());
      matchDetail = matchCost(texts, SEARCH_QUERY);
      await t.destroy();
    }

    rounds.push({
      round: r,
      oldFirstMs: round1(oldFirst.ms),
      oldSecondMs: round1(oldSecond.ms),
      newFirstMs: round1(newFirst.ms),
      newSecondMs: round1(newSecond.ms),
      charsPerPass: oldFirst.chars,
      itemsPerPass: oldFirst.items,
      lru: lruStats,
      newSecond: { hits: newSecond.hits, misses: newSecond.misses },
      newFirstCostBytes: newFirst.costBytes,
    });
  }

  const med = {
    oldFirstMs: median(rounds.map((x) => x.oldFirstMs)),
    oldSecondMs: median(rounds.map((x) => x.oldSecondMs)),
    newFirstMs: median(rounds.map((x) => x.newFirstMs)),
    newSecondMs: median(rounds.map((x) => x.newSecondMs)),
  };
  const minMs = {
    oldFirstMs: Math.min(...rounds.map((x) => x.oldFirstMs)),
    oldSecondMs: Math.min(...rounds.map((x) => x.oldSecondMs)),
    newFirstMs: Math.min(...rounds.map((x) => x.newFirstMs)),
    newSecondMs: Math.min(...rounds.map((x) => x.newSecondMs)),
  };
  const avgPageCost = rounds[0].newFirstCostBytes / PAGES;
  return {
    ...med,
    minMs,
    rounds,
    roundsCount: rounds.length,
    query: SEARCH_QUERY,
    matchDetail,
    avgPageCostBytes: Math.round(avgPageCost),
    budgetCapacityPages: Math.floor(CACHE_BUDGET_BYTES / avgPageCost),
    speeds: {
      oldSecond_over_newSecond: med.newSecondMs > 0 ? round1(med.oldSecondMs / med.newSecondMs) : null,
      oldSecond_over_newFirst: med.newFirstMs > 0 ? round1(med.oldSecondMs / med.newFirstMs) : null,
    },
    model: {
      note: "等价模型测量：脚本内显式建模旧/新两条路径，不 import src/ 下的实现。",
      oldPath:
        "for p in 1..=n { await doc.getPage(p); await page.getTextContent(); } —— 每次搜索全量重来，无跨次复用（同 ReaderView.tsx:428-433）。",
      newPath:
        "第一轮同一循环 + 写入字节预算 LRU；第二轮只查 LRU，命中则不调用 getTextContent。容量 = 4 MiB * 16 / 每页近似成本，逐出最久未用。",
      pageCostFormula: "chars*2 (UTF-16) + items*64 + 256",
      budgetBytes: CACHE_BUDGET_BYTES,
      assumptions: [
        "LRU 键为页码，值是该页 getTextContent() 返回的对象（与 src 的 TextContentHandle 同粒度）。",
        "新·二轮耗时不含字符串匹配；匹配成本单独测量（matchDetail.ms）。",
        "每轮旧/新路径各开新 doc，文档打开耗时不计入 A 的任一侧。",
        "doc 打开时第一次 HTTP 响应是整文件 GET（pdf.js 不发送 Range），因此流式传输与提取并行，两条路径同等受益。",
      ],
    },
  };
}

// 到「numPages + 第 1 页文本」就绪的时间。
async function firstScreen(server, extra, t0) {
  const task = newTask(server, extra);
  const doc = await task.promise;
  const numPages = doc.numPages;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  const ms = performance.now() - t0;
  return { task, doc, numPages, firstChars: tc.items.reduce((a, i) => a + i.str.length, 0), ms };
}

async function bOnce(server, cfg) {
  server.reset();
  const t0 = performance.now();
  const r = await firstScreen(server, { rangeChunkSize: cfg.rangeChunkSize, ...cfg.opts }, t0);
  const snapAtFirst = server.snapshot();
  await sleep(B_SETTLE_MS); // 稳定窗：首屏之后 pdf.js 仍在收尾取块，取稳定值才可重复
  const snap = server.snapshot();
  await r.task.destroy();
  await sleep(150); // 让上一行的在途请求彻底收敛，避免干扰下一行
  return {
    firstScreenMs: round1(r.ms),
    requests: snap.requests,
    bytes: snap.responseBytes,
    maxResponseBytes: snap.maxResponseBytes,
    abortedRequests: snap.abortedRequests,
    bytesAtFirstScreen: snapAtFirst.responseBytes,
    requestsAtFirstScreen: snapAtFirst.requests,
    numPages: r.numPages,
    firstChars: r.firstChars,
    bytes200: snap.bytes200,
    bytes206: snap.bytes206,
    requestLog: snap.log.map((x) => ({ s: x.status, range: x.range, b: x.bytesWritten, ab: x.aborted })),
    consistent: snap.responseBytes === snap.bytes200 + snap.bytes206,
  };
}

async function bMeasure(server, cfg, meta) {
  const runs = [];
  for (let i = 0; i < B_REPEATS; i += 1) runs.push(await bOnce(server, cfg));
  return {
    label: cfg.label,
    mode: cfg.mode,
    rangeChunkSize: cfg.rangeChunkSize,
    repeats: B_REPEATS,
    firstScreenMs: median(runs.map((x) => x.firstScreenMs)),
    requests: median(runs.map((x) => x.requests)),
    bytes: median(runs.map((x) => x.bytes)),
    runs: runs.map((x) => ({ firstScreenMs: x.firstScreenMs, requests: x.requests, bytes: x.bytes })),
    maxResponseBytes: Math.max(...runs.map((x) => x.maxResponseBytes)),
    abortedRequests: runs[runs.length - 1].abortedRequests,
    fileBytes: meta.fileBytes,
    settleMs: B_SETTLE_MS,
    bytes200: runs[runs.length - 1].bytes200,
    bytes206: runs[runs.length - 1].bytes206,
    requestLog: runs[runs.length - 1].requestLog,
    consistent: runs.every((x) => x.consistent),
    numPages: runs[0].numPages,
  };
}

async function runB(server, meta) {
  const configs = [
    { label: "rangeChunkSize=64 KiB（默认值）", rangeChunkSize: 65536, opts: RANGE_MODE, mode: "range" },
    { label: "rangeChunkSize=4 MiB", rangeChunkSize: 4 * 1024 * 1024, opts: RANGE_MODE, mode: "range" },
  ];
  // 主表：只改 rangeChunkSize，其余保持默认（= 应用当前的加载方式）。
  // 附加：强制 range 读取路径（disableStream+disableAutoFetch），用于隔离分块行为。
  const rows = [];
  const rangeModeRows = [];
  for (const cfg of configs) {
    rows.push(await bMeasure(server, { ...cfg, opts: {}, mode: "default" }, meta));
    rangeModeRows.push(await bMeasure(server, cfg, meta));
  }
  return {
    rows,
    rangeModeRows,
    repeats: B_REPEATS,
    note:
      "rangeChunkSize 只在 pdf.js 的 range 读取路径上生效：默认 streaming 路径的首次请求是无 Range 的整文件 GET（pdf.mjs:13481-13502），" +
      "且 range 支持还要求 contentLength > 2*rangeChunkSize（pdf.mjs:13391）与 disableStream=true（pdf.mjs:13498）。" +
      "因此主表两行固定 disableStream=true + disableAutoFetch=true，仅改变 rangeChunkSize；默认路径的两行放在 defaultModeRows 作对照。",
  };
}

async function runC(server, meta) {
  const configs = [
    { label: "disableAutoFetch=false（当前默认）", opts: {} },
    { label: "disableAutoFetch=true + disableStream=true", opts: RANGE_MODE },
  ];
  const rows = [];
  for (const cfg of configs) {
    server.reset();
    const t0 = performance.now();
    const r = await firstScreen(server, cfg.opts, t0);
    const rest = C_WINDOW_MS - (performance.now() - t0);
    if (rest > 0) await sleep(rest);
    const snap = server.snapshot();
    const windowMs = performance.now() - t0;
    await r.task.destroy();
    await sleep(150);
    rows.push({
      label: cfg.label,
      opts: cfg.opts,
      numPages: r.numPages,
      firstChars: r.firstChars,
      firstScreenMs: round1(r.ms),
      requests: snap.requests,
      bytes: snap.responseBytes,
      maxResponseBytes: snap.maxResponseBytes,
      abortedRequests: snap.abortedRequests,
      bytes200: snap.bytes200,
      bytes206: snap.bytes206,
      windowMs: round1(windowMs),
      fileBytes: meta.fileBytes,
      requestLog: snap.log.map((x) => ({ s: x.status, range: x.range, b: x.bytesWritten, ab: x.aborted })),
      consistent: snap.responseBytes === snap.bytes200 + snap.bytes206,
    });
  }
  return { rows, windowMs: C_WINDOW_MS, note: "统计窗口自 getDocument 调用起算，共 3 秒；请求数/字节为该窗口内累计。" };
}

function tableA(a) {
  const x = (v) => (a.newSecondMs > 0 ? round1(v / a.newSecondMs).toFixed(1) + "×" : "-");
  return [
    "| 路径 | 说明 | 中位耗时 (ms) | 相对 新·二轮 |",
    "| --- | --- | ---: | ---: |",
    "| 旧·首轮 | 300 页全量 getPage+getTextContent（第 1 次搜索） | " + fmtBytes(a.oldFirstMs) + " | " + x(a.oldFirstMs) + " |",
    "| 旧·二轮 | 同上（第 2 次搜索，仍全量重提取） | " + fmtBytes(a.oldSecondMs) + " | " + x(a.oldSecondMs) + " |",
    "| 新·首轮 | 全量提取 + 写入 64 MiB 字节预算 LRU | " + fmtBytes(a.newFirstMs) + " | " + x(a.newFirstMs) + " |",
    "| 新·二轮 | 全部命中缓存，不调用 getTextContent | " + fmtBytes(a.newSecondMs) + " | 1.0× |",
  ].join("\n");
}

function tableBC(b, c) {
  const total = b.rows[0].fileBytes;
  const pct = (n) => (total > 0 ? round1((n / total) * 100).toFixed(1) + "%" : "-");
  const lines = [
    "| 组 | 配置 | 请求数 | 总字节（样本 " + fmtBytes(total) + " B） | 首屏耗时 (ms) |",
    "| --- | --- | ---: | ---: | ---: |",
  ];
  // B 行：仅改 rangeChunkSize，其余默认；请求数/字节为首屏 + 500ms 稳定窗内累计。
  // C 行：请求数/字节为 getDocument 起 3 秒窗口内累计。
  for (const row of b.rows) {
    lines.push(
      "| B | " + row.label + " | " + row.requests + " | " + fmtBytes(row.bytes) + "（" + pct(row.bytes) + "） | " + fmtBytes(row.firstScreenMs) + " |",
    );
  }
  for (const row of c.rows) {
    lines.push(
      "| C | " + row.label + " | " + row.requests + " | " + fmtBytes(row.bytes) + "（" + pct(row.bytes) + "） | " + fmtBytes(row.firstScreenMs) + " |",
    );
  }
  return lines.join("\n");
}

async function main() {
  const started = performance.now();
  const gen = ensurePdf();
  const meta = {
    pdfPath: PDF_PATH,
    fileBytes: statSync(PDF_PATH).size,
    pages: PAGES,
    generatedNow: gen.generatedNow,
    generatorStats: gen.stats,
    node: process.version,
    pdfjsVersion: pdfjs.version,
    rangeMaxBytes: RANGE_MAX_BYTES,
    platform: process.platform + "/" + process.arch,
    cpuCount: cpus().length,
    cacheBudgetBytes: CACHE_BUDGET_BYTES,
    rangeMode: RANGE_MODE,
    aRounds: A_ROUNDS_ACTUAL,
    cWindowMs: C_WINDOW_MS,
  };

  const server = await startRangeServer(PDF_PATH);
  const results = { meta, a: null, b: null, c: null };
  try {
    if (ONLY.includes("a")) results.a = await runA(server, meta);
    if (ONLY.includes("b")) results.b = await runB(server, meta);
    if (ONLY.includes("c")) results.c = await runC(server, meta);
  } finally {
    await server.close();
  }
  results.meta.totalWallMs = Math.round(performance.now() - started);

  writeFileSync(join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2));

  if (results.a !== null) console.log(tableA(results.a));
  if (results.a !== null && results.b !== null && results.c !== null) console.log("");
  if (results.b !== null && results.c !== null) console.log(tableBC(results.b, results.c));

  const parts = [];
  if (results.a !== null) parts.push("A 旧·二轮/新·二轮=" + results.a.speeds.oldSecond_over_newSecond + "×");
  if (results.b !== null) {
    const [s, l] = results.b.rows;
    parts.push("B " + s.requests + "→" + l.requests + " 请求 / " + fmtBytes(s.bytes) + "→" + fmtBytes(l.bytes) + " B");
  }
  if (results.c !== null) {
    const [f, t] = results.c.rows;
    parts.push("C 3s 内 " + f.requests + "→" + t.requests + " 请求 / " + fmtBytes(f.bytes) + "→" + fmtBytes(t.bytes) + " B");
  }
  console.log("");
  console.log("结论：" + parts.join("；"));

  const rows = [...(results.b?.rows ?? []), ...(results.b?.rangeModeRows ?? []), ...(results.c?.rows ?? [])];
  const bad = rows.filter((r) => r.consistent === false);
  if (bad.length > 0) {
    console.error("统计自检失败（bytes != bytes200 + bytes206）：" + bad.map((r) => r.label).join(", "));
    process.exitCode = 1;
  }
}

await main();
