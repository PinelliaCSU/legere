// 极简路由 + 面板开关（Zustand，技术栈既定）。
// 不使用 URL 路由：桌面单窗口应用，路由只是视图状态。

import { create } from "zustand";

export type Route = "home" | "library" | "reader" | "settings";

interface AppState {
  route: Route;
  activeDocumentId: number | null;
  globalSearchOpen: boolean;
  readerSearchOpen: boolean;
  openRoute: (route: Route) => void;
  openDocument: (documentId: number) => void;
  closeDocument: () => void;
  setGlobalSearchOpen: (open: boolean) => void;
  setReaderSearchOpen: (open: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  route: "home",
  activeDocumentId: null,
  globalSearchOpen: false,
  readerSearchOpen: false,
  openRoute: (route) => set({ route, globalSearchOpen: false, readerSearchOpen: false }),
  // 打开文档时保留 route 切换，正文由 ReaderView 按 id 加载。
  openDocument: (documentId) => set({ route: "reader", activeDocumentId: documentId, globalSearchOpen: false }),
  closeDocument: () => set({ route: "library", activeDocumentId: null }),
  setGlobalSearchOpen: (open) => set({ globalSearchOpen: open }),
  setReaderSearchOpen: (open) => set({ readerSearchOpen: open }),
}));
