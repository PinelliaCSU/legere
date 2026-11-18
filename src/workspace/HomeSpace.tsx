// 主页空间转盘（docs/13，D01–D14 已冻结）。
//
// 实现纪律：
// 1. 隐藏弧内的书**不生成 DOM**（不是 display:none）——13 §2 绝对约束。
// 2. 拖拽只写 transform，不触发 React 重渲染（13 §5 门槛）。
// 3. 书脊上只有书名（D04/D12）；焦点书名+作者+进度显示在环心下方（D11）。
// 4. 空态不画环，只给一句话 + 按钮（D14）。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { RING, focusIndex, initialBaseRad, layoutSpines, ringCenter, type SpineLayout } from "./ring";

export interface HomeBook {
  documentId: number;
  fileName: string;
  title: string;
  author: string | null;
  spineColor: string;
  pageCount: number | null;
  progressPage: number | null;
}

/// D13：8 色预设（docs/15-theme-tokens.md §8），按 documentId 哈希取色。
export const SPINE_PALETTE = [
  "#9AA47A",
  "#8FA083",
  "#9B6B4A",
  "#C9B37A",
  "#8E86A5",
  "#A8B49B",
  "#A9714B",
  "#9FB08C",
] as const;

export function spineColorFor(documentId: number): string {
  const index = Math.abs(documentId) % SPINE_PALETTE.length;
  return SPINE_PALETTE[index] ?? SPINE_PALETTE[0];
}

interface HomeSpaceProps {
  books: HomeBook[];
  onOpenBook: (documentId: number) => void;
  onAddLibrary: () => void;
}

export function HomeSpace({ books, onOpenBook, onAddLibrary }: HomeSpaceProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 1280, height: 800 });
  const rotationRef = useRef(initialBaseRad(books.length));
  const [baseRad, setBaseRad] = useState(() => initialBaseRad(books.length));
  const [focusedIndex, setFocusedIndex] = useState(0);
  const dragRef = useRef<{ active: boolean; lastX: number } | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const measure = () => {
      const el = hostRef.current;
      if (el === null) return;
      setSize({ width: el.clientWidth, height: el.clientHeight });
    };
    measure();
    window.addEventListener("resize", measure);
    // 书数变化会切换「空态 ⇄ 环」两种 DOM 结构，必须重新测量，否则沿用旧尺寸导致圆心偏移。
    return () => window.removeEventListener("resize", measure);
  }, [books.length]);

  const focusRad = Math.PI / 2;
  const center = useMemo(() => ringCenter(size.width, size.height), [size.width, size.height]);
  const layouts = useMemo(() => layoutSpines(books.length, baseRad, focusRad, center), [books.length, baseRad, center]);

  useEffect(() => {
    if (layouts.length === 0) return;
    setFocusedIndex(focusIndex(layouts, focusRad));
  }, [layouts]);

  // 拖拽：rAF 内直接写 transform，React 不参与渲染。
  const applyRotation = useCallback(
    (deltaPx: number) => {
      rotationRef.current += deltaPx * 0.004;
      const host = hostRef.current;
      if (host === null) return;
      const slots = Math.max(books.length, RING.minSlots);
      const spineLength = RING.spineHeightRatio * center.radius;
      host.querySelectorAll<HTMLElement>("[data-home-spine]").forEach((node) => {
        const index = Number(node.dataset.index ?? "0");
        const angle = rotationRef.current + (index * 2 * Math.PI) / slots;
        const x = center.cx + center.radius * Math.cos(angle) - RING.spineWidthPx / 2;
        const y = center.cy + center.radius * Math.sin(angle) - spineLength / 2;
        node.style.transform =
          "translate3d(" + x + "px," + y + "px,0) rotate(" + ((angle * 180) / Math.PI + 90) + "deg)";
      });
    },
    [books.length, center],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { active: true, lastX: e.clientX };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || !drag.active) return;
    const dx = e.clientX - drag.lastX;
    drag.lastX = e.clientX;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      applyRotation(dx);
    });
  };

  const endDrag = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag === null) return;
    setBaseRad(rotationRef.current);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (books.length === 0) return;
      const slots = Math.max(books.length, RING.minSlots);
      const step = (2 * Math.PI) / slots;
      if (e.key === "ArrowRight") {
        rotationRef.current -= step;
        setBaseRad(rotationRef.current);
      } else if (e.key === "ArrowLeft") {
        rotationRef.current += step;
        setBaseRad(rotationRef.current);
      } else if (e.key === "Enter") {
        const book = books[focusedIndex];
        if (book !== undefined) onOpenBook(book.documentId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [books, focusedIndex, onOpenBook]);

  const spineLength = RING.spineHeightRatio * center.radius;
  const focusedBook = books[focusedIndex];

  if (books.length === 0) {
    return (
      <div className="lg-home lg-home-empty" ref={hostRef}>
        <div className="lg-home-empty-card">
          <p>还没有文献</p>
          <button type="button" className="lg-btn lg-btn-primary" onClick={onAddLibrary}>
            添加文献库
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="lg-home"
      ref={hostRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      role="application"
      aria-label="文献空间：左右方向键旋转，回车打开"
    >
      <div
        className="lg-home-ring"
        style={{
          left: center.cx - center.radius,
          top: center.cy - center.radius,
          width: center.radius * 2,
          height: center.radius * 2,
        }}
      />
      {layouts.map((layout: SpineLayout) => {
        if (!layout.visible) return null;
        const book = books[layout.index];
        if (book === undefined) return null;
        const isFocused = layout.index === focusedIndex;
        return (
          <button
            key={book.documentId}
            type="button"
            data-home-spine=""
            data-index={layout.index}
            className={"lg-spine" + (isFocused ? " is-focused" : "")}
            title={book.title}
            onClick={() => onOpenBook(book.documentId)}
            style={{
              width: RING.spineWidthPx,
              height: spineLength,
              background: book.spineColor,
              zIndex: layout.zIndex,
              opacity: layout.opacity,
              fontSize: layout.fontSize,
              transform:
                "translate3d(" + layout.left + "px," + layout.top + "px,0) rotate(" + layout.rotationDeg + "deg) scale(" + layout.scale + ")",
            }}
          >
            <span className="lg-spine-title">{book.title}</span>
          </button>
        );
      })}
      {focusedBook !== undefined ? (
        <div
          className="lg-home-focused"
          style={{ left: center.cx, top: center.cy + spineLength / 2 + 40 }}
        >
          <strong>{focusedBook.title}</strong>
          <span>
            {focusedBook.author ?? ""}
            {focusedBook.progressPage !== null && focusedBook.pageCount !== null
              ? " · 读到第 " + focusedBook.progressPage + " / " + focusedBook.pageCount + " 页"
              : ""}
          </span>
        </div>
      ) : null}
    </div>
  );
}