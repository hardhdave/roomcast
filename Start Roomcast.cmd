@echo off
cd /d "%~dp0"
where python >nul 2>&1
if errorlevel 1 (
  echo Python was not found. Install Python 3.12 or newer and add it to PATH.
  pause
  exit /b 1
)
python server.py --open-browser
if errorlevel 1 pause
