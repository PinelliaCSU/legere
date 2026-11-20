#!/usr/bin/env node
// 契约一致性检查（docs/05-api-contracts.md §10 / M02 交付物）。
// 纯 Node 实现，不依赖 node_modules：CI 与本地都能直接跑。
//
// 检查三件事：
//   1) DTO 字段：src/contracts/types.ts 的 camelCase 字段 == src-tauri/src/contracts/dto.rs 的 snake_case 字段转 camel
//   2) Command 名：src/contracts/cmd.ts 的 CMD 值集合 == src-tauri/src/contracts/cmd.rs 的常量值集合
//   3) 错误码：src/contracts/errors.ts 的 API_ERROR_CODES == src-tauri/src/error.rs 的 serde rename
// 任何一项不一致 -> exit 1（阻塞 pnpm build，见裁决 T3）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const snakeToCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/** 抽取 TS interface 的字段（支持 extends，支持同一行内的内联对象类型）。 */
function parseTsInterfaces(source) {
  const out = new Map();
  const lines = source.split(/\r?\n/);
  let current = null;
  let depth = 0;
  let inherited = [];

  for (const line of lines) {
    if (current === null) {
      const m = /^export interface\s+(\w+)(?:<[^>]*>)?\s*(?:extends\s+([\w,\s]+?))?\s*\{/.exec(line);
      if (m) {
        current = m[1];
        inherited = m[2] ? m[2].split(",").map((s) => s.trim()).filter(Boolean) : [];
        depth = 1;
        out.set(current, { fields: [], inherited });
      }
      continue;
    }
    if (depth === 1) {
      const f = /^\s+(\w+)\??\s*:/.exec(line);
      if (f && !line.trim().startsWith("//")) out.get(current).fields.push(f[1]);
    }
    depth += countBraces(line);
    if (depth <= 0) current = null;
  }
  return out;
}

/** 抽取 Rust struct 的 pub 字段。 */
function parseRustStructs(source) {
  const out = new Map();
  const lines = source.split(/\r?\n/);
  let current = null;
  let depth = 0;
  for (const line of lines) {
    if (current === null) {
      const m = /^pub struct\s+(\w+)(?:<[^>]*>)?\s*\{/.exec(line);
      if (m) {
        current = m[1];
        depth = 1;
        out.set(current, []);
      }
      continue;
    }
    const f = /^\s+pub\s+(\w+)\s*:/.exec(line);
    if (f) out.get(current).push(f[1]);
    depth += countBraces(line);
    if (depth <= 0) current = null;
  }
  return out;
}

function countBraces(line) {
  let d = 0;
  for (const ch of line) {
    if (ch === "{") d += 1;
    else if (ch === "}") d -= 1;
  }
  return d;
}

const problems = [];
const notes = [];

// ── 1) DTO 字段 ──
const tsTypes = parseTsInterfaces(read("src/contracts/types.ts"));
const rsStructs = parseRustStructs(read("src-tauri/src/contracts/dto.rs"));

const flattenTs = (name, seen = new Set()) => {
  const node = tsTypes.get(name);
  if (!node || seen.has(name)) return [];
  seen.add(name);
  const base = node.inherited.flatMap((parent) => flattenTs(parent, seen));
  return [...base, ...node.fields];
};

let comparedTypes = 0;
for (const [tsName, node] of tsTypes) {
  const rs = rsStructs.get(tsName);
  if (!rs) {
    notes.push(`Rust 侧缺少结构体: ${tsName}（若该 DTO 尚未由 Rust 实现，属阶段性缺口）`);
    continue;
  }
  comparedTypes += 1;
  const tsFields = new Set(flattenTs(tsName));
  const rsFields = new Set(rs.map(snakeToCamel));
  for (const f of tsFields) if (!rsFields.has(f)) problems.push(`字段不一致 ${tsName}.${f}: 仅 TS 有`);
  for (const f of rsFields) if (!tsFields.has(f)) problems.push(`字段不一致 ${tsName}.${f}: 仅 Rust 有`);
}

// ── 2) Command 名 ──
const tsCmdValues = [...read("src/contracts/cmd.ts").matchAll(/^\s{2}[A-Z_]+:\s*"([a-z_]+)"/gm)].map((m) => m[1]);
const rsCmdValues = [...read("src-tauri/src/contracts/cmd.rs").matchAll(/^pub const [A-Z_]+: &str = "([a-z_]+)";/gm)].map((m) => m[1]);
const tsCmdSet = new Set(tsCmdValues);
const rsCmdSet = new Set(rsCmdValues);
for (const v of tsCmdSet) if (!rsCmdSet.has(v)) problems.push(`Command 仅 TS 有: ${v}`);
for (const v of rsCmdSet) if (!tsCmdSet.has(v)) problems.push(`Command 仅 Rust 有: ${v}`);
if (tsCmdSet.size !== 32) problems.push(`Command 数量应为 32，实际 ${tsCmdSet.size}`);

// ── 3) 错误码 ──
const tsCodes = new Set([...read("src/contracts/errors.ts").matchAll(/"(E_[A-Z_]+)"/g)].map((m) => m[1]));
const rsCodes = new Set([...read("src-tauri/src/error.rs").matchAll(/#\[serde\(rename = "(E_[A-Z_]+)"\)\]/g)].map((m) => m[1]));
for (const c of tsCodes) if (!rsCodes.has(c)) problems.push(`错误码仅 TS 有: ${c}`);
for (const c of rsCodes) if (!tsCodes.has(c)) problems.push(`错误码仅 Rust 有: ${c}`);
if (tsCodes.size !== 12) problems.push(`错误码数量应为 12，实际 ${tsCodes.size}`);

// ── 输出 ──
console.log(`比对 DTO 类型数: ${comparedTypes}`);
console.log(`Command: TS ${tsCmdSet.size} / Rust ${rsCmdSet.size}`);
console.log(`错误码: TS ${tsCodes.size} / Rust ${rsCodes.size}`);
for (const n of notes) console.log(`note: ${n}`);
if (problems.length > 0) {
  console.error("\n契约不一致:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("\n契约一致 ✓");
