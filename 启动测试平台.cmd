@echo off
chcp 65001 >nul
cd /d "%~dp0"
call scripts\node-runner.cmd local-console\launch.mjs %*
set "MW_LAUNCH_EXIT=%ERRORLEVEL%"
if /i "%~1"=="--check" exit /b %MW_LAUNCH_EXIT%
if errorlevel 1 pause
exit /b %MW_LAUNCH_EXIT%
