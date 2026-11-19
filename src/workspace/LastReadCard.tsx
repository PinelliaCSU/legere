// 「上次阅读」卡片（v0.11 需求 5 的呈现层）。
//
// 同样只做展示：哪本书、读到第几页、多久以前，全部由 last-read.ts 的纯函数算好，
// now 也由调用方传入 —— 否则 SSR 断言会随运行时间漂移。

import type { ReactElement } from "react";

import { lastReadMeta, type LastReadDoc } from "./last-read";

export interface LastReadCardProps {
  doc: LastReadDoc;
  now: Date;
  onContinue: (documentId: number) => void;
}

export function LastReadCard({ doc, now, onContinue }: LastReadCardProps): ReactElement {
  return (
    <div className="lg-lastread">
      <span className="lg-lastread-head">上次阅读</span>
      <span className="lg-lastread-title" title={doc.title}>
        {doc.title}
      </span>
      <span className="lg-lastread-meta">{lastReadMeta(doc, now)}</span>
      <span className="lg-lastread-actions">
        <button type="button" className="lg-btn lg-btn-primary" onClick={() => onContinue(doc.documentId)}>
          继续阅读
        </button>
      </span>
    </div>
  );
}
