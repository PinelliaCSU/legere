// 阅读让位（P2-2，docs/08 §10 第 237 行）：连续交互 > 150ms 暂停后台索引，空闲 1.5s 恢复。
//
// 为什么必须做：索引工作线程与阅读渲染会同时抢 CPU/IO（docs/20 §2 表第 4 行），
// 而 index_pause 命令与 IPC 类型早就落地（src-tauri/src/commands/index.rs:48、
// src/contracts/cmd.ts:48,93），前端却一直没有调用点 —— 这一层就是补上那个缺口。
//
// 边界：只做「阅读器内的让位」，不改后端的前台优先/批间让位语义（D05），也不新增命令。

export interface IndexYieldOptions {
  /// 连续交互多少毫秒后暂停（防抖动：翻一页不值得停索引）。
  pauseAfterMs?: number;
  /// 空闲多少毫秒后恢复。
  resumeAfterMs?: number;
  /// 注入命令通道（单测用）。
  setPaused?: (paused: boolean) => Promise<void>;
}

export interface IndexYield {
  /// 用户在阅读器里产生了一次交互（滚动 / 滚轮 / 按键）。
  notifyInteraction(): void;
  /// 离开阅读器：清空定时器，并把索引恢复回去。
  dispose(): void;
}

const DEFAULT_PAUSE_AFTER_MS = 150;
const DEFAULT_RESUME_AFTER_MS = 1500;

async function callIndexPause(paused: boolean): Promise<void> {
  const [{ call }, { CMD }] = await Promise.all([import("../core/ipc"), import("../contracts/cmd")]);
  await call(CMD.INDEX_PAUSE, { paused });
}

export function createIndexYield(options: IndexYieldOptions = {}): IndexYield {
  const pauseAfterMs = options.pauseAfterMs ?? DEFAULT_PAUSE_AFTER_MS;
  const resumeAfterMs = options.resumeAfterMs ?? DEFAULT_RESUME_AFTER_MS;
  const apply = options.setPaused ?? callIndexPause;
  let paused = false;
  let disposed = false;
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;

  const clearPause = (): void => {
    if (pauseTimer !== null) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }
  };
  const clearResume = (): void => {
    if (resumeTimer !== null) {
      clearTimeout(resumeTimer);
      resumeTimer = null;
    }
  };

  const setPaused = (next: boolean): void => {
    if (paused === next) return;
    paused = next;
    void apply(next).catch(() => {
      // 索引没在跑 / DB 不可用时命令会失败：让位是锦上添花，回滚标记，下次交互再试。
      paused = !next;
    });
  };

  return {
    notifyInteraction(): void {
      if (disposed) return;
      if (!paused && pauseTimer === null) {
        pauseTimer = setTimeout(() => {
          pauseTimer = null;
          if (!disposed) setPaused(true);
        }, pauseAfterMs);
      }
      clearResume();
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        if (!disposed) setPaused(false);
      }, resumeAfterMs);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearPause();
      clearResume();
      // 离开阅读器必须恢复：别把索引永久留在暂停状态。
      if (paused) setPaused(false);
    },
  };
}
