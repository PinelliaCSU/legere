#!/usr/bin/env node
// 生成 M01 用的最小合法 PDF（供 pdf:// 协议壳冒烟）。xref 偏移按实际字节计算并自校验。
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "src-tauri", "assets", "sample.pdf");

const stream = "BT /F1 24 Tf 72 760 Td (Legere sample page) Tj ET";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];

let pdf = "%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n";
const offsets = [];
objects.forEach((body, index) => {
  offsets.push(pdf.length);
  pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
});

const xrefStart = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n`;
pdf += "0000000000 65535 f \n";
for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, pdf, "binary");

// 自校验：每个 xref 偏移处必须是 "N 0 obj"。
const check = readFileSync(target, "latin1");
offsets.forEach((off, i) => {
  const expect = `${i + 1} 0 obj`;
  const actual = check.slice(off, off + expect.length);
  if (actual !== expect) throw new Error(`xref 偏移错误: obj ${i + 1} 期望 "${expect}" 实得 "${actual}"`);
});
console.log(`sample.pdf 已生成: ${target} (${Buffer.byteLength(pdf)} bytes, ${objects.length} objects, xref @ ${xrefStart})`);
