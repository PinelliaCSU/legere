// M08 · 当前文献内搜索（docs/03 M08）。
//
// 与库级检索的区别：这里是**字面量子串匹配**（中文不分词），因为读者在找「页面上看到的字」；
// 分词匹配只适用于库级召回。

import { BoundedLru } from "../../render/lru";
import type { TextContentHandle } from "../../pdf-engine/types";

export interface DocSearchHit {
  pageNo: number;
  /// 页内字符区间（左闭右开，基于 TextContentHandle.text）。
  ranges: [number, number][];
  /// 命中上下文（用于结果列表一行展示）。
  snippet: string;
}

const SNIPPET_RADIUS = 18;

const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
const softHyphen = "\u00ad";

// Every output UTF-16 unit points back to the original PDF.js text.
// A discretionary hyphen can match either a typed hyphen or no character.
function fold(input: string) {
  let text = "";
  // Most normalized UTF-16 offsets equal the originals. Store only changes in the two deltas.
  const shifts: { at: number; startDelta: number; endDelta: number }[] = [];
  let startDelta = 0;
  let endDelta = 0;
  for (const token of input.matchAll(/\s+|./gsu)) {
    const start = token.index;
    const raw = token[0];
    const end = start + raw.length;
    let value = raw;
    if (/^\s/u.test(raw)) {
      value = " ";
      if (/[\r\n]/.test(raw)) {
        const previous = text.at(-1) ?? "";
        if (/[-‐]/u.test(previous) && /\p{L}$/u.test(text.slice(-3, -1)) && /^\p{L}/u.test(input.slice(end, end + 2))) {
          text = text.slice(0, -1) + softHyphen;
          continue;
        }
        if (previous === softHyphen || (cjk.test(text.slice(-2)) && cjk.test(String.fromCodePoint(input.codePointAt(end) ?? 0)))) {
          continue;
        }
      }
    } else {
      const code = raw.codePointAt(0)!;
      value = (code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : raw).toLowerCase();
    }
    text += value;
    for (let i = 0; i < value.length; i++) {
      const at = text.length - value.length + i;
      if (start - at !== startDelta || end - at - 1 !== endDelta) {
        startDelta = start - at;
        endDelta = end - at - 1;
        shifts.push({ at, startDelta, endDelta });
      }
    }
  }
  return { text, shifts };
}

type SearchText = ReturnType<typeof fold>;

export function createSearchTextCache() {
  return new BoundedLru<SearchText>(8 * 1024 * 1024);
}

function originalOffset(page: SearchText, at: number, end: boolean): number {
  let low = 0;
  let high = page.shifts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (page.shifts[mid]!.at <= at) low = mid + 1;
    else high = mid;
  }
  const shift = page.shifts[low - 1];
  return end ? at + 1 + (shift?.endDelta ?? 0) : at + (shift?.startDelta ?? 0);
}

export function normalizeForKey(input: string): string {
  return fold(input).text.replaceAll(softHyphen, "");
}

export function findInPage(text: string, query: string): [number, number][] {
  const needle = normalizeForKey(query.trim());
  return needle ? matchPage(fold(text), needle) : [];
}

function matchPage(page: SearchText, needle: string): [number, number][] {
  if (!needle) return [];
  const ranges: [number, number][] = [];
  const discretionary = page.text.includes(softHyphen);
  let from = 0;
  while (from < page.text.length) {
    if (!discretionary) {
      const start = page.text.indexOf(needle, from);
      if (start < 0) break;
      from = start + needle.length;
      ranges.push([originalOffset(page, start, false), originalOffset(page, from - 1, true)]);
      continue;
    }
    let start = page.text.indexOf(needle[0]!, from);
    if (needle.startsWith("-") || needle.startsWith("‐")) {
      const optional = page.text.indexOf(softHyphen, from);
      if (optional >= 0 && (start < 0 || optional < start)) start = optional;
    }
    if (start < 0) break;
    let end = start;
    let matched = 0;
    while (matched < needle.length && end < page.text.length) {
      const ch = page.text[end];
      if (ch === needle[matched] || (ch === softHyphen && /[-‐]/u.test(needle[matched]!))) {
        matched++;
      } else if (ch !== softHyphen) {
        break;
      }
      end++;
    }
    if (matched === needle.length) {
      ranges.push([originalOffset(page, start, false), originalOffset(page, end - 1, true)]);
      from = end;
    } else {
      from = start + 1;
    }
  }
  return ranges;
}

