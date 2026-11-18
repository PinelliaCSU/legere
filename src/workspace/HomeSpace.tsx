// 主页空间转盘（docs/13，D01–D14）。
//
// 2026-11-18 修订（用户反馈「书多时挤成一团」）：
// 环上**同时只放 RING_SLOTS 个槽位**，其余书籍通过「滚轮 / 拖拽 / ←→」滑入窗口。
// 这样书数再多，相邻书脊的角距也固定，不会挤在一起；隐藏的槽位依旧不生成 DOM。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { RING, focusIndex, layoutSpines, ringCenter, type SpineLayout } from "./ring";

export interface HomeBook {
  documentId: number;
  fileName: string;
  title: string;
  author: string | null;
  spineColor: string;
  pageCount: number | null;
  progressPage: number | null;
}

/// D13：8 色预设（docs/15 §8）。
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

/// 环上的槽位数上限：决定同时可见的书脊数量（与书总数无关）。
export const RING_SLOTS = 16;

interface HomeSpaceProps {
  books: HomeBook[];
  onOpenBook: (documentId: number) => void;
  onAddLibrary: () => void;
}

export function HomeSpace({ books, onOpenBook, onAddLibrary }: HomeSpaceProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 1280, height: 800 });
  const [windowStart, setWindowStart] = useState(0);
  const [focusedSlot, setFocusedSlot] = useState(0);
  const dragRef = useRef<{ x: number; moved: boolean } | null>(null);

  useEffect(() => {
    const measure = () => {
      const el = hostRef.current;
      if (el === null) return;
      setSize({ width: el.clientWidth, height: el.clientHeight });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [books.length]);

  const total = books.length;
  const slots = Math.min(total, RING_SLOTS);
  const focusRad = Math.PI / 2;
  const center = useMemo(() => ringCenter(size.width, size.height), [size.width, size.height]);

  /// 当前窗口内的书（按槽位顺序）；槽位角度固定，所以角距恒定。
  const windowBooks = useMemo(() => {
    if (total === 0) return [] as { slot: number; book: HomeBook }[];
    const out: { slot: number; book: HomeBook }[] = [];
    for (let slot = 0; slot < slots; slot += 1) {
      const index = (windowStart + slot) % total;
      const book = books[index];
      if (book !== undefined) out.push({ slot, book });
    }
    return out;
  }, [books, slots, total, windowStart]);

  /// 槽位布局：用 slots 作为总数，保证 Δ 恒定。
  const layouts = useMemo(
    () => layoutSpines(slots, 0, focusRad, center),
    [slots, center],
  );

  useEffect(() => {
    if (layouts.length === 0) return;
    setFocusedSlot(focusIndex(layouts, focusRad));
  }, [layouts]);

  const rotate = useCallback(
    (dir: 1 | -1) => {
      if (total === 0) return;
      setWindowStart((start) => ((start + dir) % total + total) % total);
    },
    [total],
  );

  // 滚轮：一格一本（D09 的方向语义保留，改为离散滑动更可控）
  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      const dir: 1 | -1 = e.deltaY > 0 ? 1 : -1;
      rotate(dir);
    },
    [rotate],
  );

  // 拖拽：横向位移超过阈值才切换，且不吞掉点击
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { x: e.clientX, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) < 40) return;
    drag.moved = true;
    drag.x = e.clientX;
    rotate(dx > 0 ? -1 : 1);
  };

  const onPointerUp = () => {
    if (dragRef.current !== null) dragRef.current = null;
  };

  // 键盘
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (total === 0) return;
      if (e.key === "ArrowRight") rotate(1);
      else if (e.key === "ArrowLeft") rotate(-1);
      else if (e.key === "Enter") {
        const entry = windowBooks.find((w) => w.slot === focusedSlot);
        if (entry !== undefined) onOpenBook(entry.book.documentId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusedSlot, onOpenBook, rotate, total, windowBooks]);

  const spineLength = RING.spineHeightRatio * center.radius;
  const focusedEntry = windowBooks.find((w) => w.slot === focusedSlot);

  if (total === 0) {
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
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      <div
        className="lg-home-ring"
        style={{
          width: center.radius * 2,
          height: center.radius * 2,
          transform: "translate3d(" + (center.cx - center.radius) + "px," + (center.cy - center.radius) + "px,0)",
        }}
      />
      {layouts.map((layout: SpineLayout) => {
        const entry = windowBooks.find((w) => w.slot === layout.index);
        if (entry === undefined) return null;
        const isFocused = layout.index === focusedSlot;
        return (
          <button
            key={entry.book.documentId}
            type="button"
            data-home-spine=""
            data-index={layout.index}
            className={"lg-spine" + (isFocused ? " is-focused" : "")}
            title={entry.book.title}
            onClick={() => onOpenBook(entry.book.documentId)}
            style={{
              width: RING.spineWidthPx,
              height: spineLength,
              background: entry.book.spineColor,
              zIndex: layout.zIndex,
              opacity: layout.opacity,
              fontSize: layout.fontSize,
              transform:
                "translate3d(" + layout.left + "px," + layout.top + "px,0) rotate(" + layout.rotationDeg + "deg) scale(" + layout.scale + ")",
            }}
          >
            <span className="lg-spine-title">{entry.book.title}</span>
          </button>
        );
      })}
      {focusedEntry !== undefined ? (
        <div className="lg-home-focused" style={{ left: center.cx, top: center.cy + spineLength / 2 + 40 }}>
          <strong>{focusedEntry.book.title}</strong>
          <span>
            {focusedEntry.book.author ?? ""}
            {focusedEntry.book.progressPage !== null && focusedEntry.book.pageCount !== null
              ? " · 读到第 " + focusedEntry.book.progressPage + " / " + focusedEntry.book.pageCount + " 页"
              : ""}
          </span>
        </div>
      ) : null}
      {total > slots ? (
        <div className="lg-home-hint">
          共 {total} 本 · 滚轮或拖拽切换 · 当前第 {windowStart + 1} 本起
        </div>
      ) : null}
    </div>
  );
}