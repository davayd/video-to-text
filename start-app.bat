@echo off
setlocal enabledelayedexpansion
cd /d %~dp0

echo [start] Bootstrapping dependencies...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-deps.ps1"
if errorlevel 1 (
  echo [start][ERROR] Dependency bootstrap failed.
  exit /b 1
)

echo [start] Checking required tools...
where node >nul 2>nul || (echo [start][ERROR] node not found & exit /b 1)
where npm >nul 2>nul || (echo [start][ERROR] npm not found & exit /b 1)
where python >nul 2>nul || (echo [start][ERROR] python not found & exit /b 1)
where ffmpeg >nul 2>nul || (echo [start][ERROR] ffmpeg not found & exit /b 1)
where whisper >nul 2>nul || (echo [start][ERROR] whisper CLI not found & exit /b 1)

echo [start] Checking service on port 3000...
set PORT_BUSY=
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:":3000 .*LISTENING"') do (
  set PORT_BUSY=1
  set APP_PID=%%a
)

if defined PORT_BUSY (
  echo [start] Port 3000 already in use. PID: !APP_PID!
  powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://localhost:3000/api/videos; if ($r.StatusCode -eq 200) { exit 0 } else { exit 2 } } catch { exit 1 }"
  if errorlevel 1 (
    echo [start][ERROR] Another process is using port 3000 and app healthcheck failed.
    exit /b 1
  )
  echo [start] Existing app instance is healthy.
  start "" http://localhost:3000
  exit /b 0
)

echo [start] Starting local app on http://localhost:3000
start "" http://localhost:3000
npm start
