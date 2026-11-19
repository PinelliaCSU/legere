// 文件名清洗（v0.11 需求 3）——**只作用于显示层**。
//
// 磁盘文件名与库里存的 file_name 一律不动：磁盘改名会让下一次扫描把它当成新文件，
// 已建立的索引、书签、阅读进度随之失效，而且无法撤销。
//
// 清洗刻意保守：宁可留下一个可疑字符，也不要把有意义的数字/括号删掉
// （「第 2 卷」「(上册)」「2024 综述」都必须原样保留）。

/// 括号组内容命中这些词才整组删除。键已去掉分隔符并小写。
const NOISE_WORDS: ReadonlySet<string> = new Set([
  "pdf", "epub", "mobi", "azw3", "ebook", "电子书", "电子版", "高清", "高清版",
  "扫描版", "影印版", "文字版", "完整版", "清晰版", "下载", "免费",
  "zlib", "zlibrary", "libgen", "副本", "复制", "copy", "final", "存档", "精校版",
]);

/// (…)/（…）/[…]/【…】 括号组；内容 1–24 字符，且不允许再嵌套括号。
/// 连带括号两侧的空白一起匹配：删掉括号后不会在「书」和「名」之间留下两个空格。
const BRACKET_RE = /\s*[\[【(（]([^\[\]【】()（）]{1,24})[\]】)）]\s*/g;

/// 只认最后一段 1–4 位字母扩展名：末尾的 .pdf 去掉，v1.2 综述 这种真书名里的点不能碰。
const EXT_RE = /\.(pdf|epub|mobi|azw3?|djvu|chm|txt|docx?|xps|html?)$/i;

/// 网址残留（下载站默认会把站点名写进文件名）。
const URL_RES: readonly RegExp[] = [
  /\bhttps?:\/\/\S+/gi,
  /\bwww\.\S+/gi,
  /\b[\w-]+\.(?:com|cn|org|net|io|cc|me|top|xyz|info|tv)\b(?:\/\S*)?/gi,
];

/// 去掉扩展名；没有可识别的扩展名时原样返回。
export function stripExtension(fileName: string): string {
  const trimmed = fileName.trim();
  const stripped = trimmed.replace(EXT_RE, "");
  return stripped.length > 0 ? stripped : trimmed;
}

function normalizeToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s._-]+/g, "");
}

/// 括号组是不是噪声：已知噪声词，或者纯数字（(1) (2) 这类副本序号）。
export function isNoiseBracket(raw: string): boolean {
  const token = normalizeToken(raw);
  if (token.length === 0) return true;
  if (/^\d{1,4}$/.test(token)) return true;
  return NOISE_WORDS.has(token);
}

/// 括号外侧最近的非空白字符（用于判断删掉后要不要补空格）。
function neighbour(text: string, from: number, step: -1 | 1): string {
  let i = from;
  while (i >= 0 && i < text.length) {
    const ch = text[i];
    if (ch === undefined) break;
    if (ch !== " " && ch !== "\t") return ch;
    i += step;
  }
  return "";
}

const CJK_RE = /[\u4e00-\u9fff]/;

/// 删括号噪声：「文献讲稿[zlib]」→「文献讲稿」；「经济学(上册)」保持不动。
/// 两侧都是汉字时不留空格（「书 [pdf] 名」→「书名」），否则留一个空格（英文标题需要词间距）。
export function stripNoiseBrackets(text: string): string {
  return text.replace(BRACKET_RE, (whole: string, inner: string, offset: number, all: string) => {
    if (!isNoiseBracket(inner)) return whole;
    const before = neighbour(all, offset - 1, -1);
    const after = neighbour(all, offset + whole.length, 1);
    return CJK_RE.test(before) && CJK_RE.test(after) ? "" : " ";
  });
}

export function stripUrlNoise(text: string): string {
  let out = text;
  for (const re of URL_RES) out = out.replace(re, " ");
  return out;
}

/// 去掉开头的序号（「01_」「3. 」「(2) 」）。只在删完还剩下至少两个字时生效，
/// 否则「1984」这种整本都是数字的书名会被清空。
export function stripLeadingOrdinal(text: string): string {
  const m = /^\s*(?:[（(]\d{1,4}[)）]|\d{1,4}|[一二三四五六七八九十]{1,3})[\s._\-、·:：]+/.exec(text);
  if (m === null) return text;
  const rest = text.slice(m[0].length);
  return rest.replace(/[^\p{L}\p{N}]/gu, "").length >= 2 ? rest : text;
}

/// 显示层文件名清洗。结果为空（或只剩标点）时回退到「去扩展名的原名」。
export function cleanTitle(fileName: string): string {
  const base = stripExtension(fileName);
  if (base.length === 0) return fileName;

  let text = stripUrlNoise(base);
  text = stripNoiseBrackets(text);
  text = stripLeadingOrdinal(text);
  text = text.replace(/_+/g, " ").replace(/\s+/g, " ");
  text = text.replace(/^[\s\-_.·,，、:：]+/, "").replace(/[\s\-_.·,，、:：]+$/, "").trim();

  return text.replace(/[^\p{L}\p{N}]/gu, "").length === 0 ? base.trim() : text;
}

/// 列表/书脊用的显示标题：优先 PDF 元数据标题（作者自己填的，是有意义信息，不清洗），
/// 元数据缺失时才回退到清洗后的文件名。
export function displayTitle(pdfTitle: string | null, fileName: string): string {
  const meta = pdfTitle?.trim() ?? "";
  return meta.length > 0 ? meta : cleanTitle(fileName);
}
