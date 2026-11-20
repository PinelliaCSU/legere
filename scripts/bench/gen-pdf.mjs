// 极简未压缩 PDF 生成器：每页多行中英文文本 + 一张真实的 Flate 图像 XObject。
// 英文用标准 Helvetica；中文用"简单字体 + ToUnicode CMap"——pdf.js 的文本提取以 ToUnicode 为准，
// 因此不需要嵌入真实 CJK 字形文件（本文件只用于测量文本提取成本与 Range 行为，不做像素渲染）。
// 图像的作用只是让样本达到真实 300 页文档的体积量级（pdf.js 的 range 门槛是 size > 2*rangeChunkSize）。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deflateSync } from "node:zlib";

const LATIN_WORDS = (
  "document reader page layout stream buffer content extract range request chunk offset " +
  "anchor render viewport scale zoom cache budget eviction search match index token glyph " +
  "font metric ascent descent baseline leading measure column margin gutter caption figure " +
  "appendix reference footnote paragraph sentence clause section heading numbering " +
  "accurate minimal latency throughput steady reliable window scroll focus keyboard shortcut " +
  "annotation highlight selection toolbar sidebar thumbnail outline bookmark history session " +
  "restore persist handle counter sampling interval histogram percentile baseline compare"
).split(" ");

const CJK_POOL = (
  "阅读器文档页面文本提取缓存预算逐出最近最少使用检索命中率分块请求区间字节" +
  "渲染视口缩放标注高亮选择工具栏侧边缩略图大纲书签历史会话恢复持久化句柄计数器" +
  "采样间隔直方图百分位基线对比稳定可靠窗口滚动焦点键盘快捷键测量模型假设说明"
).split("");

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const escapePdfText = (s) => s.replace(/[\\()]/g, (c) => "\\" + c);

function makePageLines(rand, pageNo) {
  const lines = [];
  for (let i = 0; i < 29; i += 1) {
    const n = 8 + Math.floor(rand() * 6);
    const words = [];
    for (let k = 0; k < n; k += 1) words.push(LATIN_WORDS[Math.floor(rand() * LATIN_WORDS.length)]);
    lines.push({ cjk: false, text: "p" + pageNo + " l" + (i + 1) + " " + words.join(" ") + "." });
  }
  for (let i = 0; i < 3; i += 1) {
    let s = "";
    for (let k = 0; k < 42; k += 1) s += CJK_POOL[Math.floor(rand() * CJK_POOL.length)];
    lines.push({ cjk: true, text: s });
  }
  return lines;
}

