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

export default function App(): ReactElement {
  const [status, setStatus] = useState<Status>({ kind: "probing" });
  const [readyEvent, setReadyEvent] = useState<string | null>(null);

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
        </>
      )}
    </main>
  );
}
