@echo off
chcp 65001 >nul
cd /d %~dp0
if not exist data\pace.pid (
  echo 没有找到运行中的服务（data\pace.pid 不存在）
  pause
  exit /b
)
set /p PID=<data\pace.pid
taskkill /PID %PID% /F >nul 2>&1
if errorlevel 1 (
  echo 停止失败，服务可能没在运行
) else (
  echo 已停止日拱一卒服务（PID %PID%）
)
del data\pace.pid >nul 2>&1
pause
