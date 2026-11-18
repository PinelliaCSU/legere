#!/usr/bin/env node
// 生成 fixtures/pdf/ 下的真实 PDF 兼容矩阵样本：全部字节手写，不依赖任何 PDF 库。
// 目的：让「打不开/整页空白」这类回归可以在 node 里被复现，而不是靠用户手上那份 PDF。
//
// 重放：node scripts/make-pdf-fixtures.mjs
// 验证：node scripts/pdf-matrix.mjs

import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "fixtures", "pdf");

// ---------------------------------------------------------------- 字节工具

const latin1 = (s) => Buffer.from(s, "latin1");
const hex = (buf) => buf.toString("hex").toUpperCase();
const u8 = (n) => Buffer.from([n & 0xff]);
const u16be = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const i16be = (n) => u16be(n < 0 ? n + 0x10000 : n);
const u32be = (n) => Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const i32le = (n) => Buffer.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
const asBuffer = (body) => (Buffer.isBuffer(body) ? body : latin1(body));

/// PDF 流对象：dictEntries 是 "<</Type /X>>" 里 /Type /X 之后的部分。
function streamObject(dictEntries, data, { compress = false } = {}) {
  const raw = asBuffer(data);
  const body = compress ? deflateSync(raw) : raw;
  const filter = compress ? " /Filter /FlateDecode" : "";
  return Buffer.concat([
    latin1('<< ' + dictEntries + filter + " /Length " + body.length + " >>" + String.fromCharCode(10) + "stream" + String.fromCharCode(10)),
    body,
    latin1(String.fromCharCode(10) + "endstream"),
  ]);
}

class Doc {
  constructor(version = "1.4") {
    this.version = version;
    this.bodies = [];
  }
  reserve() {
    this.bodies.push(latin1(""));
    return this.bodies.length;
  }
  set(num, body) {
    this.bodies[num - 1] = asBuffer(body);
  }
  add(body) {
    const num = this.reserve();
    this.set(num, body);
    return num;
  }
  get count() {
    return this.bodies.length;
  }
}

const HEADER_BINARY = Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]);

function header(version) {
  return Buffer.concat([latin1("%PDF-" + version + String.fromCharCode(10)), HEADER_BINARY]);
}

