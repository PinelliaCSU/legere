#!/usr/bin/env node
// 生成 V-06 探针页（dist/index.html）。刻意不使用 React/Vite：
// 本机沙箱禁止 piped stdio 子进程，esbuild/vite 无法运行；探针只需浏览器侧真实请求。
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "index.html");

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>V-06 probe</title></head>
<body>
<pre id="log">probing…</pre>
<script>
const targets = [
  { label: "pdf:// 无 Range", url: "pdf://doc/1" },
  { label: "pdf:// Range 0-9", url: "pdf://doc/1", range: "bytes=0-9" },
  { label: "pdf:// Range 越界", url: "pdf://doc/1", range: "bytes=99999-" },
  { label: "localhost 无 Range", url: "http://pdf.localhost/doc/1" },
  { label: "localhost Range 0-9", url: "http://pdf.localhost/doc/1", range: "bytes=0-9" },
];
const lines = [];
(async () => {
  for (const t of targets) {
    try {
      const res = await fetch(t.url, { headers: t.range ? { Range: t.range } : {} });
      const body = new Uint8Array(await res.arrayBuffer());
      lines.push(t.label + " | " + t.url + (t.range ? " @" + t.range : "") +
        " => status=" + res.status +
        " content-range=" + (res.headers.get("content-range") || "none") +
        " accept-ranges=" + (res.headers.get("accept-ranges") || "none") +
        " bytes=" + body.length);
    } catch (e) {
      lines.push(t.label + " | " + t.url + " => ERROR " + e);
    }
    document.getElementById("log").textContent = lines.join("\\n");
  }
  lines.push("PROBE_DONE");
  document.getElementById("log").textContent = lines.join("\\n");
})();
</script>
</body></html>`;
mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(out, html);
console.log("probe page written: " + out);
