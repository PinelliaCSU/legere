// 极简路由 + 面板开关（Zustand，技术栈既定）。
// 不使用 URL 路由：桌面单窗口应用，路由只是视图状态。

import { create } from "zustand";

export type Route = "home" | "library" | "reader" | "settings" | "about";

interface AppState {
  route: Route;
  activeDocumentId: number | null;
  readerStartPage: number | undefined;
  readerOpenCount: number;
  globalSearchOpen: boolean;
  readerSearchOpen: boolean;
  openRoute: (route: Route) => void;
  openDocument: (documentId: number, pageNo?: number) => void;
  closeDocument: () => void;
  setGlobalSearchOpen: (open: boolean) => void;
  setReaderSearchOpen: (open: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  route: "home",
  activeDocumentId: null,
  readerStartPage: undefined,
  readerOpenCount: 0,
  globalSearchOpen: false,
  readerSearchOpen: false,
  openRoute: (route) => set({ route, globalSearchOpen: false, readerSearchOpen: false }),
  // 打开文档时保留 route 切换，正文由 ReaderView 按 id 加载。
  openDocument: (documentId, pageNo) => set((state) => ({
    route: "reader",
    activeDocumentId: documentId,
    readerStartPage: pageNo,
    readerOpenCount: state.readerOpenCount + 1,
    globalSearchOpen: false,
  })),
  // 13 §3：从阅读器返回主页（Esc 与浮动返回按钮同一条路径），主页组件常驻，
  // 因此环位置与焦点书保持进入阅读前的状态（13 §6）。
  closeDocument: () => set({ route: "home", activeDocumentId: null }),
  setGlobalSearchOpen: (open) => set({ globalSearchOpen: open }),
  setReaderSearchOpen: (open) => set({ readerSearchOpen: open }),
}));
