// M07 · 目录抽屉（从阅读器里抽出的独立浮层）。
//
// 本轮两处修复：
// 1. 打开时点面板外任意位置自动收起：文档级 pointerdown（捕获阶段）+ contains 判否。
//    不用全屏遮罩 —— 遮罩会吞掉这次点击，而需求要求本次点击照常落到页面上。
// 2. 头部（「目录」+ 关闭）固定、只有列表滚动：抽屉自身 overflow: hidden，
//    列表 .lg-drawer-list 自己滚（见 global.css）。滚到列表底部也能直接点关闭。
//
// 本组件只在目录打开时挂载，所以监听随卸载一起解绑，无需额外传 open。

import { useEffect, useRef, type ReactElement } from "react";

export interface OutlineNode {
  title: string;
  pageNo: number | null;
}

interface OutlineDrawerProps {
  outline: readonly OutlineNode[];
  onJump: (pageNo: number) => void;
  onClose: () => void;
}

export function OutlineDrawer({ outline, onJump, onClose }: OutlineDrawerProps): ReactElement {
  const panelRef = useRef<HTMLElement | null>(null);
  /// 父组件每次都传新的箭头函数，用 ref 兜住回调，避免监听被反复重装。
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    /// 捕获阶段注册：阅读页自己的 pointerdown（中键拖拽平移）会 preventDefault，
    /// 冒泡阶段的文档监听可能被断掉，捕获阶段一定先拿到。
    const onDown = (event: PointerEvent): void => {
      // 只认左键：右键是呼出功能面板，不该顺带收起目录。
      if (event.button !== 0) return;
      const target = event.target;
      // 抽屉内点击（列表项、关闭按钮、滚动条）不收起。
      if (target instanceof Node && panelRef.current !== null && panelRef.current.contains(target)) return;
      closeRef.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);

  return (
    <aside ref={panelRef} className="lg-drawer lg-outline" aria-label="目录">
      <header className="lg-drawer-head">
        <strong>目录</strong>
        <button type="button" className="lg-btn" onClick={onClose}>关闭</button>
      </header>
      <ul className="lg-drawer-list">
        {outline.map((node, i) => (
          <li key={i}>
            <button
              type="button"
              onClick={() => {
                if (node.pageNo !== null) onJump(node.pageNo);
              }}
            >
              {node.title}
              {node.pageNo !== null ? " · p" + node.pageNo : ""}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
