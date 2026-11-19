// 文献库文件夹树（v0.11 需求 2 的呈现层）。
//
// 纯展示：行数据由 library-tree.ts 的 flattenFolders 算好，这里只管渲染与回调，
// 因此可以在 node 环境直接 SSR 断言（见 LibraryTree.test.tsx）。

import type { ReactElement } from "react";

import type { TreeRow } from "./library-tree";

export interface LibraryTreeProps {
  rows: readonly TreeRow[];
  /// 「全部文献」行的计数。
  totalCount: number;
  selected: { rootId: number; path: string } | null;
  onSelectAll: () => void;
  onSelectRow: (row: TreeRow) => void;
  onToggleRow: (row: TreeRow) => void;
}

export function LibraryTree({
  rows,
  totalCount,
  selected,
  onSelectAll,
  onSelectRow,
  onToggleRow,
}: LibraryTreeProps): ReactElement {
  const isSelected = (row: TreeRow): boolean =>
    selected !== null && selected.rootId === row.rootId && selected.path === row.path;

  return (
    <aside className="lg-tree" aria-label="文件夹">
      <h2 className="lg-tree-head">文件夹</h2>
      <ul className="lg-tree-list">
        <li>
          <button
            type="button"
            className={"lg-tree-row" + (selected === null ? " is-active" : "")}
            onClick={onSelectAll}
          >
            <span className="lg-tree-caret" aria-hidden="true" />
            <span className="lg-tree-name">全部文献</span>
            <span className="lg-tree-count">{totalCount}</span>
          </button>
        </li>
        {rows.map((row) => (
          <li key={row.key}>
            <button
              type="button"
              data-folder-row=""
              data-depth={row.depth}
              className={"lg-tree-row" + (isSelected(row) ? " is-active" : "")}
              style={{ paddingLeft: 8 + row.depth * 12 }}
              title={row.path.length > 0 ? row.path : row.name}
              onClick={() => onSelectRow(row)}
            >
              <span
                className="lg-tree-caret"
                aria-hidden="true"
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleRow(row);
                }}
              >
                {row.hasChildren ? (row.expanded ? "▾" : "▸") : ""}
              </span>
              <span className="lg-tree-name">{row.name}</span>
              <span className="lg-tree-count">{row.docCount}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
