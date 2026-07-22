@echo off
setlocal
chcp 65001 >nul
set "SCAN_ARGS=%*"
set "WATCHLATER_ROOT=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$code = Get-Content -Raw -Encoding UTF8 -LiteralPath '%~dp0tools\prepare-watchlater-scan.ps1'; $params = @{}; if ($env:SCAN_ARGS -match '(^|\s)-NoOpen(\s|$)') {$params.NoOpen = $true}; if ($env:SCAN_ARGS -match '(^|\s)-NoPause(\s|$)') {$params.NoPause = $true}; if ($env:SCAN_ARGS -match '(^|\s)-DryRun(\s|$)') {$params.DryRun = $true}; . ([ScriptBlock]::Create($code)) @params"
set "exitCode=%errorlevel%"
endlocal & exit /b %exitCode%
