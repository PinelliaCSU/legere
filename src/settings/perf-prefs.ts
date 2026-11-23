// 性能相关设置项（v0.13 新增）。值都是纯文本，与 reader-prefs 同一套约定（docs/15）。
//
// 两个键的区别：
//   · perf.idleTextPrefetchPages —— 空闲预取**文本**的页数，真实生效（P2-1，默认 0 关闭）。
//   · perf.preloadDocumentMax     —— 文档常驻预加载的本数上限，(待补充)：产品参数
//     （常驻几本 / 内存上限）尚未拍板，因此解析结果恒为 0 = 关闭，本轮只留占位不做行为。

export const PERF_IDLE_TEXT_PREFETCH_KEY = "perf.idleTextPrefetchPages";
export const PERF_PRELOAD_DOC_MAX_KEY = "perf.preloadDocumentMax";

/// 空闲预取的上限：再多也是在浪费文本缓存（64 MiB 预算，约 350 页）。
export const IDLE_TEXT_PREFETCH_MAX = 6;
/// (待补充) 文档常驻的上限占位；未定值前不接受任何非零配置。
export const PRELOAD_DOC_MAX_LIMIT = 0;

function parseCount(raw: string | null | undefined, max: number): number {
  if (raw === null || raw === undefined) return 0;
  const value = Number(raw.replace(/"/g, "").trim());
  if (!Number.isInteger(value) || value <= 0) return 0;
  return Math.min(value, max);
}

export function parseIdleTextPrefetch(raw: string | null | undefined): number {
  return parseCount(raw, IDLE_TEXT_PREFETCH_MAX);
}

/// (待补充) 恒为 0：产品参数缺失时不接受非零值，避免"配了却不生效"的静默假象。
export function parsePreloadDocMax(raw: string | null | undefined): number {
  return Math.min(parseCount(raw, PRELOAD_DOC_MAX_LIMIT), PRELOAD_DOC_MAX_LIMIT);
}

/// 点击档位：0（关闭）→ 2 → 4 → 0。与菜单里的一行按钮对应。
export function nextIdleTextPrefetch(current: number): number {
  if (current <= 0) return 2;
  return current >= 4 ? 0 : current + 2;
}

export function formatIdleTextPrefetch(pages: number): string {
  return pages <= 0 ? "关闭" : "+" + pages + " 页";
}
