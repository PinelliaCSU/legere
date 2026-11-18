#!/usr/bin/env node
// 把 pdfjs-dist 的运行时资源同步到 public/pdfjs/（Vite publicDir 原样映射到 dist 根）。
//
// 缺任何一个子目录都会让引擎静默降级，表现为「PDF 有页面但整页空白」：
//   cmaps/           -> CJK CID 字体（UniGB/UniJIS/UniKS 等）解码失败
//   standard_fonts/  -> 未内嵌的 Helvetica/Times 等标准字体无字形
//   wasm/            -> JPX(JBIG2)/openjpeg 图片与 ICC 颜色空间失效
//   iccs/            -> ICCBased 颜色空间缺失 CGATS001Compat 微档案
//
// 重放：node scripts/sync-pdfjs-assets.mjs

import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "node_modules", "pdfjs-dist");
const DST = join(ROOT, "public", "pdfjs");
const DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"];

async function measure(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await measure(full);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      files += 1;
      bytes += (await stat(full)).size;
    }
  }
  return { files, bytes };
}

let totalFiles = 0;
let totalBytes = 0;
for (const name of DIRS) {
  const from = join(SRC, name);
  const to = join(DST, name);
  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true, force: true });
  const { files, bytes } = await measure(to);
  totalFiles += files;
  totalBytes += bytes;
  console.log(`public/pdfjs/${name}: ${files} 个文件, ${bytes} 字节`);
}
console.log(`合计 ${totalFiles} 个文件, ${totalBytes} 字节 -> public/pdfjs/`);
