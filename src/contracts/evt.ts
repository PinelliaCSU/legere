// 事件名与 payload（docs/05-api-contracts.md §4）。payload 一律是 DTO，禁止裸字符串。

import type { ApiError } from "./errors";
import type { IndexStatusDto } from "./types";

export const EVT = {
  APP_READY: "app://ready",
  LIBRARY_SCAN_PROGRESS: "library://scan-progress",
  LIBRARY_CHANGED: "library://changed",
  INDEX_PROGRESS: "index://progress",
  INDEX_JOB_FINISHED: "index://job-finished",
} as const;

export type EvtName = (typeof EVT)[keyof typeof EVT];

export interface ScanProgressEvent {
  rootId: number | null;
  phase: "walking" | "finalizing" | "done";
  scanned: number;
  added: number;
  updated: number;
  removed: number;
  error: ApiError | null;
}

export interface LibraryChangedEvent {
  kinds: ("added" | "updated" | "removed")[];
  documentIds: number[];
  rootId: number | null;
}

export interface IndexJobFinishedEvent {
  jobId: number;
  documentId: number;
  state: "done" | "failed" | "canceled";
  error: ApiError | null;
}

export interface EventMap {
  "app://ready": { version: string };
  "library://scan-progress": ScanProgressEvent;
  "library://changed": LibraryChangedEvent;
  "index://progress": IndexStatusDto;
  "index://job-finished": IndexJobFinishedEvent;
}
