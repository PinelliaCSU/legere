#!/usr/bin/env node
// 生成构建所需的占位图标（Tauri 的 Windows 资源编译强制要求 icons/icon.ico）。
// 说明：应用图标属视觉资产，最终设计由用户提供；这里是**中性占位**（单色块，无品牌元素），
// 不预设任何配色倾向。用户提供正式图标后直接覆盖 src-tauri/icons/ 即可。
//
// 采用经典 BMP(DIB) 32bpp 多尺寸 ICO：PNG-in-ICO 在部分 Windows 组件上会被判为 BadIcon。
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "icons");
const RGB = [0x6b, 0x72, 0x80]; // 中性灰占位
const SIZES = [16, 32, 48, 64, 128, 256];

function dibEntry(size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND 两张图
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(size * size * 4, 20);

  // BGRA，自下而上
  const pixels = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4] = RGB[2];
    pixels[i * 4 + 1] = RGB[1];
    pixels[i * 4 + 2] = RGB[0];
    pixels[i * 4 + 3] = 255;
  }

  // AND 掩码：每行按 4 字节对齐，全 0 表示不透明
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size, 0);

  return Buffer.concat([header, pixels, mask]);
}

const entries = SIZES.map((size) => ({ size, data: dibEntry(size) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // type = icon
header.writeUInt16LE(entries.length, 4);

let offset = 6 + entries.length * 16;
const dirs = [];
for (const e of entries) {
  const d = Buffer.alloc(16);
  d[0] = e.size >= 256 ? 0 : e.size;
  d[1] = e.size >= 256 ? 0 : e.size;
  d[2] = 0;
  d[3] = 0;
  d.writeUInt16LE(1, 4);
  d.writeUInt16LE(32, 6);
  d.writeUInt32LE(e.data.length, 8);
  d.writeUInt32LE(offset, 12);
  offset += e.data.length;
  dirs.push(d);
}

const ico = Buffer.concat([header, ...dirs, ...entries.map((e) => e.data)]);

// 一并输出 PNG（Tauri 的 bundle 也需要 png，供非 Windows 平台使用）
function crc32(buf) {
  const table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
const S = 256;
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  const start = y * (S * 4 + 1);
  raw[start] = 0;
  for (let x = 0; x < S; x++) {
    const i = start + 1 + x * 4;
    raw[i] = RGB[0];
    raw[i + 1] = RGB[1];
    raw[i + 2] = RGB[2];
    raw[i + 3] = 255;
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "icon.ico"), ico);
writeFileSync(join(outDir, "icon.png"), png);
console.log(`占位图标已生成: icon.ico (${ico.length} bytes, ${SIZES.join("/")}px), icon.png (${png.length} bytes)`);
