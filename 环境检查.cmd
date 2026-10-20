@echo off
chcp 65001 >nul
cd /d "%~dp0"
call scripts\node-runner.cmd scripts\check-package.mjs %*
set "MW_CHECK_EXIT=%ERRORLEVEL%"
if /i "%~1"=="--self-test" exit /b %MW_CHECK_EXIT%
pause
exit /b %MW_CHECK_EXIT%
