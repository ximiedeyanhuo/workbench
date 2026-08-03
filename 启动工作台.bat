@echo off
chcp 65001 >nul
title 个人工作台
cd /d "%~dp0"

rem ============================================================
rem  个人工作台 一键启动
rem  双击即可：已在运行则直接打开页面，否则先启动 server.py
rem ============================================================

rem 端口 8642 已监听则先停掉旧服务，再重启
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /c:"LISTENING" ^| findstr /c:":8642 "') do (
  echo 检测到旧服务（PID %%a），正在重启…
  taskkill /f /pid %%a >nul 2>nul
  timeout /t 1 /nobreak >nul
)

where python >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 python，请先安装 Python 并勾选“加入 PATH”
  pause
  exit /b 1
)

echo 正在启动个人工作台…
where pythonw >nul 2>nul
if %errorlevel%==0 (
  rem pythonw 无窗口静默运行，错误写入日志
  start "workbench-server" /min cmd /c "pythonw server.py > server.log 2>&1"
) else (
  rem 没有 pythonw 则用普通 python（最小化窗口）
  start "workbench-server" /min python server.py
)

rem 最多等 10 秒，探测到端口就绪立即开浏览器
for /l %%i in (1,1,10) do (
  timeout /t 1 /nobreak >nul
  netstat -ano | findstr /c:"LISTENING" | findstr /c:":8642 " >nul && goto :ready
)
echo [警告] 服务 10 秒内未就绪，请查看 server.log 排查错误
pause
exit /b 1

:ready
echo 已就绪：http://127.0.0.1:8642
start "" http://127.0.0.1:8642
exit /b 0
