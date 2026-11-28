// Run from the repository root: node scripts/bench/search.mjs
import { readFile } from "node:fs/promises";
import { deepStrictEqual } from "node:assert";
import { createServer } from "vite";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildPdf } from "./gen-pdf.mjs";

const data = process.argv[2] ? await readFile(process.argv[2]) : buildPdf({ pages: 300 }).buffer;
const server = await createServer({ server: { middlewareMode: true, hmr: false }, logLevel: "error" });
try {
  const { scanFromOrigin, createSearchTextCache } = await server.ssrLoadModule("/src/reader/search/doc-search.ts");
  const { createRenderScheduler } = await server.ssrLoadModule("/src/render/scheduler.ts");
  const { toTextItem, buildTextContent } = await server.ssrLoadModule("/src/pdf-engine/text-content.ts");
  const queries = ["viewport", "cache", "range request"];
  const samples = [[], []];
  let reference;
  for (let round = 0; round < 6; round++) {
    for (const enabled of round % 2 ? [true, false] : [false, true]) {
      const task = getDocument({ data: Uint8Array.from(data), verbosity: 0 });
      const pdf = await task.promise;
      const scheduler = createRenderScheduler();
      const cache = enabled ? createSearchTextCache() : undefined;
      scheduler.setDocument({ pageCount: pdf.numPages, getPage: async n => ({
        async getTextContent() {
          const raw = await (await pdf.getPage(n)).getTextContent();
          const items = raw.items.filter(i => typeof i.str === "string");
          return buildTextContent(items.map(toTextItem), items.map(i => i.hasEOL));
        },
      }) });
      const elapsed = [];
      const results = [];
      try {
        for (const query of queries) {
          const start = performance.now();
          const hits = [];
          for await (const { page } of scanFromOrigin(pdf.numPages, { pageNo: 1, topY: Infinity }, query,
            n => scheduler.getTextContent(n), () => false, cache)) hits.push([page.pageNo, page.ranges, page.snippet]);
          elapsed.push(performance.now() - start);
          results.push(hits);
        }
        reference ??= results;
        deepStrictEqual(results, reference);
        samples[Number(enabled)].push(elapsed);
        if (round === 5 && enabled) console.log("pages", pdf.numPages, "estimated search cache bytes", cache.used);
      } finally {
        scheduler.dispose();
        await task.destroy();
      }
    }
  }
  console.table(queries.map((query, i) => {
    const median = runs => {
      const times = runs.map(row => row[i]).sort((a, b) => a - b);
      return Math.round((times[2] + times[3]) / 2);
    };
    return { query, hits: reference[i].reduce((n, [,r]) => n+r.length, 0),
      uncachedMs: median(samples[0]), cachedMs: median(samples[1]) };
  }));
} finally {
  await server.close();
}
