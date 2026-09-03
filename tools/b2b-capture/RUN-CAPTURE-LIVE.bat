@echo off
REM SPEEKS B2B Capture launcher -- LIVE mode.
REM
REM Same as RUN-CAPTURE.bat, plus it asks for the session code from the pricing
REM sheet and posts this machine's reading straight into that deal.
REM
REM A SEPARATE launcher on purpose. RUN-CAPTURE.bat is untouched and is still
REM the normal way to work: nobody who double-clicks that one gets asked a new
REM question. Live intake is a deliberate choice made by picking this file, and
REM pressing Enter at the code prompt falls back to an ordinary offline capture.
REM
REM Self-elevates: battery health and panel size live in root\wmi and want admin.
setlocal
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator access...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0SPEEKS-Capture.ps1" -Screenshot -Live
endlocal
