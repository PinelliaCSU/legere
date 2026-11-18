#!/usr/bin/env node
// 构建期专用的本地 crates 镜像（仅本机使用，不参与产品运行）。
// 起因：本机进程无法使用 Windows Schannel（curl/cargo 报 SEC_E_NO_CREDENTIALS），
// 而 Node 的 TLS 正常。cargo 走 HTTP 到本地代理，代理用 Node fetch 转发到 crates.io。
//
// 用法：node scripts/cargo-http-mirror.mjs [port]
// 配合：cargo --config 'source.crates-io.replace-with="legere-local"' \
//              --config 'source.legere-local.registry="sparse+http://127.0.0.1:8787/index/"'

import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 8787);
const INDEX = "https://index.crates.io";
const DL = "https://static.crates.io/crates";
const UA = "legere-cargo-mirror";

const stats = { index: 0, dl: 0, miss: 0, err: 0 };

async function pipe(upstreamUrl, res, kind) {
  try {
    const upstream = await fetch(upstreamUrl, { headers: { "user-agent": UA } });
    if (!upstream.ok) {
      stats.miss += 1;
      res.writeHead(upstream.status, { "content-type": "text/plain" });
      res.end(`upstream ${upstream.status}: ${upstreamUrl}`);
      return;
    }
    stats[kind] += 1;
    const len = upstream.headers.get("content-length");
    const headers = { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" };
    if (len) headers["content-length"] = len;
    res.writeHead(200, headers);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  } catch (err) {
    stats.err += 1;
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`mirror error: ${err.message}`);
  }
}

const server = createServer((req, res) => {
  const url = req.url ?? "/";

  if (url === "/stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(stats));
    return;
  }

  if (url.startsWith("/index/")) {
    const rest = url.slice("/index/".length);
    if (rest === "config.json") {
      // dl 指向本代理，cargo 的 .crate 下载也走 Node 的 TLS。
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ dl: `http://127.0.0.1:${PORT}/dl` }));
      return;
    }
    void pipe(`${INDEX}/${rest}`, res, "index");
    return;
  }

  if (url.startsWith("/dl/")) {
    void pipe(`${DL}/${url.slice("/dl/".length)}`, res, "dl");
    return;
  }

  stats.miss += 1;
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`cargo mirror listening on http://127.0.0.1:${PORT}/index/`);
});
