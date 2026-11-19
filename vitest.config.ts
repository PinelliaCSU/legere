import { defineConfig } from "vitest/config";

// 只跑纯逻辑单测（不做 DOM 渲染）：M06 的布局/预算算法与 M05 的文本内容构造。
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    reporters: ["default"],
  },
});
