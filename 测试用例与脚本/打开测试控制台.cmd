@echo off
chcp 65001 >nul
cd /d "%~dp0.."
call scripts\node-runner.cmd "local-console\launch.mjs" %*
if errorlevel 1 pause
