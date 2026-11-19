// 文献库文件夹层级（v0.11 需求 2）的纯逻辑。
//
// 后端从一开始就把相对路径存进了 documents.rel_path（形如 "a/b/c.pdf"），
// 所以「保留文件夹层级」不需要改库、也不用新增命令：前端按路径还原成树即可。
//
// 这里只放能在 node 环境单测的东西；展开状态与选中态在 AppShell.tsx。

export interface FolderDoc {
  documentId: number;
  libraryRootId: number;
  relPath: string;
}

export interface FolderNode {
  /// 稳定 key：<rootId>:<相对路径>（库根节点路径为空串）。展开状态按 key 存。
  key: string;
  rootId: number;
  /// posix 风格的相对目录路径；库根为 ""。
  path: string;
  name: string;
  depth: number;
  /// 含全部子文件夹的书籍数（树右侧显示的就是它）。
  docCount: number;
  children: FolderNode[];
}

export interface TreeRow {
  key: string;
  rootId: number;
  path: string;
  name: string;
  depth: number;
  docCount: number;
  hasChildren: boolean;
  expanded: boolean;
}

export function folderKey(rootId: number, path: string): string {
  return rootId + ":" + path;
}

/// 文件所在目录："a/b/c.pdf" -> "a/b"；库根下的文件 -> ""。
export function folderOf(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const cut = normalized.lastIndexOf("/");
  return cut <= 0 ? "" : normalized.slice(0, cut);
}

/// 书籍是否属于某目录（含其子目录）。folderPath 为空串表示「全部」。
export function inFolder(relPath: string, folderPath: string): boolean {
  if (folderPath.length === 0) return true;
  const dir = folderOf(relPath);
  return dir === folderPath || dir.startsWith(folderPath + "/");
}

/// 单个库根建树：节点是目录，书籍只贡献计数。
export function buildFolderTree(rootId: number, rootName: string, docs: readonly FolderDoc[]): FolderNode {
  const root: FolderNode = {
    key: folderKey(rootId, ""),
    rootId,
    path: "",
    name: rootName,
    depth: 0,
    docCount: 0,
    children: [],
  };
  const byPath = new Map<string, FolderNode>([["", root]]);

  for (const doc of docs) {
    if (doc.libraryRootId !== rootId) continue;
    root.docCount += 1;
    const dir = folderOf(doc.relPath);
    if (dir.length === 0) continue;

    const segments = dir.split("/").filter((s) => s.length > 0);
    let parent = root;
    let walked = "";
    for (const segment of segments) {
      walked = walked.length === 0 ? segment : walked + "/" + segment;
      let node = byPath.get(walked);
      if (node === undefined) {
        node = {
          key: folderKey(rootId, walked),
          rootId,
          path: walked,
          name: segment,
          depth: parent.depth + 1,
          docCount: 0,
          children: [],
        };
        byPath.set(walked, node);
        parent.children.push(node);
      }
      node.docCount += 1;
      parent = node;
    }
  }

  sortTree(root);
  return root;
}

/// 目录按名字排序：同一份数据每次渲染顺序一致，不依赖扫描顺序。
function sortTree(node: FolderNode): void {
  node.children.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  for (const child of node.children) sortTree(child);
}

/// 多库根 -> 森林（每个库根一棵树；一本都没有的库根不进树）。
export function buildForest(
  roots: readonly { id: number; label: string }[],
  docs: readonly FolderDoc[],
): FolderNode[] {
  return roots
    .map((root) => buildFolderTree(root.id, root.label, docs))
    .filter((node) => node.docCount > 0);
}

/// 展开成可渲染的行：库根恒展开，其余看 expanded 集合。折叠的子树不再产出任何行。
export function flattenFolders(nodes: readonly FolderNode[], expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (node: FolderNode): void => {
    const isRoot = node.depth === 0;
    const open = isRoot || expanded.has(node.key);
    rows.push({
      key: node.key,
      rootId: node.rootId,
      path: node.path,
      name: node.name,
      depth: node.depth,
      docCount: node.docCount,
      hasChildren: node.children.length > 0,
      expanded: open,
    });
    if (!open) return;
    for (const child of node.children) walk(child);
  };
  for (const node of nodes) walk(node);
  return rows;
}
