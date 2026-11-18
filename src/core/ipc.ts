// IPC 客户端（docs/05-api-contracts.md §5）。
// 职责：把 Tauri 的原始错误归一化为 ApiError、加超时、去重事件订阅。
// 禁止任何模块绕过本文件直接 import invoke。

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CommandMap, CmdName } from "../contracts/cmd";
import type { EventMap } from "../contracts/evt";
import { API_ERROR_TEXT, isApiError, type ApiError, type ApiErrorCode } from "../contracts/errors";

const DEFAULT_TIMEOUT_MS = 15_000;

export class IpcError extends Error implements ApiError {
  readonly code: ApiErrorCode;
  readonly detail?: string;
  readonly retriable: boolean;

  constructor(error: ApiError) {
    super(error.message);
    this.name = "IpcError";
    this.code = error.code;
    this.retriable = error.retriable;
    if (error.detail !== undefined) this.detail = error.detail;
  }
}

// Tauri 会以 JSON 字符串或普通对象抛出错误；两种都要能识别，否则会丢 code。
export function normalizeError(raw: unknown): ApiError {
  if (isApiError(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isApiError(parsed)) return parsed;
    } catch {
      // 非 JSON：落到兜底分支，不吞掉原文。
    }
    return { code: "E_INTERNAL", message: API_ERROR_TEXT.E_INTERNAL, detail: raw, retriable: true };
  }
  if (typeof raw === "object" && raw !== null) {
    const rec = raw as Record<string, unknown>;
    if (typeof rec["code"] === "string") {
      const code = rec["code"];
      if (isApiError({ code, message: "x" })) {
        return {
          code: code as ApiErrorCode,
          message: typeof rec["message"] === "string" ? rec["message"] : API_ERROR_TEXT[code as ApiErrorCode],
          ...(typeof rec["detail"] === "string" ? { detail: rec["detail"] } : {}),
          retriable: rec["retriable"] === true,
        };
      }
    }
    return { code: "E_INTERNAL", message: API_ERROR_TEXT.E_INTERNAL, detail: String(rec["message"] ?? ""), retriable: true };
  }
  return { code: "E_INTERNAL", message: API_ERROR_TEXT.E_INTERNAL, detail: String(raw), retriable: true };
}

export async function call<K extends CmdName>(
  name: K,
  args: CommandMap[K]["args"],
  opts?: { timeoutMs?: number },
): Promise<CommandMap[K]["result"]> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject({
        code: "E_INTERNAL",
        message: API_ERROR_TEXT.E_INTERNAL,
        detail: `timeout after ${timeoutMs}ms: ${name}`,
        retriable: true,
      } satisfies ApiError);
    }, timeoutMs);
  });

  try {
    return (await Promise.race([
      invoke<CommandMap[K]["result"]>(name, args as Record<string, unknown>),
      timeout,
    ])) as CommandMap[K]["result"];
  } catch (raw) {
    throw new IpcError(normalizeError(raw));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const subscriptions = new Map<string, { count: number; unlisten: UnlistenFn | null }>();

// 重复订阅同一事件必须复用同一个底层 listen（05 §4 第 3 条）。
export async function subscribe<E extends keyof EventMap>(
  event: E,
  handler: (payload: EventMap[E]) => void,
): Promise<() => void> {
  const key = String(event);
  const existing = subscriptions.get(key);
  const entry = existing ?? { count: 0, unlisten: null as UnlistenFn | null };
  if (!existing) subscriptions.set(key, entry);
  entry.count += 1;

  const unlisten = await listen<EventMap[E]>(key, (evt) => handler(evt.payload));
  // 并发订阅时可能已经有别的 unlisten：保留一个即可，最后一人摘除时统一清理。
  if (entry.unlisten === null) entry.unlisten = unlisten;

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const current = subscriptions.get(key);
    if (!current) return;
    current.count -= 1;
    if (current.count <= 0) {
      current.unlisten?.();
      subscriptions.delete(key);
    }
  };
}
