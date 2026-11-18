// M08 · 当前文献内搜索（docs/03 M08）。
//
// 与库级检索的区别：这里是**字面量子串匹配**（中文不分词），因为读者在找「页面上看到的字」；
// 分词匹配只适用于库级召回。

import type { TextContentHandle } from "../../pdf-engine/types";

export interface DocSearchHit {
  pageNo: number;
  /// 页内字符区间（左闭右开，基于 TextContentHandle.text）。
  ranges: [number, number][];
  /// 命中上下文（用于结果列表一行展示）。
  snippet: string;
}

const SNIPPET_RADIUS = 18;
const MAX_HITS_PER_PAGE = 200;

/// 归一化：全角转半角 + 小写（等长映射，保证区间可映射回原文）。
export function normalizeForKey(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0xff01 && code <= 0xff5e) {
      // 全角不仅转半角，还必须折叠大小写，否则查询与文本两侧不对称。
      out += String.fromCodePoint(code - 0xfee0).toLowerCase();
    } else if (code === 0x3000) {
      out += " ";
    } else {
      out += ch.toLowerCase();
    }
  }
  return out;
}

/// 在单页文本里找全部命中（区间基于原文索引；归一化等长才能这么做）。
export function findInPage(text: string, query: string): [number, number][] {
  const q = normalizeForKey(query.trim());
  if (q.length === 0) return [];
  const haystack = normalizeForKey(text);
  const out: [number, number][] = [];
  let from = 0;
  while (out.length < MAX_HITS_PER_PAGE) {
    const idx = haystack.indexOf(q, from);
    if (idx < 0) break;
    out.push([idx, idx + q.length]);
    from = idx + q.length;
  }
  return out;
}

/// 取命中附近的一行上下文。
export function snippetAt(text: string, start: number, end: number): string {
  const chars = [...text];
  const from = Math.max(0, start - SNIPPET_RADIUS);
  const to = Math.min(chars.length, end + SNIPPET_RADIUS);
  const head = from > 0 ? "…" : "";
  const tail = to < chars.length ? "…" : "";
  return head + chars.slice(from, to).join("").replace(/[\r\n]+/g, " ") + tail;
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