/// 取命中附近的一行上下文。
export function snippetAt(text: string, start: number, end: number): string {
  const from = Math.max(0, start - SNIPPET_RADIUS);
  const to = Math.min(text.length, end + SNIPPET_RADIUS);
  const head = from > 0 ? "…" : "";
  const tail = to < text.length ? "…" : "";
  return head + text.slice(from, to).replace(/[\r\n]+/g, " ") + tail;
}

/// 逐页搜索（页数上限由调用方控制，避免一次性扫完超大文档）。
export function searchPages(
  pages: { pageNo: number; content: TextContentHandle }[],
  query: string,
): DocSearchHit[] {
  const hits: DocSearchHit[] = [];
  for (const page of pages) {
    const ranges = findInPage(page.content.text, query);
    if (ranges.length === 0) continue;
    const first = ranges[0];
    hits.push({
      pageNo: page.pageNo,
      ranges,
      snippet: first === undefined ? "" : snippetAt(page.content.text, first[0], first[1]),
    });
  }
  return hits;
}

export interface SearchCursor {
  pageNo: number;
  rangeIndex: number;
}

// Page groups are in scan order, which is document order rotated at the origin.
export function stepOccurrence(pages: DocSearchHit[], cursor: SearchCursor, delta: 1 | -1): SearchCursor {
  const pageIndex = pages.findIndex((page) => page.pageNo === cursor.pageNo);
  const page = pages[pageIndex]!;
  const index = cursor.rangeIndex + delta;
  if (index >= 0 && index < page.ranges.length) return { pageNo: page.pageNo, rangeIndex: index };
  const next = pages[(pageIndex + delta + pages.length) % pages.length]!;
  return { pageNo: next.pageNo, rangeIndex: delta === 1 ? 0 : next.ranges.length - 1 };
}

export interface SearchOrigin {
  pageNo: number;
  // PDF text coordinates run upwards. A baseline below this edge is visible or ahead.
  topY: number;
}

export async function* scanFromOrigin(
  pageCount: number,
  origin: SearchOrigin,
  query: string,
  read: (pageNo: number) => Promise<TextContentHandle>,
  cancelled: () => boolean,
  cache?: ReturnType<typeof createSearchTextCache>,
) {
  const needle = normalizeForKey(query.trim());
  if (!needle) return;
  let yieldedAt = performance.now();
  for (let offset = 0; offset < pageCount && !cancelled(); offset++) {
    // Cached reads resolve in microtasks. Give painting and cancellation a turn, even on misses.
    if (performance.now() - yieldedAt >= 16) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (cancelled()) return;
      yieldedAt = performance.now();
    }
    const pageNo = (origin.pageNo - 1 + offset) % pageCount + 1;
    let indexed = cache?.get(pageNo);
    let content: TextContentHandle | undefined;
    if (!indexed) {
      content = await read(pageNo);
      if (cancelled()) return;
      indexed = fold(content.text);
      const bytes = 128 + indexed.text.length * 2 + indexed.shifts.length * 64;
      if (cache && bytes <= cache.budgetBytes) {
        cache.set(pageNo, indexed, bytes);
        cache.evict();
      }
    }
    const ranges = matchPage(indexed, needle);
    if (!ranges[0]) continue;
    content ??= await read(pageNo);
    if (cancelled()) return;
    const page = { pageNo, ranges, snippet: snippetAt(content.text, ...ranges[0]) };

    let firstAhead = 0;
    if (offset === 0) {
      const { items, itemStarts } = content;
      let item = 0;
      firstAhead = page.ranges.findIndex(([, end]) => {
        while (item + 1 < items.length && itemStarts[item + 1]! < end) item++;
        return (items[item]?.y ?? 0) <= origin.topY;
      });
    }
    yield { page, firstAhead };
  }
}
