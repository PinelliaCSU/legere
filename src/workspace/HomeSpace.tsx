// M14 · 主页空间转盘（docs/13，D01–D14）。
//
// 2026-11 修订（用户反馈「书多时挤成一团」「环与书脊没对齐」）：
// 1. 几何只有一套：layoutRing 同时给出环心、半径、每个书脊的 transform，环线直接复用；
// 2. 只挂载可见弧内的槽位（RING_SLOTS 上限），隐藏槽位不生成任何 DOM（13 §2 绝对约束 1）；
// 3. 焦点书恒为窗口首本并落在正前（+90°），滚轮 / 拖拽 / ←→ / Enter 语义一致；
// 4. 组件常驻挂载（active 控制按键），从阅读器返回时环位置与焦点不重置（13 §6）；
// 5. 尺寸用 ResizeObserver + 真实 clientWidth/Height，不再依赖 window.resize。

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";

import { RING, RING_SLOTS, layoutRing, ringCenter, type RingSpine } from "./ring";

export { RING_SLOTS };

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

/// 书脊悬停 tooltip（docs/16 §6「书脊悬停 tooltip（A4 已定）」）：
/// 作者 + 阅读进度两项；缺作者时只显示进度。
/// 两者都没有时回退到书名 —— 否则 tooltip 是空的，等于没有提示。
export function spineTooltip(book: HomeBook): string {
  const parts: string[] = [];
  if (book.author !== null && book.author.trim().length > 0) parts.push(book.author.trim());
  if (book.progressPage !== null && book.pageCount !== null) {
    parts.push("读到第 " + book.progressPage + " / " + book.pageCount + " 页");
  } else if (book.pageCount !== null) {
    parts.push("共 " + book.pageCount + " 页");
  }
  return parts.length > 0 ? parts.join(" · ") : book.title;
}

export function spineColorFor(documentId: number): string {
  const index = Math.abs(documentId) % SPINE_PALETTE.length;
  return SPINE_PALETTE[index] ?? SPINE_PALETTE[0];
}

interface HomeSpaceProps {
  books: HomeBook[];
  onOpenBook: (documentId: number) => void;
  onAddLibrary: () => void;
  /// 是否处于主页路由：false 时禁用滚轮 / 拖拽 / 键盘，避免与阅读器抢按键。
  active?: boolean;
}

const FOCUS_RAD = Math.PI / 2;
const DRAG_STEP_PX = 40;

export function HomeSpace({ books, onOpenBook, onAddLibrary, active = true }: HomeSpaceProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 1280, height: 800 });
  const [windowStart, setWindowStart] = useState(0);

  const total = books.length;
  const start = total > 0 ? ((windowStart % total) + total) % total : 0;

  // 真实可见区域：clientWidth/Height 而不是 window.innerWidth（后者含侧边栏/滚动条误差）。
  useEffect(() => {
    const el = hostRef.current;
    if (el === null) return;
    const measure = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [total]);

  const center = useMemo(() => ringCenter(size.width, size.height), [size.width, size.height]);
  const spines = useMemo(() => layoutRing(total, center, FOCUS_RAD), [total, center]);
  const spineLength = RING.spineHeightRatio * center.radius;

  const rotate = useCallback(
    (dir: 1 | -1) => {
      if (total === 0) return;
      setWindowStart((value) => value + dir);
    },
    [total],
  );

  // 滚轮 = 旋转转盘（D09）。必须用非被动原生监听：React 的 onWheel 是 passive，
  // preventDefault 无效，页面会跟着滚。
  useEffect(() => {
    const el = hostRef.current;
    if (el === null || !active || total === 0) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.deltaY === 0) return;
      rotate(event.deltaY > 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [active, rotate, total]);

  // 键盘：只在主页路由生效，避免和阅读器的 ←→ / M / Esc 冲突。
  useEffect(() => {
    if (!active || total === 0) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        rotate(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        rotate(-1);
      } else if (event.key === "Enter") {
        const book = books[start];
        if (book !== undefined) onOpenBook(book.documentId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, books, onOpenBook, rotate, start, total]);

  // 拖拽：横向位移超过阈值才切一格，且不吞掉点击（D09 同轴）。
  const dragRef = useRef<{ x: number; moved: boolean } | null>(null);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!active) return;
    dragRef.current = { x: event.clientX, moved: false };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || !active) return;
    const dx = event.clientX - drag.x;
    if (Math.abs(dx) < DRAG_STEP_PX) return;
    drag.moved = true;
    drag.x = event.clientX;
    rotate(dx > 0 ? -1 : 1);
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

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

  const focused = books[start];
  // D11：环心下方只展示焦点书一条（书名 + 作者 + 读到第 x / y 页），不常驻堆叠。
  const metaParts: string[] = [];
  if (focused?.author) metaParts.push(focused.author);
  if (focused?.progressPage !== null && focused?.progressPage !== undefined && focused?.pageCount !== null && focused?.pageCount !== undefined) {
    metaParts.push("读到第 " + focused.progressPage + " / " + focused.pageCount + " 页");
  }
  const meta = metaParts.join(" · ");

  return (
    <div
      className={"lg-home" + (active ? "" : " is-inactive")}
      ref={hostRef}
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
      {spines.map((spine: RingSpine) => {
        const book = books[((start + spine.bookOffset) % total + total) % total];
        if (book === undefined) return null;
        const isFocused = spine.bookOffset === 0 && total !== 2;
        return (
          <button
            key={book.documentId}
            type="button"
            data-home-spine=""
            data-slot={spine.slotOffset}
            data-document-id={book.documentId}
            className={"lg-spine" + (isFocused ? " is-focused" : "")}
            title={spineTooltip(book)}
            tabIndex={-1}
            onClick={() => onOpenBook(book.documentId)}
            style={
              {
                width: RING.spineWidthPx,
                height: spineLength,
                // docs/15 §8：dark 主题要把书脊色提亮 12%，所以颜色走 CSS 变量而不是内联 background。
                "--lg-spine-color": book.spineColor,
                zIndex: spine.zIndex,
                opacity: spine.opacity,
                fontSize: spine.fontSize,
                transform:
                  "translate3d(" + spine.left + "px," + spine.top + "px,0) rotate(" + spine.rotationDeg + "deg) scale(" + spine.scale + ")",
              } as CSSProperties
            }
          >
            <span className={"lg-spine-title" + (spine.flipText ? " is-flipped" : "")}>{book.title}</span>
          </button>
        );
      })}
      {focused !== undefined ? (
        <div className="lg-home-focused" style={{ left: center.cx, top: center.cy + spineLength / 2 + 40 }}>
          <strong>{focused.title}</strong>
          {meta === "" ? null : <span>{meta}</span>}
        </div>
      ) : null}
    </div>
  );
}
