import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LibraryTree } from "./LibraryTree";
import { buildForest, flattenFolders, type FolderDoc } from "./library-tree";

const docs: FolderDoc[] = [
  { documentId: 1, libraryRootId: 7, relPath: "哲学/中国哲学/先秦.pdf" },
  { documentId: 2, libraryRootId: 7, relPath: "哲学/中国哲学/两汉.pdf" },
  { documentId: 3, libraryRootId: 7, relPath: "哲学/西方/古希腊.pdf" },
  { documentId: 4, libraryRootId: 7, relPath: "散篇.pdf" },
];

function render(expanded: string[], selected: { rootId: number; path: string } | null = null): string {
  const forest = buildForest([{ id: 7, label: "论文库" }], docs);
  return renderToStaticMarkup(
    createElement(LibraryTree, {
      rows: flattenFolders(forest, new Set(expanded)),
      totalCount: docs.length,
      selected,
      onSelectAll: () => undefined,
      onSelectRow: () => undefined,
      onToggleRow: () => undefined,
    }),
  );
}

describe("文献库文件夹树真实渲染（需求 2）", () => {
  it("始终有「全部文献」行，并带上总本数", () => {
    const html = render([]);
    expect(html).toContain("全部文献");
    expect(html).toContain(">4<");
  });

  it("折叠时只有库根一层，展开后逐层出现（层级缩进随 depth 增加）", () => {
    // 库根恒展开：默认就能看到第一层子文件夹
    expect((render([]).match(/data-folder-row/g) ?? []).length).toBe(2);
    expect(render([])).toContain("哲学");
    expect(render([])).not.toContain("中国哲学");

    const html = render(["7:哲学"]);
    expect((html.match(/data-folder-row/g) ?? []).length).toBe(4);
    expect(html).toContain('data-depth="1"');
    expect(html).toContain('data-depth="2"');
    expect(html).toContain("中国哲学");
    expect(html).toContain("西方");
  });

  it("有子文件夹的行显示展开箭头：折叠▸、展开▾，叶子行没有箭头", () => {
    // 只有库根（恒展开）与「哲学」（折叠且有子目录）各带一个箭头
    const collapsed = render([]);
    expect((collapsed.match(/▸/g) ?? []).length).toBe(1);
    expect((collapsed.match(/▾/g) ?? []).length).toBe(1);

    const opened = render(["7:哲学"]);
    expect((opened.match(/▸/g) ?? []).length).toBe(0);
    expect((opened.match(/▾/g) ?? []).length).toBe(2);
  });

  it("选中的文件夹带 is-active，其余不带", () => {
    const html = render(["7:哲学"], { rootId: 7, path: "哲学" });
    const activeCount = (html.match(/lg-tree-row is-active/g) ?? []).length;
    expect(activeCount).toBe(1);
  });
});
