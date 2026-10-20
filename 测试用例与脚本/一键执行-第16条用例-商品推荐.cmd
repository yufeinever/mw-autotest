@echo off
chcp 65001 >nul
cd /d "%~dp0.."
call scripts\node-runner.cmd scripts\run-client-case016.mjs %*
set "CASE_EXIT=%ERRORLEVEL%"
echo.
echo 执行结束，退出码：%CASE_EXIT%（0=通过或检查完成，1=失败，2=阻塞）。报告位于 runs 目录。
if /i "%~1"=="--check" exit /b %CASE_EXIT%
if /i "%~1"=="--fill-check" exit /b %CASE_EXIT%
if /i "%~1"=="--help" exit /b %CASE_EXIT%
pause
exit /b %CASE_EXIT%

