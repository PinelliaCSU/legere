#!/usr/bin/env node
// 逐份打开 fixtures/pdf/ 里的样本，打印兼容矩阵：每份一行 ok/fail 与错误 name。
// 用途：把「PDF 打开后没有内容」变成一个可在 node 里秒级复现的回归测试。
//
// 重放：node scripts/pdf-matrix.mjs
//
// 注意：这里传的资源 URL 必须是绝对 file: URL（pdfjs 只做「以 / 结尾」校验，
// 相对串在 worker 内会被拼到 worker 脚本自身的位置上而 404）。

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = join(ROOT, "fixtures", "pdf");
const ASSET_DIR = join(ROOT, "public", "pdfjs");

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

// pdfjs 在 node 下用 fs.readFile(factoryUrl + filename) 取资源，因此这里必须是
// 普通文件系统路径（file: URL 字符串会被当成路径字面量 → ENOENT）。
const assetUrl = (name) => join(ASSET_DIR, name).replace(/\\/g, "/") + "/";
const OPTIONS = {
  cMapUrl: assetUrl("cmaps"),
  cMapPacked: true,
  standardFontDataUrl: assetUrl("standard_fonts"),
  wasmUrl: assetUrl("wasm"),
  iccUrl: assetUrl("iccs"),
  verbosity: 1,
};

// 采集 pdfjs 的 "Warning: ..." 行：整页空白往往先只表现为一条 warning。
let capture = null;
const nativeLog = console.log;
console.log = (...args) => {
  const line = args.map(String).join(" ");
  if (capture !== null && line.startsWith("Warning:")) capture.push(line);
  nativeLog(...args);
};

const EXPECTATIONS = {
  "pdf-1.4-basic.pdf": { pages: 2, outcome: "ok" },
  "pdf-1.7-basic.pdf": { pages: 2, outcome: "ok" },
  "pdf-2.0-basic.pdf": { pages: 1, outcome: "ok" },
  "object-stream-xref-stream.pdf": { pages: 1, outcome: "ok" },
  "linearized.pdf": { pages: 1, outcome: "ok" },
  "no-outline.pdf": { pages: 3, outcome: "ok" },
  "single-page.pdf": { pages: 1, outcome: "ok" },
  "pages-300.pdf": { pages: 300, outcome: "ok" },
  "pages-1200.pdf": { pages: 1200, outcome: "ok" },
  "cjk-zh-ucs2.pdf": { pages: 1, outcome: "ok", text: "中文" },
  "cjk-ja-ucs2.pdf": { pages: 1, outcome: "ok", text: "日本語" },
  "cjk-ko-ucs2.pdf": { pages: 1, outcome: "ok", text: "한국어" },
  "embedded-subset-truetype.pdf": { pages: 1, outcome: "ok" },
  "standard-helvetica.pdf": { pages: 1, outcome: "ok" },
  "scanned-jpeg.pdf": { pages: 1, outcome: "ok", textItems: 0 },
  "encrypted-rc4-empty-user-password.pdf": { pages: 1, outcome: "ok" },
  "encrypted-rc4-user-password.pdf": { pages: 1, outcome: "PasswordException" },
};

async function inspect(name) {
  const bytes = new Uint8Array(await readFile(join(FIXTURE_DIR, name)));
  const started = Date.now();
  capture = [];
  const task = pdfjs.getDocument({ data: bytes, ...OPTIONS });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.filter((item) => typeof item.str === "string");
    const text = items.map((item) => item.str).join("");
    // getOperatorList 会真正解码图片（DCT/JPX/JBIG2）与加载字体，是「整页能否画出来」的更近的一步。
    const operators = await page.getOperatorList();
    const pages = doc.numPages;
    const warnings = capture ?? [];
    capture = null;
    await task.destroy();
    return { outcome: "ok", pages, text, textItems: items.length, ops: operators.fnArray.length, warnings, widthPt: Math.round(viewport.width), heightPt: Math.round(viewport.height), ms: Date.now() - started };
  } catch (err) {
    capture = null;
    return { outcome: "error", name: err?.name ?? "Error", status: err?.status, message: String(err?.message ?? err), ms: Date.now() - started };
  }
}

const files = (await readdir(FIXTURE_DIR)).filter((f) => f.endsWith(".pdf")).sort();
const seen = new Set();
let pass = 0;
let fail = 0;
console.log("fixture".padEnd(40) + "结果        页数    几何(pt)      文本项  操作符  warning  耗时    内容");
console.log("-".repeat(112));

