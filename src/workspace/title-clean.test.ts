import { describe, expect, it } from "vitest";

import { cleanTitle, displayTitle, isNoiseBracket, stripExtension } from "./title-clean";

describe("文件名清洗（需求 3，只作用于显示层）", () => {
  it("去掉扩展名，但不碰书名里的点", () => {
    expect(stripExtension("哲学研究.pdf")).toBe("哲学研究");
    expect(stripExtension("v1.2 综述")).toBe("v1.2 综述");
  });

  it("下划线转空格并折叠多余空白", () => {
    expect(cleanTitle("20世纪_西方_哲学史.pdf")).toBe("20世纪 西方 哲学史");
  });

  it("去掉开头的序号前缀", () => {
    expect(cleanTitle("01_导论.pdf")).toBe("导论");
    expect(cleanTitle("3. 方法与证明.pdf")).toBe("方法与证明");
  });

  it("整本都是数字的书名不能被清空", () => {
    expect(cleanTitle("1984.pdf")).toBe("1984");
    expect(cleanTitle("1984.pdf").length).toBeGreaterThan(0);
  });

  it("括号里的噪声词删掉，有意义的括号保留", () => {
    expect(cleanTitle("文献讲稿[zlib].pdf")).toBe("文献讲稿");
    expect(cleanTitle("经济学(上册).pdf")).toBe("经济学(上册)");
    expect(cleanTitle("讲义（高清版）.pdf")).toBe("讲义");
  });

  it("删括号后不再留下夹在汉字之间的空格", () => {
    expect(cleanTitle("书 [pdf] 名.pdf")).toBe("书名");
  });

  it("去掉网址残留", () => {
    expect(cleanTitle("某某文献 www.abc.com.pdf")).toBe("某某文献");
  });

  it("清洗后为空时回退到原名，不产出空标题", () => {
    expect(cleanTitle("(1).pdf").length).toBeGreaterThan(0);
    expect(cleanTitle("   ").length).toBeGreaterThan(0);
  });

  it("噪声括号判定：噪声词与纯数字算噪声，章节号不算", () => {
    expect(isNoiseBracket("zlib")).toBe(true);
    expect(isNoiseBracket("2")).toBe(true);
    expect(isNoiseBracket("第2版")).toBe(false);
  });

  it("显示标题优先用 PDF 元数据（元数据不清洗）", () => {
    expect(displayTitle("元数据标题", "01_噪声_文件名.pdf")).toBe("元数据标题");
    expect(displayTitle(null, "01_噪声_文件名.pdf")).toBe("噪声 文件名");
    expect(displayTitle("   ", "a.pdf")).toBe("a");
  });
});