/// 经典交叉引用表（PDF 1.0+）。
function assembleClassic(doc, { root, info = null, extraTrailer = "" }) {
  const chunks = [];
  let offset = 0;
  const push = (part) => {
    const buf = asBuffer(part);
    chunks.push(buf);
    offset += buf.length;
  };
  push(header(doc.version));
  const offsets = [];
  for (let i = 0; i < doc.bodies.length; i += 1) {
    offsets[i] = offset;
    push(i + 1 + " 0 obj" + String.fromCharCode(10));
    push(doc.bodies[i]);
    push(String.fromCharCode(10) + "endobj" + String.fromCharCode(10));
  }
  const xrefOffset = offset;
  push("xref" + String.fromCharCode(10) + "0 " + (doc.bodies.length + 1) + String.fromCharCode(10));
  push("0000000000 65535 f " + String.fromCharCode(10));
  for (let i = 0; i < doc.bodies.length; i += 1) {
    push(String(offsets[i]).padStart(10, "0") + " 00000 n " + String.fromCharCode(10));
  }
  const infoEntry = info === null ? "" : " /Info " + info + " 0 R";
  push(
    "trailer" + String.fromCharCode(10) +
      "<< /Size " + (doc.bodies.length + 1) + " /Root " + root + " 0 R" + infoEntry + extraTrailer + " >>" +
      String.fromCharCode(10) +
      "startxref" + String.fromCharCode(10) + xrefOffset + String.fromCharCode(10) + "%%EOF" + String.fromCharCode(10),
  );
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- 页面拼装

const PAGE_W = 612;
const PAGE_H = 792;

/// 加一棵扁平页面树；每页共用同一份 Resources 与 Content。
function addFlatPageTree(doc, { pageCount, resources, contents, mediaBox = "[0 0 612 792]" }) {
  const pagesNum = doc.reserve();
  const kids = [];
  for (let i = 0; i < pageCount; i += 1) {
    kids.push(
      doc.add(
        "<< /Type /Page /Parent " + pagesNum + " 0 R /MediaBox " + mediaBox +
          " /Resources " + resources + " /Contents " + contents + " 0 R >>",
      ),
    );
  }
  doc.set(
    pagesNum,
    "<< /Type /Pages /Count " + pageCount + " /Kids [" + kids.map((n) => n + " 0 R").join(" ") + "] >>",
  );
  return { pagesNum, pageNums: kids };
}

function simpleTextContent(text, size = 24) {
  return "BT /F1 " + size + " Tf 72 700 Td (" + text + ") Tj ET" +
    String.fromCharCode(10) + "72 660 m 540 660 l S" + String.fromCharCode(10);
}

const HELVETICA = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

// ---------------------------------------------------------------- 各样本文档

function buildTextPdf({
  version = "1.4",
  pageCount = 1,
  title = "Legere fixture",
  withOutline = false,
  info = true,
  label = "Legere fixture",
}) {
  const doc = new Doc(version);
  const catalogNum = doc.reserve();
  const fontNum = doc.add(HELVETICA);
  const contentNum = doc.add(streamObject("", simpleTextContent(label), { compress: false }));
  const { pagesNum, pageNums } = addFlatPageTree(doc, {
    pageCount,
    resources: "<< /Font << /F1 " + fontNum + " 0 R >> >>",
    contents: contentNum,
  });

  let catalogExtra = "";
  if (withOutline) {
    const itemNum = doc.reserve();
    const childNum = doc.reserve();
    const outlineNum = doc.add(
      "<< /Type /Outlines /First " + itemNum + " 0 R /Last " + itemNum + " 0 R /Count 2 >>",
    );
    const firstPage = pageNums[0] ?? 1;
    const secondPage = pageNums[1] ?? firstPage;
    doc.set(
      itemNum,
      "<< /Title (Chapter 1) /Parent " + outlineNum + " 0 R /Dest [" + firstPage + " 0 R /Fit]" +
        " /First " + childNum + " 0 R /Last " + childNum + " 0 R /Count 1 >>",
    );
    doc.set(
      childNum,
      "<< /Title (Section 1.1) /Parent " + itemNum + " 0 R /Dest [" + secondPage + " 0 R /Fit] >>",
    );
    catalogExtra = " /Outlines " + outlineNum + " 0 R /PageMode /UseOutlines";
  }
  doc.set(catalogNum, "<< /Type /Catalog /Pages " + pagesNum + " 0 R" + catalogExtra + " >>");

  let infoNum = null;
  if (info) {
    infoNum = doc.add(
      "<< /Title (" + title + ") /Producer (legere make-pdf-fixtures) /Creator (legere) >>",
    );
  }
  return assembleClassic(doc, { root: catalogNum, info: infoNum });
}

/// 对象流 + 交叉引用流（PDF 1.5+）。
function buildObjectStreamPdf() {
  const NL = String.fromCharCode(10);
  const packed = [
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Count 1 /Kids [4 0 R] >>"],
    [3, HELVETICA],
    [4, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>"],
  ];
  const contentObj = streamObject("", simpleTextContent("Object stream + xref stream"), { compress: true });

  const chunks = [];
  let offset = 0;
  const push = (part) => {
    const buf = asBuffer(part);
    chunks.push(buf);
    offset += buf.length;
  };
  push(header("1.7"));

  const offsets = new Map();
  offsets.set(5, offset);
  push("5 0 obj" + NL);
  push(contentObj);
  push(NL + "endobj" + NL);

  // 对象流：头部是 "objNum offset" 对，对象体从 /First 处开始。
  const bodies = packed.map(([, body]) => body);
  let headerText = "";
  let bodyOffset = 0;
  const pairs = [];
  for (let i = 0; i < packed.length; i += 1) {
    pairs.push(packed[i][0] + " " + bodyOffset);
    bodyOffset += Buffer.byteLength(bodies[i], "latin1") + 1;
  }
  headerText = pairs.join(" ") + " ";
  const objStmData = latin1(headerText + bodies.join(NL));
  offsets.set(6, offset);
  push("6 0 obj" + NL);
  push(
    streamObject(
      "/Type /ObjStm /N " + packed.length + " /First " + Buffer.byteLength(headerText, "latin1"),
      objStmData,
      { compress: true },
    ),
  );
  push(NL + "endobj" + NL);

  // 交叉引用流：0 号是自由项，其余按 1(偏移)/2(对象流) 编码。
  const xrefOffset = offset;
  offsets.set(7, xrefOffset);
  const entry = (type, a, b) =>
    Buffer.concat([u8(type), u16be(a), u16be(b)]);
  const rows = [entry(0, 0, 0xffff)];
  rows.push(entry(2, 6, 0), entry(2, 6, 1), entry(2, 6, 2), entry(2, 6, 3));
  rows.push(entry(1, offsets.get(5), 0), entry(1, offsets.get(6), 0), entry(1, xrefOffset, 0));
  const xrefData = Buffer.concat(rows);
  push("7 0 obj" + NL);
  push(
    Buffer.concat([
      latin1(
        "<< /Type /XRef /Size 8 /Index [0 8] /W [1 2 2] /Root 1 0 R /Length " + xrefData.length + " >>" + NL + "stream" + NL,
      ),
      xrefData,
      latin1(NL + "endstream" + NL + "endobj" + NL),
    ]),
  );
  push("startxref" + NL + xrefOffset + NL + "%%EOF" + NL);
  return Buffer.concat(chunks);
}

/// 线性化：/Linearized 字典放在文件头，且 /L 必须等于真实文件长度。
function buildLinearizedPdf() {
  const NL = String.fromCharCode(10);
  const draft = { L: 0, E: 0, T: 0, H: 0 };
  let result = null;
  for (let round = 0; round < 8; round += 1) {
    const chunks = [];
    let offset = 0;
    const push = (part) => {
      const buf = asBuffer(part);
      chunks.push(buf);
      offset += buf.length;
    };
    push(header("1.7"));
    const linOffset = offset;
    push(
      "1 0 obj" + NL +
        "<< /Linearized 1 /L " + draft.L + " /H [" + draft.H + " 8] /O 4 /E " + draft.E +
        " /N 1 /T " + draft.T + " >>" + NL + "endobj" + NL,
    );
    const hintOffset = offset;
    push("2 0 obj" + NL + streamObject("", "hintzzzz") + NL + "endobj" + NL);
    const endFirst = offset;
    push("3 0 obj" + NL + "<< /Type /Catalog /Pages 5 0 R >>" + NL + "endobj" + NL);
    push(
      "4 0 obj" + NL +
        "<< /Type /Page /Parent 5 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 7 0 R >>" +
        NL + "endobj" + NL,
    );
    push("5 0 obj" + NL + "<< /Type /Pages /Count 1 /Kids [4 0 R] >>" + NL + "endobj" + NL);
    push("6 0 obj" + NL + HELVETICA + NL + "endobj" + NL);
    const contentOffset = offset;
    push("7 0 obj" + NL);
    push(streamObject("", simpleTextContent("Linearized PDF")));
    push(NL + "endobj" + NL);
    const xrefOffset = offset;
    push("xref" + NL + "0 8" + NL + "0000000000 65535 f " + NL);
    const objOffsets = [linOffset, hintOffset, endFirst, endFirst, endFirst, contentOffset, contentOffset];
    for (const o of objOffsets) push(String(o).padStart(10, "0") + " 00000 n " + NL);
    push(
      "trailer" + NL + "<< /Size 8 /Root 3 0 R >>" + NL + "startxref" + NL + xrefOffset + NL + "%%EOF" + NL,
    );
    result = Buffer.concat(chunks);
    const next = { L: result.length, E: endFirst, T: xrefOffset, H: hintOffset };
    const stable =
      next.L === draft.L && next.E === draft.E && next.T === draft.T && next.H === draft.H;
    draft.L = next.L;
    draft.E = next.E;
    draft.T = next.T;
    draft.H = next.H;
    if (stable) break;
  }
  return result;
}

/// CJK：Type0 + 预定义 UCS2 CMap（需 cMapUrl 才能解码）。
function buildCjkPdf({ cmapName, ordering, texts, baseFont, label }) {
  const doc = new Doc("1.7");
  const catalogNum = doc.reserve();
  const fontNum = doc.reserve();
  const descriptorNum = doc.add(
    "<< /Type /FontDescriptor /FontName /" + baseFont +
      " /Flags 4 /FontBBox [-25 -250 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120" +
      " /CapHeight 700 /StemV 80 >>",
  );
  const cidFontNum = doc.add(
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /" + baseFont +
      " /CIDSystemInfo << /Registry (Adobe) /Ordering (" + ordering + ") /Supplement 4 >>" +
      " /FontDescriptor " + descriptorNum + " 0 R /DW 1000 >>",
  );
  const toUnicodeBody = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    texts.length + " beginbfchar",
    ...texts.map((cp) => "<" + cp.toString(16).toUpperCase().padStart(4, "0") + "> <" + cp.toString(16).toUpperCase().padStart(4, "0") + ">"),
    "endbfchar",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join(String.fromCharCode(10));
  const toUnicodeNum = doc.add(streamObject("", toUnicodeBody, { compress: true }));
  doc.set(
    fontNum,
    "<< /Type /Font /Subtype /Type0 /BaseFont /" + baseFont + " /Encoding /" + cmapName +
      " /DescendantFonts [" + cidFontNum + " 0 R] /ToUnicode " + toUnicodeNum + " 0 R >>",
  );
  const hexText = texts.map((cp) => cp.toString(16).toUpperCase().padStart(4, "0")).join("");
  const contentNum = doc.add(
    streamObject("", "BT /F1 24 Tf 72 700 Td <" + hexText + "> Tj ET" + String.fromCharCode(10)),
  );
  const { pagesNum } = addFlatPageTree(doc, {
    pageCount: 1,
    resources: "<< /Font << /F1 " + fontNum + " 0 R >> >>",
    contents: contentNum,
  });
  doc.set(catalogNum, "<< /Type /Catalog /Pages " + pagesNum + " 0 R >>");
  const infoNum = doc.add("<< /Title (" + label + ") >>");
  return assembleClassic(doc, { root: catalogNum, info: infoNum });
}

// ---------------------------------------------------------------- 内嵌子集 TrueType

/// 最小可用 TrueType：4 个字形（.notdef 与 A/B/C，均为空轮廓），cmap format 4。
function buildSubsetTrueType() {
  const NL = String.fromCharCode(10);
  const numGlyphs = 4;
  const unitsPerEm = 1000;

  const head = Buffer.concat([
    u32be(0x00010000),
    u32be(0x00010000),
    u32be(0),
    u32be(0x5f0f3cf5),
    u16be(0x0003),
    u16be(unitsPerEm),
    Buffer.alloc(16),
    i16be(0), i16be(0), i16be(0), i16be(0),
    u16be(0),
    u16be(8),
    i16be(2),
    i16be(0),
    i16be(0),
  ]);

  const hhea = Buffer.concat([
    u32be(0x00010000),
    i16be(800), i16be(-200), i16be(0),
    u16be(600), i16be(0), i16be(0), i16be(0),
    i16be(1), i16be(0), i16be(0),
    i16be(0), i16be(0), i16be(0), i16be(0),
    i16be(0),
    u16be(numGlyphs),
  ]);

  const maxp = Buffer.concat([
    u32be(0x00010000),
    u16be(numGlyphs),
    u16be(0), u16be(0), u16be(0), u16be(0),
    u16be(1),
    u16be(0), u16be(0), u16be(0), u16be(0), u16be(0), u16be(0), u16be(0), u16be(0),
  ]);

  const hmtx = Buffer.concat(new Array(numGlyphs).fill(0).map(() => Buffer.concat([u16be(600), i16be(0)])));
  const loca = Buffer.alloc((numGlyphs + 1) * 2);
  const glyf = Buffer.alloc(4);

  const cmapSub = Buffer.concat([
    u16be(4),
    u16be(32),
    u16be(0),
    u16be(4),
    u16be(4),
    u16be(1),
    u16be(0),
    u16be(0x43), u16be(0xffff),
    u16be(0),
    u16be(0x41), u16be(0xffff),
    i16be(-64), i16be(1),
    u16be(0), u16be(0),
  ]);
  const cmap = Buffer.concat([u16be(0), u16be(1), u16be(3), u16be(1), u32be(12), cmapSub]);

  const nameStrings = ["LegereSubset", "Legere Subset", "LegereSubset"];
  const nameRecords = [];
  const nameBodies = [];
  let nameOffset = 0;
  const nameIds = [1, 4, 6];
  for (let i = 0; i < nameStrings.length; i += 1) {
    const utf16 = Buffer.from(nameStrings[i], "utf16le");
    for (let k = 0; k < utf16.length; k += 2) {
      const lo = utf16[k];
      utf16[k] = utf16[k + 1];
      utf16[k + 1] = lo;
    }
    nameRecords.push(
      Buffer.concat([u16be(3), u16be(1), u16be(0x409), u16be(nameIds[i]), u16be(utf16.length), u16be(nameOffset)]),
    );
    nameBodies.push(utf16);
    nameOffset += utf16.length;
  }
  const name = Buffer.concat([
    u16be(0), u16be(nameRecords.length), u16be(6 + nameRecords.length * 12),
    ...nameRecords,
    ...nameBodies,
  ]);

  const post = Buffer.concat([
    u32be(0x00030000), u32be(0), i16be(-100), i16be(50), u32be(0),
    u32be(0), u32be(0), u32be(0), u32be(0),
  ]);

  const os2 = Buffer.concat([
    u16be(0),
    i16be(600), u16be(400), u16be(5), u16be(0),
    i16be(650), i16be(600), i16be(0), i16be(75),
    i16be(650), i16be(600), i16be(0), i16be(350),
    i16be(50), i16be(250),
    i16be(0),
    Buffer.alloc(10),
    u32be(0), u32be(0), u32be(0), u32be(0),
    latin1("LEGE"),
    u16be(0x0040),
    u16be(0x41), u16be(0x43),
    i16be(800), i16be(-200), i16be(0),
    u16be(800), u16be(200),
  ]);

  const tables = [
    ["OS/2", os2],
    ["cmap", cmap],
    ["glyf", glyf],
    ["head", head],
    ["hhea", hhea],
    ["hmtx", hmtx],
    ["loca", loca],
    ["maxp", maxp],
    ["name", name],
    ["post", post],
  ].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const checksum = (buf) => {
    const padded = Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4)]);
    let sum = 0;
    for (let i = 0; i < padded.length; i += 4) {
      sum = (sum + padded.readUInt32BE(i)) >>> 0;
    }
    return sum;
  };

  const numTables = tables.length;
  const headerSize = 12 + numTables * 16;
  let cursor = headerSize;
  const placements = [];
  for (const [tag, body] of tables) {
    const padded = Buffer.concat([body, Buffer.alloc((4 - (body.length % 4)) % 4)]);
    placements.push({ tag, body, padded, offset: cursor });
    cursor += padded.length;
  }
  let headOffset = 0;
  for (const p of placements) if (p.tag === "head") headOffset = p.offset;

  const build = (adjustment) => {
    const dir = Buffer.concat([
      u32be(0x00010000),
      u16be(numTables),
      u16be(16),
      u16be(0),
      u16be(0),
      ...placements.map((p) =>
        Buffer.concat([latin1(p.tag), u32be(checksum(p.body)), u32be(p.offset), u32be(p.body.length)]),
      ),
    ]);
    const parts = [header("1.7").subarray(0, 0), dir];
    let written = headerSize;
    for (const p of placements) {
      if (p.tag === "head") {
        const patched = Buffer.from(p.padded);
        patched.writeUInt32BE(adjustment >>> 0, 8);
        parts.push(patched);
      } else {
        parts.push(p.padded);
      }
      written += p.padded.length;
    }
    return Buffer.concat(parts);
  };

  const provisional = build(0);
  const adjustment = (0xb1b0afba - checksum(provisional)) >>> 0;
  void headOffset;
  return build(adjustment);
}

