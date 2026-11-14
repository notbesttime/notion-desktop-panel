@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 前台调试用：直接跑 launch.mjs，日志打到控制台。
rem 正常使用请用 launch.vbs（无窗口）。
node "%~dp0launch.mjs"
