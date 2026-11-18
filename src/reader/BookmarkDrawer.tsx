// M12 · 书签面板（D26 抽屉样式：右侧滑入，不遮挡正文）。

import { useCallback, useEffect, useState, type ReactElement } from "react";

import { CMD } from "../contracts/cmd";
import type { BookmarkDto } from "../contracts/types";
import { call } from "../core/ipc";

interface BookmarkDrawerProps {
  documentId: number;
  currentPage: number;
  onJump: (pageNo: number) => void;
  onClose: () => void;
}

export function BookmarkDrawer({ documentId, currentPage, onJump, onClose }: BookmarkDrawerProps): ReactElement {
  const [items, setItems] = useState<BookmarkDto[]>([]);
  const [status, setStatus] = useState("");

  const reload = useCallback(async () => {
    try {
      setItems(await call(CMD.BOOKMARK_LIST, { documentId }));
    } catch (err) {
      const e = err as { code?: string };
      setStatus("读取书签失败：" + (e.code ?? "E_INTERNAL"));
    }
  }, [documentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const addCurrent = useCallback(async () => {
    try {
      await call(CMD.BOOKMARK_CREATE, {
        documentId,
        pageNo: currentPage,
        title: "第 " + currentPage + " 页",
        note: null,
        color: null,
      });
      await reload();
    } catch (err) {
      const e = err as { code?: string; detail?: string };
      setStatus("添加失败：" + (e.code ?? "E_INTERNAL") + (e.detail ? " — " + e.detail : ""));
    }
  }, [currentPage, documentId, reload]);

  const remove = useCallback(
    async (id: number) => {
      try {
        await call(CMD.BOOKMARK_DELETE, { id });
        await reload();
      } catch (err) {
        const e = err as { code?: string };
        setStatus("删除失败：" + (e.code ?? "E_INTERNAL"));
      }
    },
    [reload],
  );

  return (
    <aside className="lg-drawer" aria-label="书签">
      <header className="lg-drawer-head">
        <strong>书签</strong>
        <button type="button" className="lg-btn" onClick={onClose}>关闭</button>
      </header>
      <button type="button" className="lg-btn lg-btn-primary" onClick={() => void addCurrent()}>
        书签当前页（第 {currentPage} 页）
      </button>
      {status !== "" ? <p className="lg-muted">{status}</p> : null}
      <ul className="lg-drawer-list">
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" onClick={() => onJump(item.pageNo)}>
              p{item.pageNo} · {item.title}
            </button>
            <button type="button" className="lg-icon-btn" title="删除" onClick={() => void remove(item.id)}>
              ×
            </button>
          </li>
        ))}
        {items.length === 0 && status === "" ? <li className="lg-muted">还没有书签</li> : null}
      </ul>
    </aside>
  );
}