function buildSubsetFontPdf() {
  const ttf = buildSubsetTrueType();
  const doc = new Doc("1.6");
  const catalogNum = doc.reserve();
  const fontProgramNum = doc.add(streamObject("/Length1 " + ttf.length, ttf, { compress: true }));
  const descriptorNum = doc.add(
    "<< /Type /FontDescriptor /FontName /LegereSubset /Flags 4 /FontBBox [0 -200 600 800]" +
      " /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80" +
      " /FontFile2 " + fontProgramNum + " 0 R >>",
  );
  const fontNum = doc.add(
    "<< /Type /Font /Subtype /TrueType /BaseFont /LegereSubset /FirstChar 65 /LastChar 67" +
      " /Widths [600 600 600] /FontDescriptor " + descriptorNum + " 0 R /Encoding /WinAnsiEncoding >>",
  );
  const contentNum = doc.add(streamObject("", simpleTextContent("ABC ABC", 28)));
  const { pagesNum } = addFlatPageTree(doc, {
    pageCount: 1,
    resources: "<< /Font << /F1 " + fontNum + " 0 R >> >>",
    contents: contentNum,
  });
  doc.set(catalogNum, "<< /Type /Catalog /Pages " + pagesNum + " 0 R >>");
  return assembleClassic(doc, { root: catalogNum, info: null });
}

