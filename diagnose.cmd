@echo off
setlocal
set "ROOT=%~dp0"
set "LEGERE_LOG_DIR=%ROOT%diag-logs"
set "LEGERE_LOG=info"
set "EXE=%ROOT%.target\release\legere.exe"
echo [1/4] exe=%EXE%
if not exist "%EXE%" goto noexe
start "" "%EXE%"
echo [2/4] waiting 12s ...
timeout /t 12 /nobreak >nul
echo [3/4] startup-error:
if exist "%ROOT%.target\release\startup-error.txt" type "%ROOT%.target\release\startup-error.txt"
if not exist "%ROOT%.target\release\startup-error.txt" echo   (none: window created)
echo [4/4] logs:
if exist "%LEGERE_LOG_DIR%\*.log*" for %%f in ("%LEGERE_LOG_DIR%\*.log*") do type "%%f"
if not exist "%LEGERE_LOG_DIR%\*.log*" echo   (no logs in diag-logs)
goto done
:noexe
echo   exe missing
:done
echo ==== copy sections 3 and 4 back ====
pause
