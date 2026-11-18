// M01 冒烟壳：验证 invoke 通道与事件通道可用。
// 视觉数值一律不落值（M13 才拥有主题令牌），因此这里只输出结构化的纯文本状态。
import { useEffect, useState, type ReactElement } from "react";
import { call, IpcError, subscribe } from "./core/ipc";
import { CMD } from "./contracts/cmd";
import { EVT } from "./contracts/evt";
import type { AppInfoDto, PingDto } from "./contracts/types";

type Status =
  | { kind: "probing" }
  | { kind: "ok"; ping: PingDto; info: AppInfoDto }
  | { kind: "error"; code: string; message: string; detail: string };

interface ProbeResult {
  label: string;
  request: string;
  outcome: string;
}

// V-06 探针：确认 Windows 上 pdf:// 的真实 URL 形态与 Range 响应状态。
// 两种形态都试，因为 Windows/Android 上自定义 scheme 会被映射到 http://<scheme>.localhost。
// 结论（2026-11-18 实测）：Windows 上必须用 http://pdf.localhost 形态；
// pdf:// 直连会 TypeError: Failed to fetch。两条都保留，作为契约 R21 的回归证据。
const PROBE_TARGETS: { label: string; url: string; range?: string }[] = [
  { label: "平台映射形态 无 Range", url: "http://pdf.localhost/doc/1" },
  { label: "平台映射形态 Range 0-9", url: "http://pdf.localhost/doc/1", range: "bytes=0-9" },
  { label: "pdf:// 直连 无 Range（预期失败）", url: "pdf://doc/1" },
  { label: "pdf:// 直连 Range 0-9（预期失败）", url: "pdf://doc/1", range: "bytes=0-9" },
];

async function runProbe(target: (typeof PROBE_TARGETS)[number]): Promise<ProbeResult> {
  const headers: Record<string, string> = target.range ? { Range: target.range } : {};
  try {
    const res = await fetch(target.url, { headers });
    const body = new Uint8Array(await res.arrayBuffer());
    const parts = [
      `status=${res.status}`,
      `content-range=${res.headers.get("content-range") ?? "(none)"}`,
      `accept-ranges=${res.headers.get("accept-ranges") ?? "(none)"}`,
      `bytes=${body.length}`,
    ];
    return { label: target.label, request: `${target.url}${target.range ? ` @ ${target.range}` : ""}`, outcome: parts.join(" ") };
  } catch (err) {
    return { label: target.label, request: target.url, outcome: `fetch 失败: ${String(err)}` };
  }
}


interface LibProbe {
  step: string;
  detail: string;
}

// M04 探针：加库根 → 扫描 → 列表，验证扫描链路真的通了（M14 接入后随冒烟壳移除）。
async function runLibraryProbe(): Promise<LibProbe[]> {
  const out: LibProbe[] = [];
  try {
    const before = await call(CMD.LIBRARY_ROOT_LIST, {});
    out.push({ step: "1 初始库根数", detail: String(before.length) });

    const root = await call(CMD.LIBRARY_ROOT_ADD, { path: "C:\\Users\\Lenovo\\Desktop\\legere\\.probe-lib" });
    out.push({ step: "2 加库根", detail: `id=${root.id} name=${root.displayName}` });

    const started = await call(CMD.LIBRARY_SCAN_START, { rootId: root.id });
    out.push({ step: "3 启动扫描", detail: `started=${started.started}` });

    await new Promise((r) => setTimeout(r, 2500));

    const page = await call(CMD.DOCUMENT_LIST, {
      query: { sort: "recent", order: "desc", offset: 0, limit: 50 },
    });
    out.push({ step: "4 扫描后文档数", detail: `total=${page.total}` });
    out.push({ step: "5 前三个文件名", detail: page.items.slice(0, 3).map((d) => d.fileName).join(", ") || "(空)" });

    const first = page.items[0];
    if (first !== undefined) {
      const src = await call(CMD.DOCUMENT_URL, { id: first.id });
      out.push({ step: "6 document_url", detail: src.url });
      const detail = await call(CMD.DOCUMENT_GET, { id: first.id });
      out.push({ step: "7 详情", detail: `textState=${detail.textState} pageCount=${String(detail.pageCount)}` });
    }
  } catch (err) {
    const msg = err instanceof IpcError ? `${err.code}: ${err.detail ?? err.message}` : String(err);
    out.push({ step: "失败", detail: msg });
  }
  return out;
}


