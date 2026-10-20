@echo off
setlocal
if exist "%~dp0..\runtime\node.exe" (
  "%~dp0..\runtime\node.exe" %*
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo 未找到 Node.js。请使用完整便携包，或安装 Node.js 22 后重试。
    exit /b 1
  )
  node %*
)
exit /b %ERRORLEVEL%
