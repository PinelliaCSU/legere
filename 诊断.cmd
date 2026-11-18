@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
set "LEGERE_LOG_DIR=%ROOT%diag-logs"
set "LEGERE_LOG=debug"
echo === 1. 启动 Legere（release）===
start "" "%ROOT%.target\release\legere.exe"
echo === 2. 等待 12 秒 ===
timeout /t 12 /nobreak >nul
echo.
echo === 3. 窗口创建错误（若文件存在）===
if exist "%ROOT%.target\release\startup-error.txt" (
  type "%ROOT%.target\release\startup-error.txt"
) else (
  echo （无 startup-error.txt：窗口应已成功创建）
)
echo.
echo === 4. 应用日志 ===
if exist "%ROOT%diag-logs" (
  for %%f in ("%ROOT%diag-logs\*.log*") do @type "%%f"
) else (
  echo （无 diag-logs 目录）
)
echo.
echo === 结束。请把上面 3/4 两段内容整段复制给 DSH ===
pause
