@echo off
REM 一键构建并启动 release（本仓库 CARGO_TARGET_DIR 指向工作区 .target）
setlocal
set ROOT=%~dp0
set CARGO_TARGET_DIR=%ROOT%.target
set TMP=%ROOT%.tmp
set TEMP=%ROOT%.tmp
set PATH=%USERPROFILE%\.cargo\bin;%PATH%
set CARGO_HOME=%ROOT%.cargo-home

echo [1/3] 前端构建...
pushd "%ROOT%"
call pnpm build
if errorlevel 1 goto :fail

echo [2/3] 后端构建（release + custom-protocol）...
pushd "%ROOT%src-tauri"
call cargo build --release --features custom-protocol
if errorlevel 1 goto :fail
popd

echo [3/3] 重打完整性标签并启动...
icacls "%CARGO_TARGET_DIR%\release\legere.exe" /setintegritylevel M >nul
start "" "%CARGO_TARGET_DIR%\release\legere.exe"
popd
exit /b 0

:fail
echo 构建失败，请查看上面的错误。
popd
exit /b 1