// M09–M11 探针：扫描 → 入队索引 → 搜索（M14 接入后随冒烟壳移除）。
async function runSearchProbe(): Promise<LibProbe[]> {
  const out: LibProbe[] = [];
  try {
    const page = await call(CMD.DOCUMENT_LIST, {
      query: { sort: "recent", order: "desc", offset: 0, limit: 50 },
    });
    out.push({ step: "1 待索引文档", detail: `total=${page.total}` });

    for (const doc of page.items) {
      await call(CMD.INDEX_ENQUEUE, { documentId: doc.id, priority: 0 });
    }
    out.push({ step: "2 已入队", detail: `${page.items.length} 个任务（priority=0 前台优先）` });

    await new Promise((r) => setTimeout(r, 4000));

    const status = await call(CMD.INDEX_STATUS, {});
    out.push({ step: "3 索引状态", detail: `indexed=${status.documentsIndexed} failed=${status.documentsFailed} noText=${status.documentsNoText} queued=${status.queued}` });

    const detail = page.items[0] !== undefined ? await call(CMD.DOCUMENT_GET, { id: page.items[0].id }) : null;
    if (detail !== null) {
      out.push({ step: "4 文档状态", detail: `textState=${detail.textState} pageCount=${String(detail.pageCount)}` });
    }

    const found = await call(CMD.SEARCH_GLOBAL, {
      params: { query: "Legere", mode: "phrase", hitsPerDocument: 3, documentOffset: 0, documentLimit: 10 },
    });
    out.push({ step: "5 搜索 Legere", detail: `documents=${found.totalDocuments} tookMs=${found.tookMs}` });
    const firstHit = found.items[0]?.hits[0];
    out.push({ step: "6 首个命中", detail: firstHit ? `p${firstHit.pageNo} 「${firstHit.snippet}」 ranges=${JSON.stringify(firstHit.ranges)}` : "(无)" });

    const counts = await call(CMD.SEARCH_GLOBAL_COUNT, {
      params: { query: "Legere", mode: "phrase", hitsPerDocument: 3, documentOffset: 0, documentLimit: 10 },
    });
    out.push({ step: "7 计数", detail: `documents=${counts.documents} pages=${counts.pages}` });

    const miss = await call(CMD.SEARCH_GLOBAL, {
      params: { query: "不存在的词组合", mode: "phrase", hitsPerDocument: 3, documentOffset: 0, documentLimit: 10 },
    });
    out.push({ step: "8 无命中", detail: `documents=${miss.totalDocuments}` });
  } catch (err) {
    const msg = err instanceof IpcError ? `${err.code}: ${err.detail ?? err.message}` : String(err);
    out.push({ step: "失败", detail: msg });
  }
  return out;
}


// M05 探针：用真实 pdfjs 打开 pdf:// 文档，验证 V-01 门禁结论（TextLayer/TextItem/Outline）。
async function runEngineProbe(): Promise<LibProbe[]> {
  const out: LibProbe[] = [];
  try {
    const { pdfEngine } = await import("./pdf-engine");
    const handle = await pdfEngine.openDocument({ url: "http://pdf.localhost/doc/1?v=1", docId: 1 });
    out.push({ step: "1 打开文档", detail: `pageCount=${handle.pageCount}` });

    const page = await handle.getPage(1);
    out.push({ step: "2 页面几何", detail: `${Math.round(page.geometry.widthPt)}×${Math.round(page.geometry.heightPt)}pt rotation=${page.geometry.rotation}` });

    const text = await page.getTextContent();
    out.push({ step: "3 文本内容", detail: `items=${text.items.length} chars=${text.text.length} 首段=「${text.text.trim().slice(0, 20)}」` });
    out.push({ step: "4 itemStarts 可逆", detail: `${text.itemStarts.every((s, i) => text.text.slice(s, s + (text.items[i]?.str.length ?? 0)) === text.items[i]?.str)}` });

    const meta = await handle.getMetadata();
    out.push({ step: "5 元数据", detail: `title=${meta.title ?? "(空)"}` });

    const outline = await handle.getOutline();
    out.push({ step: "6 目录", detail: `nodes=${outline.length}` });

    const task = page.render({ scale: 0.4 });
    const canvas = await task.promise;
    out.push({ step: "7 渲染位图", detail: `${canvas.width}×${canvas.height}px` });

    await handle.dispose();
    out.push({ step: "8 释放", detail: "dispose 完成" });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    out.push({ step: "失败", detail: `${e.code ?? "no-code"}: ${e.message ?? String(err)}` });
  }
  return out;
}

