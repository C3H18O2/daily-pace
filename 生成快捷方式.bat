@echo off
chcp 65001 >/dev/null
rem regenerate shortcut in current folder (run after moving the folder)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $py = (Get-Command pythonw).Source; $sc = $ws.CreateShortcut('%~dp0日拱一卒.lnk'); $sc.TargetPath = $py; $sc.Arguments = 'app.py'; $sc.WorkingDirectory = '%~dp0'; $sc.IconLocation = '%~dp0app.ico'; $sc.Description = '日拱一卒 - deadline 配速器'; $sc.Save()"
if errorlevel 1 (echo 生成失败，请确认已安装 Python 并勾选 Add to PATH) else (echo 已生成：%~dp0日拱一卒.lnk —— 可固定到任务栏或复制到桌面)
pause
