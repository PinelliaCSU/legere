// M14 · 文献库（库根）管理的纯逻辑（docs/05 §13 R22 / R23）。
//
// 只放能在 node 环境单测的东西：输入归一化、校验、确认文案。
// 交互与 IO 在 LibraryDialogs.tsx / AppShell.tsx。

import type { LibraryRootDto } from "../contracts/types";

/// 表单里的显示名 -> 提交值：trim 后为空视为「没填」，由调用方拦下（不允许清空名称）。
export function normalizeRootName(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/// 校验显示名：返回 null 表示通过，否则返回给用户看的错误。
export function rootNameError(raw: string): string | null {
  const name = normalizeRootName(raw);
  if (name === null) return "文献库名称不能为空";
  if (name.length > 120) return "文献库名称过长（最多 120 字）";
  return null;
}

/// 表单里的路径 -> 提交值：只做 trim；绝对化/规范化由后端 ensure_root_dir 负责。
export function normalizeRootPathInput(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/// 列表里显示的名字：displayName 为空时回退到路径末段（库根可能被手工改坏）。
export function rootLabel(root: Pick<LibraryRootDto, "displayName" | "path">): string {
  const name = root.displayName.trim();
  if (name.length > 0) return name;
  const normalized = root.path.replace(/[\\/]+$/, "");
  const last = normalized.split(/[\\/]/).pop();
  return last !== undefined && last.length > 0 ? last : root.path;
}

/// 替换确认正文（docs/16 §5「替换文献库」一行）：必须同时说清
/// 「旧文献记录被删除」「磁盘文件不动」「会自动扫描」。
export function rootReplaceBody(displayName: string): string {
  return `把《${displayName}》指向新的文件夹。该文献库下现有的文献记录会被全部删除（索引、书签、阅读进度一并清除），磁盘上的原文件不会被删除。替换后会自动扫描新文件夹。`;
}
