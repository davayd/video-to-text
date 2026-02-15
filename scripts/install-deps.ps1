$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
  Write-Host "[setup] $Message" -ForegroundColor Cyan
}

function Test-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Install-WithWinget([string]$Id, [string]$Name) {
  if (-not (Test-Command winget)) {
    throw "winget не найден. Установите App Installer из Microsoft Store и повторите запуск."
  }

  Write-Step "Установка $Name через winget..."
  winget install --id $Id --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
}

Write-Step "Проверка Node.js"
if (-not (Test-Command node)) {
  Install-WithWinget -Id 'OpenJS.NodeJS.LTS' -Name 'Node.js LTS'
}

Write-Step "Проверка Python"
if (-not (Test-Command python)) {
  Install-WithWinget -Id 'Python.Python.3.11' -Name 'Python 3.11'
}

Write-Step "Проверка ffmpeg"
if (-not (Test-Command ffmpeg)) {
  Install-WithWinget -Id 'Gyan.FFmpeg' -Name 'ffmpeg'
}

Write-Step "Установка Python-пакетов (openai-whisper)"
python -m pip install --upgrade pip
python -m pip install --upgrade openai-whisper

Write-Step "Установка npm зависимостей"
npm install

Write-Step "Готово"
