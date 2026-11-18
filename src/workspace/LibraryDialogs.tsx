// M14 · 文献库（库根）的「更改 / 替换 / 移除」浮层（docs/05 §13 R22 / R23）。
//
// 为什么是应用内浮层：docs/16 §5「确认框用应用内浮层，不用系统原生弹窗」，
// 且 WebView2 不支持 window.prompt（AppShell 的添加库根输入框就是因此改成应用内的）。

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { CMD } from "../contracts/cmd";
import type { LibraryRootDto } from "../contracts/types";
import { call } from "../core/ipc";
import { normalizeRootName, normalizeRootPathInput, rootLabel, rootNameError, rootReplaceBody } from "./library-roots";

interface RootDialogProps {
  root: LibraryRootDto;
  onClose: () => void;
  onDone: (message: string) => void;
}

/// 更改：只改显示名。换文件夹走「替换」，避免一次操作同时动名字和内容。
export function RootRenameDialog({ root, onClose, onDone }: RootDialogProps): ReactElement {
  const [name, setName] = useState(root.displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const submit = useCallback(async () => {
    const problem = rootNameError(name);
    if (problem !== null) {
      setError(problem);
      return;
    }
    const value = normalizeRootName(name);
    if (value === null || busy) return;
    if (value === root.displayName.trim()) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await call(CMD.LIBRARY_ROOT_UPDATE, { id: root.id, displayName: value });
      onDone("已更改文献库名称");
    } catch (err) {
      const e = err as { code?: string; detail?: string };
      setError((e.code ?? "E_INTERNAL") + (e.detail ? " — " + e.detail : ""));
    } finally {
      setBusy(false);
    }
  }, [busy, name, onClose, onDone, root.displayName, root.id]);

  return (
    <div className="lg-overlay" role="dialog" aria-modal="true" aria-label="更改文献库">
      <div className="lg-overlay-panel lg-dialog">
        <h2 className="lg-dialog-title">更改文献库</h2>
        <p className="lg-dialog-body">
          只改显示名。要换文件夹请用【替换】—— 换文件夹等于换内容，旧的文献记录必须一并清除。
        </p>
        <p className="lg-dialog-sub lg-muted">{root.path}</p>
        <label className="lg-field">
          <span className="lg-field-label">显示名</span>
          <input
            ref={inputRef}
            className="lg-field-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              if (e.key === "Escape") onClose();
            }}
          />
        </label>
        {error !== null ? <p className="lg-dialog-error">{error}</p> : null}
        <div className="lg-dialog-actions">
          <button type="button" className="lg-btn lg-btn-primary" disabled={busy} onClick={() => void submit()}>
            保存
          </button>
          <button type="button" className="lg-btn" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

/// 替换：把库根指向新文件夹。旧文档记录由后端在同一事务里删除（R23）。
export function RootReplaceDialog({ root, onClose, onDone }: RootDialogProps): ReactElement {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const submit = useCallback(async () => {
    const value = normalizeRootPathInput(path);
    if (value === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const replaced = await call(CMD.LIBRARY_ROOT_REPLACE, { id: root.id, path: value }, { timeoutMs: 60_000 });
      onDone("已替换文献库，正在扫描新文件夹");
      // 扫描与「添加文献库」同一条路径：命令只改库根，扫描单独发起。
      await call(CMD.LIBRARY_SCAN_START, { rootId: replaced.id }).catch(() => undefined);
    } catch (err) {
      const e = err as { code?: string; detail?: string };
      setError((e.code ?? "E_INTERNAL") + (e.detail ? " — " + e.detail : ""));
    } finally {
      setBusy(false);
    }
  }, [busy, onDone, path, root.id]);

  return (
    <div className="lg-overlay" role="dialog" aria-modal="true" aria-label="替换文献库">
      <div className="lg-overlay-panel lg-dialog">
        <h2 className="lg-dialog-title">替换文献库</h2>
        <p className="lg-dialog-body">{rootReplaceBody(rootLabel(root))}</p>
        <label className="lg-field">
          <span className="lg-field-label">新文件夹的绝对路径</span>
          <input
            ref={inputRef}
            className="lg-field-input"
            value={path}
            placeholder="例如 D:\Papers"
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              if (e.key === "Escape") onClose();
            }}
          />
        </label>
        {error !== null ? <p className="lg-dialog-error">{error}</p> : null}
        <div className="lg-dialog-actions">
          <button type="button" className="lg-btn lg-btn-primary" disabled={busy || normalizeRootPathInput(path) === null} onClick={() => void submit()}>
            替换
          </button>
          <button type="button" className="lg-btn" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

/// 移除：文案直接取 docs/16 §5 的既有条目，不另造。
export function RootRemoveDialog({ root, onClose, onDone }: RootDialogProps): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await call(CMD.LIBRARY_ROOT_REMOVE, { id: root.id, purge: false });
      onDone("已移除文献库");
    } catch (err) {
      const e = err as { code?: string; detail?: string };
      setError((e.code ?? "E_INTERNAL") + (e.detail ? " — " + e.detail : ""));
    } finally {
      setBusy(false);
    }
  }, [busy, onDone, root.id]);

  return (
    <div className="lg-overlay" role="dialog" aria-modal="true" aria-label="移除文献库">
      <div className="lg-overlay-panel lg-dialog">
        <h2 className="lg-dialog-title">移除这个文献库？</h2>
        <p className="lg-dialog-body">不会删除磁盘上的任何文件。可用【添加文献库】重新加入。</p>
        <p className="lg-dialog-sub lg-muted">{root.path}</p>
        {error !== null ? <p className="lg-dialog-error">{error}</p> : null}
        <div className="lg-dialog-actions">
          <button type="button" className="lg-btn lg-btn-primary" disabled={busy} onClick={() => void submit()}>
            移除
          </button>
          <button type="button" className="lg-btn" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
