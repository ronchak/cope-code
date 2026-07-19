@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1" %*
set "COPE_EXIT=%ERRORLEVEL%"
echo.
if "%COPE_EXIT%"=="0" (
  echo Installation complete.
) else (
  echo Installation failed. The useful error is above.
)
if not defined COPE_NO_PAUSE pause
exit /b %COPE_EXIT%
