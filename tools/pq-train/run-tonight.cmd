@echo off
rem ==========================================================================
rem Picture Quality local model: the overnight run. Double-click it, or run it
rem from a terminal, at bedtime. Round 1 (397 photos) took 1 h 20 min; round 2
rem (1,759 photos, 2026-10-17) should take about 3.5 to 4 hours on the RTX 5080:
rem   1. scores the UNTRAINED model on the held-out photos   (~15-20 min, skipped
rem      when runs\baseline\scores.txt already exists; after the test set is
rem      rebuilt, rename runs\baseline so it is scored again)
rem   2. trains it on Ethan's own labels, 3 epochs            (~17 s a step; round 2 ~3 h)
rem   3. scores the trained model on the same photos          (~15-20 min)
rem Results: C:\Users\User\pq-train\runs\  (baseline\scores.txt, run-<time>\scores.txt)
rem Full log: C:\Users\User\pq-train\runs\tonight.log
rem
rem Keep the laptop PLUGGED IN with the LID OPEN (the screen can turn off).
rem The scripts stop Windows from sleeping, but a closed lid still sleeps it.
rem Nothing here calls the internet, the API or the database.
rem ==========================================================================
setlocal
cd /d "%~dp0..\.."
set PYTHONIOENCODING=utf-8
set PY=C:\Users\User\pq-train\.venv\Scripts\python.exe
set RUNS=C:\Users\User\pq-train\runs
set LOG=%RUNS%\tonight.log
if not exist "%RUNS%" mkdir "%RUNS%"

echo [%date% %time%] overnight run starting >> "%LOG%"
if exist "%RUNS%\baseline\scores.txt" (
  echo Baseline already scored, skipping it.
) else (
  echo Step 1 of 3: scoring the untrained model ...
  "%PY%" tools\pq-train\evaluate.py --out "%RUNS%\baseline" >> "%LOG%" 2>&1
)
echo Step 2 and 3 of 3: training, then scoring the trained model ...
"%PY%" tools\pq-train\train.py --epochs 3 >> "%LOG%" 2>&1
echo [%date% %time%] overnight run finished >> "%LOG%"
echo.
echo Done. Results are in %RUNS%  (scores.txt in baseline and in the newest run- folder)
pause
