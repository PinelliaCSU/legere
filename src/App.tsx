import { useEffect, useState, type ReactElement } from "react";

import { AppShell } from "./workspace/AppShell";
import { ThemeProvider } from "./theme/ThemeProvider";

/// 启动壳：先拉一次 app_info/ping（事件 + 拉取双保险的另一半在 AppShell 里）。
export default function App(): ReactElement {
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    setBooted(true);
  }, []);
  if (!booted) return <div className="lg-boot">正在启动…</div>;
  return (
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  );
}
