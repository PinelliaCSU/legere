// ApiErrorCode 是前端唯一可分支的错误标识（docs/05-api-contracts.md §1）。
// message 只用于展示兜底，禁止用 message 做逻辑判断（见 05 §1）。

export type ApiErrorCode =
  | "E_INVALID_ARG"
  | "E_NOT_FOUND"
  | "E_DB"
  | "E_IO"
  | "E_PERMISSION"
  | "E_PDF_CORRUPT"
  | "E_PDF_ENCRYPTED"
  | "E_PDF_NO_TEXT"
  | "E_BUSY"
  | "E_UNSUPPORTED"
  | "E_CANCELED"
  | "E_INTERNAL";

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  detail?: string;
  retriable: boolean;
}

export const API_ERROR_CODES: readonly ApiErrorCode[] = [
  "E_INVALID_ARG",
  "E_NOT_FOUND",
  "E_DB",
  "E_IO",
  "E_PERMISSION",
  "E_PDF_CORRUPT",
  "E_PDF_ENCRYPTED",
  "E_PDF_NO_TEXT",
  "E_BUSY",
  "E_UNSUPPORTED",
  "E_CANCELED",
  "E_INTERNAL",
] as const;

// 文案来源：docs/16-copy-deck.md §1（已冻结）。前端按 code 覆盖后端 message，避免文案散落在组件里。
export const API_ERROR_TEXT: Record<ApiErrorCode, string> = {
  E_INVALID_ARG: "参数不合法",
  E_NOT_FOUND: "找不到该文献",
  E_DB: "数据库错误",
  E_IO: "读写文件失败",
  E_PERMISSION: "没有访问权限",
  E_PDF_CORRUPT: "这个 PDF 已损坏，无法打开",
  E_PDF_ENCRYPTED: "这个 PDF 有密码保护，暂不支持打开",
  E_PDF_NO_TEXT: "这个 PDF 没有可提取的文字（扫描版），无法全文检索",
  E_BUSY: "已有相同任务在进行",
  E_UNSUPPORTED: "当前环境不支持该功能",
  E_CANCELED: "已取消",
  E_INTERNAL: "出现内部错误",
};

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && (API_ERROR_CODES as readonly string[]).includes(value);
}

export function isApiError(value: unknown): value is ApiError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isApiErrorCode(candidate["code"]) && typeof candidate["message"] === "string";
}

export function apiErrorText(error: ApiError): string {
  return API_ERROR_TEXT[error.code] || error.message;
}
