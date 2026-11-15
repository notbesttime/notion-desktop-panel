@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Double-click to run. This foreground window prints the injector log live;
rem closing it stops the injector, so the panel goes away with it.
rem Once it works, switch to start.vbs for a windowless launch.
node "%~dp0launch.mjs"
echo.
echo [exited] If the panel never appeared, check notion-panel.log
pause
