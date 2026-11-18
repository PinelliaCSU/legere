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

export default function App(): ReactElement {
  const [status, setStatus] = useState<Status>({ kind: "probing" });
  const [readyEvent, setReadyEvent] = useState<string | null>(null);
  const [probes, setProbes] = useState<ProbeResult[]>([]);

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
