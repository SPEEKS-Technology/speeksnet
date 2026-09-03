@echo off
REM SPEEKS B2B Capture launcher.
REM Double-click this on a test machine once Windows is up.
REM Self-elevates: battery health and panel size live in root\wmi and want admin.
setlocal
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator access...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0SPEEKS-Capture.ps1" -Screenshot
endlocal
