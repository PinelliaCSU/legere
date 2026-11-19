import { describe, expect, it } from "vitest";

import { buildFolderTree, buildForest, flattenFolders, folderOf, inFolder, type FolderDoc } from "./library-tree";

const docs: FolderDoc[] = [
  { documentId: 1, libraryRootId: 7, relPath: "哲学/中国哲学/先秦.pdf" },
  { documentId: 2, libraryRootId: 7, relPath: "哲学/中国哲学/两汉.pdf" },
  { documentId: 3, libraryRootId: 7, relPath: "哲学/西方/古希腊.pdf" },
  { documentId: 4, libraryRootId: 7, relPath: "散篇.pdf" },
  { documentId: 5, libraryRootId: 9, relPath: "别库.pdf" },
];

describe("文件夹层级（需求 2）", () => {
  it("取所在目录：根下文件为空串", () => {
    expect(folderOf("哲学/中国哲学/先秦.pdf")).toBe("哲学/中国哲学");
    expect(folderOf("散篇.pdf")).toBe("");
  });

  it("按目录归属：含子文件夹，空路径命中全部", () => {
    expect(inFolder("哲学/中国哲学/先秦.pdf", "哲学")).toBe(true);
    expect(inFolder("哲学/中国哲学/先秦.pdf", "哲学/中国哲学")).toBe(true);
    expect(inFolder("哲学/西方/古希腊.pdf", "哲学/中国哲学")).toBe(false);
    expect(inFolder("散篇.pdf", "")).toBe(true);
  });

  it("建树：层级、计数（含子孙书籍）、排序", () => {
    const root = buildFolderTree(7, "论文库", docs);
    expect(root.docCount).toBe(4);
    expect(root.children.map((c) => c.name)).toEqual(["哲学"]);
    const philosophy = root.children[0];
    expect(philosophy?.docCount).toBe(3);
    const names = philosophy?.children.map((c) => c.name) ?? [];
    expect([...names].sort()).toEqual(["中国哲学", "西方"].sort());
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")));
    const chinese = philosophy?.children.find((c) => c.name === "中国哲学");
    expect(chinese?.docCount).toBe(2);
    expect(chinese?.path).toBe("哲学/中国哲学");
    // 别的库根的书不混进来
    expect(root.docCount).toBe(4);
  });

  it("展开成行：库根恒展开，折叠的子树不产出任何行", () => {
    const forest = buildForest([{ id: 7, label: "论文库" }], docs);
    const collapsed = flattenFolders(forest, new Set());
    expect(collapsed.map((r) => r.name)).toEqual(["论文库", "哲学"]);

    const open = flattenFolders(forest, new Set(["7:哲学"]));
    expect(open.map((r) => r.name).sort()).toEqual(["中国哲学", "哲学", "西方", "论文库"].sort());
    expect(open.find((r) => r.name === "哲学")?.expanded).toBe(true);
    // 折叠的孙子目录不能再出现
    const folded = flattenFolders(forest, new Set(["7:哲学", "7:哲学/中国哲学"]));
    expect(folded.filter((r) => r.depth === 2)).toHaveLength(2);
  });

  it("没有任何书籍的库根不进树", () => {
    const forest = buildForest([{ id: 7, label: "论文库" }, { id: 42, label: "空库" }], docs);
    expect(forest).toHaveLength(1);
    expect(forest[0]?.name).toBe("论文库");
  });
});