export function buildPdf({ pages = 300, seed = 20260421, imageSide = 176 } = {}) {
  const rand = mulberry32(seed);
  const pageLines = [];
  const codeOf = new Map(); // CJK 字符 -> 单字节码
  for (let p = 1; p <= pages; p += 1) {
    const lines = makePageLines(rand, p);
    for (const line of lines) {
      if (!line.cjk) continue;
      for (const ch of line.text) if (!codeOf.has(ch)) codeOf.set(ch, 0x21 + codeOf.size);
    }
    pageLines.push(lines);
  }
  // 单字节码位区间 0x21..0xFF；十六进制字符串写法让内容流保持纯 ASCII。
  const MAX_CODE = 0xff;
  if (codeOf.size > MAX_CODE - 0x21 + 1) throw new Error("CJK 字形码位不足：需要多字体方案");

  const objects = []; // 每项是 Buffer 数组
  const setObj = (num, ...parts) => {
    objects[num] = parts;
  };
  const N_FIXED = 5;
  const pageObjNum = (i) => N_FIXED + (i - 1) * 3 + 1;
  const contentObjNum = (i) => N_FIXED + (i - 1) * 3 + 2;
  const imageObjNum = (i) => N_FIXED + (i - 1) * 3 + 3;
  const totalObjects = N_FIXED + pages * 3;

  const kids = [];
  for (let i = 1; i <= pages; i += 1) kids.push(pageObjNum(i) + " 0 R");
  setObj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  setObj(2, "<< /Type /Pages /Count " + pages + " /Kids [" + kids.join(" ") + "] >>");
  setObj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");

  // ToUnicode：字节码 -> CJK 码点
  const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");
  const entries = [...codeOf.entries()].sort((a, b) => a[1] - b[1]);
  let cmap =
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n" +
    "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n" +
    "1 begincodespacerange\n<00> <FF>\nendcodespacerange\n";
  for (let i = 0; i < entries.length; i += 100) {
    const block = entries.slice(i, i + 100);
    cmap += block.length + " beginbfchar\n";
    for (const [ch, code] of block) cmap += "<" + hex4(code) + "> <" + hex4(ch.codePointAt(0)) + ">\n";
    cmap += "endbfchar\n";
  }
  cmap += "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
  setObj(5, "<< /Length " + Buffer.byteLength(cmap, "ascii") + " >>\nstream\n" + cmap + "endstream");

  const widths = new Array(MAX_CODE - 0x21 + 1).fill(500).join(" ");
  setObj(
    4,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /FirstChar 33 /LastChar " + MAX_CODE + " " +
      "/Widths [" + widths + "] /Encoding /WinAnsiEncoding " +
      "/FontDescriptor << /Type /FontDescriptor /FontName /Courier /Flags 32 " +
      "/FontBBox [-23 -250 715 805] /ItalicAngle 0 /Ascent 805 /Descent -250 /CapHeight 573 /StemV 51 >> " +
      "/ToUnicode 5 0 R >>",
  );

  const codeHex = (s) => {
    let out = "<";
    for (const ch of s) out += codeOf.get(ch).toString(16).toUpperCase().padStart(2, "0");
    return out + ">";
  };

  // 每页一张 8bit 灰度图像：随机像素 + FlateDecode，体积接近原始像素数（真实文档的主要体积来源）。
  const imgRand = mulberry32(seed ^ 0x5bf03635);
  let imageBytes = 0;
  for (let i = 1; i <= pages; i += 1) {
    const raw = Buffer.allocUnsafe(imageSide * imageSide);
    for (let k = 0; k < raw.length; k += 1) raw[k] = (imgRand() * 256) | 0;
    const packed = deflateSync(raw, { level: 1 });
    imageBytes += packed.length;
    setObj(
      imageObjNum(i),
      "<< /Type /XObject /Subtype /Image /Width " + imageSide + " /Height " + imageSide +
        " /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length " + packed.length + " >>\nstream\n",
      packed,
      "\nendstream",
    );
  }

  let textStreamBytes = 0;
  for (let i = 1; i <= pages; i += 1) {
    const lines = pageLines[i - 1];
    let content = "BT\n";
    let y = 800;
    for (const line of lines) {
      if (!line.cjk) {
        content += "/F1 9 Tf\n10.5 TL\n1 0 0 1 41 " + y + " Tm\n(" + escapePdfText(line.text) + ") Tj\n";
      } else {
        content += "/F2 9 Tf\n10.5 TL\n1 0 0 1 41 " + y + " Tm\n" + codeHex(line.text) + " Tj\n";
      }
      y -= 10.5;
    }
    content += "ET\nq\n150 0 0 150 40 120 cm\n/Im0 Do\nQ\n";
    textStreamBytes += Buffer.byteLength(content, "ascii");
    setObj(
      pageObjNum(i),
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> " +
        "/XObject << /Im0 " + imageObjNum(i) + " 0 R >> >> /Contents " + contentObjNum(i) + " 0 R >>",
    );
    setObj(
      contentObjNum(i),
      "<< /Length " + Buffer.byteLength(content, "ascii") + " >>\nstream\n" + content + "endstream",
    );
  }

  const chunks = [];
  let offset = 0;
  const push = (...parts) => {
    for (const part of parts) {
      const buf = typeof part === "string" ? Buffer.from(part, "ascii") : part;
      chunks.push(buf);
      offset += buf.length;
    }
  };
  push("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");
  const offsets = new Array(totalObjects + 1).fill(0);
  for (let n = 1; n <= totalObjects; n += 1) {
    offsets[n] = offset;
    push(n + " 0 obj\n", ...objects[n], "\nendobj\n");
  }
  const xrefStart = offset;
  let xref = "xref\n0 " + (totalObjects + 1) + "\n0000000000 65535 f \n";
  for (let n = 1; n <= totalObjects; n += 1) {
    xref += String(offsets[n]).padStart(10, "0") + " 00000 n \n";
  }
  push(xref);
  push("trailer\n<< /Size " + (totalObjects + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefStart + "\n%%EOF\n");

  const buffer = Buffer.concat(chunks);
  const stats = pageLines.reduce(
    (acc, lines) => {
      acc.lines += lines.length;
      for (const l of lines) acc.chars += l.text.length;
      return acc;
    },
    { lines: 0, chars: 0 },
  );
  return {
    buffer,
    stats: {
      ...stats,
      pages,
      bytes: buffer.length,
      textStreamBytes,
      imageBytes,
      cjkGlyphCodes: codeOf.size,
      charsPerPageAvg: Math.round(stats.chars / pages),
    },
  };
}

export function writePdf(path, opts) {
  const { buffer, stats } = buildPdf(opts);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buffer);
  return stats;
}

if (import.meta.url === "file://" + process.argv[1].replace(/\\/g, "/")) {
  const out = process.argv[2] ?? ".tmp/bench/pages-300-text.pdf";
  const pages = Number(process.argv[3] ?? 300);
  console.log(JSON.stringify({ out, ...writePdf(out, { pages }) }, null, 2));
}
