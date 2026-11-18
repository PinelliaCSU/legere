import { describe, expect, it } from "vitest";

import { normalizeRootName, normalizeRootPathInput, rootLabel, rootNameError, rootReplaceBody } from "./library-roots";

describe("文献库显示名（R22：只改名字）", () => {
  it("trim 后为空视为没填", () => {
    expect(normalizeRootName("   ")).toBeNull();
    expect(normalizeRootName("  我的库 ")).toBe("我的库");
  });

  it("空名与超长名被拦下，正常名通过", () => {
    expect(rootNameError("   ")).toBe("文献库名称不能为空");
    expect(rootNameError("a".repeat(121))).toContain("过长");
    expect(rootNameError("  正常名字 ")).toBeNull();
  });

  it("显示名为空时回退到路径末段（库根可能被手工改坏）", () => {
    expect(rootLabel({ displayName: "书库", path: "D:/Papers" })).toBe("书库");
    expect(rootLabel({ displayName: "   ", path: "D:/Papers/" })).toBe("Papers");
    expect(rootLabel({ displayName: "", path: "C:\\Books\\" })).toBe("Books");
  });
});

describe("文献库替换（R23：换文件夹，旧文献消失）", () => {
  it("路径只做 trim，绝对化交给后端 ensure_root_dir", () => {
    expect(normalizeRootPathInput("   ")).toBeNull();
    expect(normalizeRootPathInput("  D:\\Papers  ")).toBe("D:\\Papers");
  });

  it("确认正文必须说清三件事：旧记录删除、磁盘文件不动、会自动扫描", () => {
    const text = rootReplaceBody("我的库");
    expect(text).toContain("我的库");
    expect(text).toContain("文献记录会被全部删除");
    expect(text).toContain("磁盘上的原文件不会被删除");
    expect(text).toContain("自动扫描");
  });
});
