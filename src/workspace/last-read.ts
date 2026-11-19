// 「上次阅读」版块与启动续读（v0.11 需求 5）的纯逻辑。
//
// 约定：打开书时把 id 写进设置 reader.lastDocumentId，从阅读器退回主页时清空。
// 于是「退出应用时仍在阅读器里」等价于该设置还在，下次启动就能回到那本书；
// 阅读进度本身仍由 reading_progress 表负责，这里不重复存。

export const LAST_READ_SETTING_KEY = "reader.lastDocumentId";

export interface LastReadDoc {
  documentId: number;
  title: string;
  author: string | null;
  pageCount: number | null;
  progressPage: number | null;
  lastOpenedAt: string | null;
}

/// 设置值是字符串：解析不出正整数就当没设过（空串 = 用户主动清空）。
export function parseLastDocumentId(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const id = Number(trimmed);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/// 上次阅读 = 最近一次「打开过」的那本（last_opened_at 最大）。
/// 从没打开过的书不参与，否则新导入的书会挤掉真正的上次阅读。
export function pickLastRead(docs: readonly LastReadDoc[]): LastReadDoc | null {
  let best: LastReadDoc | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const doc of docs) {
    if (doc.lastOpenedAt === null) continue;
    const at = Date.parse(doc.lastOpenedAt);
    if (!Number.isFinite(at)) continue;
    if (at > bestAt) {
      bestAt = at;
      best = doc;
    }
  }
  return best;
}

/// 相对时间：一个月内说「x 分钟/小时/天前」，更久给日期（不做 i18n）。
export function relativeTime(iso: string | null, now: Date): string {
  if (iso === null) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.floor((now.getTime() - at) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return minutes + " 分钟前";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + " 小时前";
  const days = Math.floor(hours / 24);
  if (days < 30) return days + " 天前";
  const d = new Date(at);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + mm + "-" + dd;
}

/// 卡片第二行：作者 + 进度 + 上次阅读时间（缺哪项就少哪项）。
export function lastReadMeta(doc: LastReadDoc, now: Date): string {
  const parts: string[] = [];
  if (doc.author !== null && doc.author.trim().length > 0) parts.push(doc.author.trim());
  if (doc.progressPage !== null && doc.pageCount !== null) {
    parts.push("读到第 " + doc.progressPage + " / " + doc.pageCount + " 页");
  } else if (doc.pageCount !== null) {
    parts.push("共 " + doc.pageCount + " 页");
  }
  const when = relativeTime(doc.lastOpenedAt, now);
  if (when.length > 0) parts.push(when);
  return parts.join(" · ");
}
