# PDF.js 适配层抄录（V-01 门禁结论）

> 抄录时间：2026-11-18；来源：本地 `node_modules/pdfjs-dist` 的类型定义（不是记忆、不是文档推测）。
> 结论直接决定 `src/pdf-engine/adapter/` 的写法。

## 1. 版本

```text
$ node -p "require('pdfjs-dist/package.json').version"
6.5.438
```

`package.json` 中已固定次版本（`pdfjs-dist` 依赖项不带 `^`），升级须重跑本文件。

## 2. TextLayer：**只有类，没有 renderTextLayer**

`types/src/display/api.d.ts` 中 `renderTextLayer` **不存在**（grep 无命中），
文本层只能通过 `types/src/display/text_layer.d.ts` 的 `TextLayer` 类：

```ts
// types/src/display/text_layer.d.ts
export type TextLayerParameters = {
  textContentSource: ReadableStream | TextContent;
  container: HTMLElement;
  viewport: PageViewport;
  images?: TextLayerImages;
};
export class TextLayer {
  constructor({ textContentSource, images, container, viewport }: TextLayerParameters);
  render(): Promise<any>;
  update({ viewport }: { viewport: PageViewport }): undefined;
  cancel(): undefined;
  get textDivs(): Array<HTMLElement>;
  static cleanup(): undefined;
  static readonly DEFAULT_FONT_SIZE: 30;
}
```

**所以**：文本层走「路径 A：用 pdfjs 的 TextLayer 类挂载」，自绘 span 作为回退不再需要。
`TextLayer` 由 `pdfjs-dist` 的 display 入口导出（不是 viewer），符合「只用 Display API」的约束。

## 3. TextItem 字段（`types/src/display/api.d.ts:318`）

```ts
export type TextItem = {
  str: string;
  dir: string;        // 'ltr' | 'rtl' | 'ttb'
  transform: Array<any>;
  width: number;      // device space
  height: number;     // device space
  fontName: string;
  hasEOL: boolean;    // 文本项后是否换行
};
```

要点：
1. **有 `hasEOL`** —— 行间换行可以直接用它，不需要我原先设计的 `|y_i - y_prev| > fontSize*0.5` 判据。
   `text` 构造规则（契约 R1）改为：item 之间不加分隔符，`hasEOL === true` 时追加一个 `'\n'`。
2. 没有 `fontSize` 字段（早前设计假设有）；字号需从 `transform` 推导：`sqrt(t[2]² + t[3]²)`。
3. `transform` 是 6 元数组，起点 `x = t[4]`、`y = t[5]`。

## 4. getViewport 参数（`api.d.ts:254`）

```ts
page.getViewport({ scale: number; rotation?: number; offsetX?: number; offsetY?: number; dontFlip?: boolean })
```

`rotation` 省略时默认用页面自带旋转；我们显式传 `PageGeometry.rotation` 以保证与几何一致。

## 5. 对既有设计的影响（已同步的契约）

| 原设计假设 | 实测 | 处理 |
|---|---|---|
| `renderTextLayer()` 可用 | 已移除 | 用 `TextLayer` 类 |
| `TextItem` 有 `fontSize` | 没有 | 由 `transform` 推导 |
| 换行靠 y 差判据（M01 Prompt 第 22 条） | 有 `hasEOL` | 改用 `hasEOL`，判据更可靠且无阈值 |
| TextLayer 可能在 viewer 目录 | 在 display 目录 | 无额外依赖 |

## 6. 未验证项（保留）

- V-07：>300MB PDF 经 `pdf://` 分段加载的首屏时间与内存（需真实大样本）。
- V-08：`page.cleanup()` 后重解析耗时。
- V-09：worker 是否随打开次数增长。