for (const name of files) {
  const expect = EXPECTATIONS[name];
  const got = await inspect(name);
  seen.add(name);
  const problems = [];
  if (!expect) problems.push("无预期");
  else {
    const actualOutcome = got.outcome === "ok" ? "ok" : got.name;
    if (actualOutcome !== expect.outcome) problems.push("期望 " + expect.outcome + " 实际 " + actualOutcome);
    if (expect.pages !== undefined && got.pages !== undefined && got.pages !== expect.pages) problems.push("页数 " + got.pages + " != " + expect.pages);
    if (expect.text !== undefined && !(got.text ?? "").includes(expect.text)) problems.push("缺少文本 " + expect.text);
    if (expect.textItems !== undefined && got.textItems !== expect.textItems) problems.push("文本项 " + got.textItems + " != " + expect.textItems);
  }
  if (got.outcome === "ok" && (got.widthPt !== 612 || got.heightPt !== 792)) problems.push("几何 " + got.widthPt + "x" + got.heightPt);
  if (got.outcome === "ok" && got.pages > 0 && (got.widthPt <= 0 || got.heightPt <= 0)) problems.push("几何非正");

  const status = problems.length === 0 ? "PASS" : "FAIL";
  if (problems.length === 0) pass += 1;
  else fail += 1;

  if (got.outcome === "ok") {
    console.log(
      name.padEnd(40) + status.padEnd(11) + String(got.pages).padEnd(8) +
        (got.widthPt + "x" + got.heightPt).padEnd(14) + String(got.textItems).padEnd(8) +
        String(got.ops).padEnd(8) + String(got.warnings.length).padEnd(9) +
        String(got.ms + "ms").padEnd(8) + JSON.stringify(got.text.slice(0, 20)),
    );
  } else {
    console.log(
      name.padEnd(40) + status.padEnd(11) + "-".padEnd(8) + "-".padEnd(14) + "-".padEnd(8) + "-".padEnd(8) + "-".padEnd(9) +
        String(got.ms + "ms").padEnd(8) + "name=" + got.name + (got.status ? " status=" + got.status : "") + " " + got.message.slice(0, 60),
    );
  }
  if (got.outcome === "ok" && got.warnings.length > 0) {
    for (const warning of got.warnings.slice(0, 3)) console.log(" ".repeat(40) + "  ! " + warning.slice(0, 150));
  }
  for (const problem of problems) console.log(" ".repeat(40) + "  ^ " + problem);
}

const missing = Object.keys(EXPECTATIONS).filter((name) => !seen.has(name));
for (const name of missing) {
  console.log(name.padEnd(40) + "MISSING");
  fail += 1;
}
console.log("-".repeat(112));
console.log("共 " + files.length + " 份, PASS " + pass + ", FAIL " + fail);

// ---------------------------------------------------------------- 资源文件落位

const REQUIRED_ASSETS = [
  ["wasm", "openjpeg.wasm"],
  ["wasm", "jbig2.wasm"],
  ["wasm", "qcms_bg.wasm"],
  ["wasm", "quickjs-eval.wasm"],
  ["iccs", "CGATS001Compat-v2-micro.icc"],
  ["cmaps", "UniGB-UCS2-H.bcmap"],
  ["cmaps", "UniJIS-UCS2-H.bcmap"],
  ["cmaps", "UniKS-UCS2-H.bcmap"],
  ["standard_fonts", "FoxitSerif.pfb"],
  ["standard_fonts", "LiberationSans-Regular.ttf"],
];
console.log("");
console.log("资源文件（public/pdfjs/**，会被 Vite publicDir 原样搬到 dist 根）：");
let assetsMissing = 0;
for (const [dir, file] of REQUIRED_ASSETS) {
  try {
    const { size } = await stat(join(ASSET_DIR, dir, file));
    console.log("  ok      public/pdfjs/" + dir + "/" + file.padEnd(32) + String(size).padStart(9) + " B");
  } catch {
    console.log("  MISSING public/pdfjs/" + dir + "/" + file);
    assetsMissing += 1;
  }
}

// ---------------------------------------------------------------- 负向对照

// 同一份中文 PDF，只把 cMapUrl 换成相对串：应当退化成「页面能打开但没有文字」，
// 这正是用户看到的「打开后没有内容」。
console.log("");
console.log("负向对照（同一份 cjk-zh-ucs2.pdf）：");
const baseline = await inspect("cjk-zh-ucs2.pdf");
const relOptions = { ...OPTIONS, cMapUrl: "pdfjs/cmaps/" };
const relTask = pdfjs.getDocument({
  data: new Uint8Array(await readFile(join(FIXTURE_DIR, "cjk-zh-ucs2.pdf"))),
  ...relOptions,
});
const relWarnings = [];
capture = relWarnings;
let relativeResult;
try {
  const doc = await relTask.promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  relativeResult = { textItems: content.items.filter((i) => typeof i.str === "string").length, pages: doc.numPages };
  await relTask.destroy();
} catch (err) {
  relativeResult = { error: err?.name ?? "Error", message: String(err?.message ?? err) };
}
capture = null;
console.log("  绝对 cMapUrl : 文本项 " + baseline.textItems + " 内容 " + JSON.stringify(baseline.text));
console.log(
  "  相对 cMapUrl : " +
    (relativeResult.error !== undefined
      ? "打开失败 name=" + relativeResult.error
      : "文本项 " + relativeResult.textItems + " 内容 []（页面 612x792 仍在，但没有文字）"),
);
for (const warning of relWarnings.slice(0, 2)) console.log("    ! " + warning.slice(0, 140));
const relativeControlOk = baseline.textItems > 0 && (relativeResult.error !== undefined || relativeResult.textItems === 0);
console.log("  判据         : " + (relativeControlOk ? "PASS（相对 URL 确实会丢文本）" : "FAIL（矩阵对 URL 形式不敏感）"));

process.exitCode = fail === 0 && assetsMissing === 0 && relativeControlOk ? 0 : 1;