export default function App(): ReactElement {
  const [status, setStatus] = useState<Status>({ kind: "probing" });
  const [readyEvent, setReadyEvent] = useState<string | null>(null);
  const [probes, setProbes] = useState<ProbeResult[]>([]);
  const [libProbes, setLibProbes] = useState<LibProbe[]>([]);
  const [searchProbes, setSearchProbes] = useState<LibProbe[]>([]);
  const [engineProbes, setEngineProbes] = useState<LibProbe[]>([]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const ping = await call(CMD.PING, {});
        const info = await call(CMD.APP_INFO, {});
        if (alive) setStatus({ kind: "ok", ping, info });
      } catch (raw) {
        const err = raw instanceof IpcError ? raw : null;
        if (alive) {
          setStatus({
            kind: "error",
            code: err?.code ?? "E_INTERNAL",
            message: err?.message ?? "IPC 不可用（是否在非 Tauri 环境打开了页面？）",
            detail: err?.detail ?? String(raw),
          });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const lib = await runLibraryProbe();
      if (alive) setLibProbes(lib);
      const searchLine = await runSearchProbe();
      if (alive) setSearchProbes(searchLine);
      const engineLine = await runEngineProbe();
      if (alive) setEngineProbes(engineLine);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const results: ProbeResult[] = [];
      for (const target of PROBE_TARGETS) {
        results.push(await runProbe(target));
      }
      if (alive) setProbes(results);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let dispose: (() => void) | null = null;
    void subscribe(EVT.APP_READY, (payload) => setReadyEvent(payload.version)).then((fn) => {
      dispose = fn;
    });
    return () => dispose?.();
  }, []);

  return (
    <main>
      <h1>Legere</h1>
          <h2>引擎探针（M05）</h2>
          <ul>
            {engineProbes.map((p) => (
              <li key={p.step}>
                <strong>{p.step}</strong>：{p.detail}
              </li>
            ))}
          </ul>

          <h2>检索链探针（M09–M11）</h2>
          <ul>
            {searchProbes.map((p) => (
              <li key={p.step}>
                <strong>{p.step}</strong>：{p.detail}
              </li>
            ))}
          </ul>

          <h2>文献库探针（M04）</h2>
          <ul>
            {libProbes.map((p) => (
              <li key={p.step}>
                <strong>{p.step}</strong>：{p.detail}
              </li>
            ))}
          </ul>

      {status.kind === "probing" && <p>正在检测后端通道…</p>}
      {status.kind === "error" && (
        <>
          <p>后端通道不可用</p>
          <p>`code`: {status.code}</p>
          <p>`message`: {status.message}</p>
          <p>`detail`: {status.detail}</p>
        </>
      )}
      {status.kind === "ok" && (
        <>
          <p>后端通道正常</p>
          <dl>
            <dt>version</dt>
            <dd>{status.info.version}</dd>
            <dt>dataDir</dt>
            <dd>{status.info.dataDir}</dd>
            <dt>dbPath</dt>
            <dd>{status.info.dbPath}</dd>
            <dt>ftsEnabled</dt>
            <dd>{String(status.info.ftsEnabled)}</dd>
            <dt>contentlessDelete</dt>
            <dd>{String(status.info.contentlessDelete)}</dd>
            <dt>textEngine</dt>
            <dd>{status.info.textEngine}</dd>
          </dl>
          <p>ping.ok = {String(status.ping.ok)}</p>
          <p>app://ready = {readyEvent ?? "(未收到)"}</p>
          <h2>pdf:// 探针（V-06）</h2>
          <ul>
            {probes.map((p) => (
              <li key={p.label}>
                <strong>{p.label}</strong>：{p.outcome}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}