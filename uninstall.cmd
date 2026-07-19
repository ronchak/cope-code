@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall-windows.ps1" %*
set "COPE_EXIT=%ERRORLEVEL%"
if not "%COPE_EXIT%"=="0" pause
exit /b %COPE_EXIT%
