#!/usr/bin/env node
// 生成最小合法 PDF（供 pdf:// 协议壳与 M05 引擎探针冒烟）。
// 关键：xref 偏移必须按**字节**计算。上一版按 JS 字符串长度算偏移、又用 latin1 写盘，
// 两者不一致导致 pdfjs 判定 E_PDF_CORRUPT（lopdf 宽容所以没暴露）。
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "src-tauri", "assets", "sample.pdf");

const stream = "BT /F1 24 Tf 72 760 Td (Legere sample page) Tj ET";

const chunks = [];
const offsets = [];
let size = 0;
const push = (buf) => {
  chunks.push(buf);
  size += buf.length;
};

push(Buffer.from("%PDF-1.4\n", "latin1"));
// 4 字节二进制标记（>0x7F，必须按原始字节写，不能走字符串编码）
push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

const objects = [
  Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"),
  Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "latin1"),
  Buffer.from(
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "latin1",
  ),
  Buffer.from(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`, "latin1"),
  Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "latin1"),
];

objects.forEach((body, index) => {
  offsets.push(size);
  push(Buffer.from(`${index + 1} 0 obj\n`, "latin1"));
  push(body);
  push(Buffer.from("\nendobj\n", "latin1"));
});

const xrefStart = size;
let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
push(Buffer.from(xref, "latin1"));

const pdf = Buffer.concat(chunks);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, pdf);

// 自校验：每个偏移处必须是 'N 0 obj'，且 startxref 处的字节是 'xref'
offsets.forEach((off, i) => {
  const expect = `${i + 1} 0 obj`;
  const actual = pdf.subarray(off, off + expect.length).toString("latin1");
  if (actual !== expect) throw new Error(`xref 偏移错误: obj ${i + 1} 期望 ${expect} 实得 ${actual}`);
});
if (pdf.subarray(xrefStart, xrefStart + 4).toString("latin1") !== "xref") {
  throw new Error("startxref 未指向 xref 表");
}
console.log(`sample.pdf 已生成: ${target} (${pdf.length} bytes, ${objects.length} objects, xref @ ${xrefStart})`);
const back = readFileSync(target);
if (back.length !== pdf.length) throw new Error("落盘长度与内存不一致");