// ---------------------------------------------------------------- 纯图片扫描页（DCTDecode）

/// 手写 16x16 灰度基线 JPEG：4 个 MCU，DC 差分 0 + EOB，熵编码字节固定。
function buildGrayJpeg(width = 16, height = 16) {
  const NL = String.fromCharCode(10);
  void NL;
  const dcBits = Buffer.from([0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
  const dcValues = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const acBits = Buffer.from([0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d]);
  const acValues = Buffer.from([
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
  ]);
  const dqt = Buffer.alloc(64, 16);

  const mcus = Math.ceil(width / 8) * Math.ceil(height / 8);
  // 每个 MCU：DC 类别 0（码字 00）+ EOB（码字 1010）=> 6 bit，4 个 MCU 恰好 3 字节。
  const bits = [];
  const pushBits = (value, count) => {
    for (let i = count - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  for (let i = 0; i < mcus; i += 1) {
    pushBits(0b00, 2);
    pushBits(0b1010, 4);
  }
  while (bits.length % 8 !== 0) bits.push(1);
  const entropy = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let k = 0; k < 8; k += 1) byte = (byte << 1) | bits[i + k];
    entropy.push(byte);
  }
  const stuffed = [];
  for (const byte of entropy) {
    stuffed.push(byte);
    if (byte === 0xff) stuffed.push(0x00);
  }

  const marker = (code, payload) => Buffer.concat([Buffer.from([0xff, code]), u16be(payload.length + 2), payload]);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    marker(0xe0, Buffer.concat([latin1("JFIF"), Buffer.from([0, 1, 1, 0, 0, 1, 0, 1, 0, 0])])),
    marker(0xdb, Buffer.concat([Buffer.from([0]), dqt])),
    marker(0xc0, Buffer.concat([Buffer.from([8]), u16be(height), u16be(width), Buffer.from([1, 1, 0x11, 0])])),
    marker(0xc4, Buffer.concat([Buffer.from([0x00]), dcBits, dcValues])),
    marker(0xc4, Buffer.concat([Buffer.from([0x10]), acBits, acValues])),
    marker(0xda, Buffer.from([1, 1, 0x00, 0, 63, 0])),
    Buffer.from(stuffed),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function buildScannedPdf() {
  const jpeg = buildGrayJpeg();
  const doc = new Doc("1.5");
  const catalogNum = doc.reserve();
  const imageNum = doc.add(
    streamObject(
      "/Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceGray" +
        " /BitsPerComponent 8 /Filter /DCTDecode",
      jpeg,
    ),
  );
  const contentNum = doc.add(
    streamObject("", "q 612 0 0 792 0 0 cm /Im1 Do Q" + String.fromCharCode(10)),
  );
  const { pagesNum } = addFlatPageTree(doc, {
    pageCount: 1,
    resources: "<< /XObject << /Im1 " + imageNum + " 0 R >> >>",
    contents: contentNum,
  });
  doc.set(catalogNum, "<< /Type /Catalog /Pages " + pagesNum + " 0 R >>");
  return assembleClassic(doc, { root: catalogNum, info: null });
}

// ---------------------------------------------------------------- 加密（标准安全处理器 RC4 40-bit）

const PAD = Buffer.from(
  "28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A",
  "hex",
);

function md5(...parts) {
  const hash = createHash("md5");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function rc4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + S[i] + key[i % key.length]) & 0xff;
    const tmp = S[i];
    S[i] = S[j];
    S[j] = tmp;
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k += 1) {
    i = (i + 1) & 0xff;
    j = (j + S[i]) & 0xff;
    const tmp = S[i];
    S[i] = S[j];
    S[j] = tmp;
    out[k] = data[k] ^ S[(S[i] + S[j]) & 0xff];
  }
  return out;
}

function padPassword(password) {
  const raw = latin1(password);
  const out = Buffer.alloc(32);
  raw.copy(out, 0, 0, Math.min(32, raw.length));
  PAD.copy(out, Math.min(32, raw.length), 0, 32 - Math.min(32, raw.length));
  return out;
}

const FILE_ID = Buffer.from("0123456789ABCDEF0123456789ABCDEF", "hex");
const PERMISSIONS = -44;

function buildEncryptedPdf({ userPassword = "", ownerPassword = "legere-owner" }) {
  const O = rc4(md5(padPassword(ownerPassword)).subarray(0, 5), padPassword(userPassword));
  const fileKey = md5(padPassword(userPassword), O, i32le(PERMISSIONS), FILE_ID).subarray(0, 5);
  const U = rc4(fileKey, PAD);

  const doc = new Doc("1.4");
  const catalogNum = doc.reserve();
  const encryptNum = doc.reserve();
  const contentNum = doc.reserve();
  const fontNum = doc.add(HELVETICA);
  const { pagesNum } = addFlatPageTree(doc, {
    pageCount: 1,
    resources: "<< /Font << /F1 " + fontNum + " 0 R >> >>",
    contents: contentNum,
  });
  const plain = latin1(simpleTextContent("Encrypted RC4 40-bit"));
  const objectKey = md5(fileKey, Buffer.from([contentNum & 0xff, (contentNum >> 8) & 0xff, 0, 0, 0])).subarray(0, 10);
  const cipher = rc4(objectKey, plain);
  doc.set(contentNum, streamObject("", cipher));
  doc.set(
    encryptNum,
    "<< /Filter /Standard /V 1 /R 2 /O <" + hex(O) + "> /U <" + hex(U) + "> /P " + PERMISSIONS + " >>",
  );
  doc.set(catalogNum, "<< /Type /Catalog /Pages " + pagesNum + " 0 R >>");
  return assembleClassic(doc, {
    root: catalogNum,
    info: null,
    extraTrailer: " /Encrypt " + encryptNum + " 0 R /ID [<" + hex(FILE_ID) + "> <" + hex(FILE_ID) + ">]",
  });
}

// ---------------------------------------------------------------- 清单

const FIXTURES = [
  { name: "pdf-1.4-basic.pdf", note: "PDF 1.4 · 2 页 · 目录 · Info", build: () => buildTextPdf({ version: "1.4", pageCount: 2, withOutline: true, label: "PDF 1.4 basic" }) },
  { name: "pdf-1.7-basic.pdf", note: "PDF 1.7 · 2 页 · 经典 xref", build: () => buildTextPdf({ version: "1.7", pageCount: 2, label: "PDF 1.7 basic" }) },
  { name: "pdf-2.0-basic.pdf", note: "PDF 2.0 · 1 页", build: () => buildTextPdf({ version: "2.0", pageCount: 1, label: "PDF 2.0 basic" }) },
  { name: "object-stream-xref-stream.pdf", note: "对象流 + 交叉引用流", build: () => buildObjectStreamPdf() },
  { name: "linearized.pdf", note: "带 /Linearized 字典", build: () => buildLinearizedPdf() },
  { name: "no-outline.pdf", note: "无目录 · 3 页", build: () => buildTextPdf({ version: "1.4", pageCount: 3, withOutline: false, label: "No outline" }) },
  { name: "single-page.pdf", note: "单页 · 无 Info", build: () => buildTextPdf({ version: "1.4", pageCount: 1, info: false, label: "Single page" }) },
  { name: "pages-300.pdf", note: "300 页", build: () => buildTextPdf({ version: "1.5", pageCount: 300, info: false, label: "300 pages" }) },
  { name: "pages-1200.pdf", note: "1200 页", build: () => buildTextPdf({ version: "1.5", pageCount: 1200, info: false, label: "1200 pages" }) },
  { name: "cjk-zh-ucs2.pdf", note: "中文 CID · UniGB-UCS2-H", build: () => buildCjkPdf({ cmapName: "UniGB-UCS2-H", ordering: "GB1", texts: [0x4e2d, 0x6587], baseFont: "STSong-Light", label: "CJK Chinese" }) },
  { name: "cjk-ja-ucs2.pdf", note: "日文 CID · UniJIS-UCS2-H", build: () => buildCjkPdf({ cmapName: "UniJIS-UCS2-H", ordering: "Japan1", texts: [0x65e5, 0x672c, 0x8a9e], baseFont: "HeiseiMin-W3", label: "CJK Japanese" }) },
  { name: "cjk-ko-ucs2.pdf", note: "韩文 CID · UniKS-UCS2-H", build: () => buildCjkPdf({ cmapName: "UniKS-UCS2-H", ordering: "Korea1", texts: [0xd55c, 0xad6d, 0xc5b4], baseFont: "HYSMyeongJo-Medium", label: "CJK Korean" }) },
  { name: "embedded-subset-truetype.pdf", note: "内嵌子集 TrueType", build: () => buildSubsetFontPdf() },
  { name: "standard-helvetica.pdf", note: "标准字体 Helvetica（不内嵌）", build: () => buildTextPdf({ version: "1.4", pageCount: 1, info: false, label: "Standard Helvetica" }) },
  { name: "scanned-jpeg.pdf", note: "纯图片扫描页 · DCTDecode", build: () => buildScannedPdf() },
  { name: "encrypted-rc4-empty-user-password.pdf", note: "加密 RC4 · 空用户密码（可直接打开）", build: () => buildEncryptedPdf({ userPassword: "" }) },
  { name: "encrypted-rc4-user-password.pdf", note: "加密 RC4 · 需要用户密码", build: () => buildEncryptedPdf({ userPassword: "legere", ownerPassword: "legere-owner" }) },
];

await mkdir(OUT_DIR, { recursive: true });
let total = 0;
for (const fixture of FIXTURES) {
  const bytes = fixture.build();
  await writeFile(join(OUT_DIR, fixture.name), bytes);
  total += bytes.length;
  console.log(fixture.name.padEnd(40) + String(bytes.length).padStart(9) + " B  " + fixture.note);
}
console.log("共 " + FIXTURES.length + " 份 fixture, " + total + " 字节 -> fixtures/pdf/");
