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
  /// 正在编辑的书签（null = 没有在编辑）。
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftNote, setDraftNote] = useState("");

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

  const startEdit = useCallback((item: BookmarkDto) => {
    setEditingId(item.id);
    setDraftTitle(item.title);
    setDraftNote(item.note ?? "");
  }, []);

  /// 保存标题与备注（bookmark_update 契约早就存在，之前界面没接）。
  /// 空字符串一律存成 null：避免「清空备注」变成一条空白字符串。
  const saveEdit = useCallback(
    async (id: number) => {
      const title = draftTitle.trim();
      const note = draftNote.trim();
      try {
        await call(CMD.BOOKMARK_UPDATE, {
          id,
          ...(title === "" ? {} : { title }),
          note: note === "" ? null : note,
        });
        setEditingId(null);
        await reload();
      } catch (err) {
        const e = err as { code?: string; detail?: string };
        setStatus("保存失败：" + (e.code ?? "E_INTERNAL") + (e.detail ? " — " + e.detail : ""));
      }
    },
    [draftNote, draftTitle, reload],
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
        {items.map((item) =>
          editingId === item.id ? (
            <li key={item.id} className="lg-bookmark is-editing">
              <span className="lg-muted">p{item.pageNo}</span>
              <input
                className="lg-bookmark-input"
                value={draftTitle}
                placeholder="标题"
                onChange={(e) => setDraftTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveEdit(item.id);
                  if (e.key === "Escape") setEditingId(null);
                }}
              />
              <input
                className="lg-bookmark-input"
                value={draftNote}
                placeholder="备注（可留空）"
                onChange={(e) => setDraftNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveEdit(item.id);
                  if (e.key === "Escape") setEditingId(null);
                }}
              />
              <button type="button" className="lg-btn lg-btn-primary" onClick={() => void saveEdit(item.id)}>
                保存
              </button>
              <button type="button" className="lg-btn" onClick={() => setEditingId(null)}>
                取消
              </button>
            </li>
          ) : (
            <li key={item.id} className="lg-bookmark">
              <button type="button" className="lg-bookmark-go" onClick={() => onJump(item.pageNo)}>
                <span className="lg-bookmark-title">p{item.pageNo} · {item.title}</span>
                {item.note !== null && item.note !== "" ? (
                  <span className="lg-bookmark-note">{item.note}</span>
                ) : null}
              </button>
              <button
                type="button"
                className="lg-icon-btn"
                title="编辑标题与备注"
                onClick={() => startEdit(item)}
              >
                ✎
              </button>
              <button type="button" className="lg-icon-btn" title="删除" onClick={() => void remove(item.id)}>
                ×
              </button>
            </li>
          ),
        )}
        {items.length === 0 && status === "" ? <li className="lg-muted">还没有书签</li> : null}
      </ul>
    </aside>
  );
}
