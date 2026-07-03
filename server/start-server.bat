@echo off
rem YouTube subtitle translate server - Windows double-click launcher.
rem Runs the sibling start-server.ps1 with the execution policy bypassed.
rem %~dp0 = folder of THIS .bat (with trailing backslash), so it works
rem after cloning/moving the project to any PC or location.
setlocal
set "PS1=%~dp0start-server.ps1"

if not exist "%PS1%" (
  echo [ERROR] start-server.ps1 not found next to this .bat file.
  echo         Keep start-server.bat and start-server.ps1 in the same folder.
  pause
  exit /b 1
)

rem 1) Windows PowerShell (built into all supported Windows)
where powershell >nul 2>nul
if %errorlevel%==0 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
  goto :end
)

rem 2) PowerShell 7 (pwsh) fallback
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
  goto :end
)

echo [ERROR] PowerShell not found.
echo         Install Windows PowerShell or PowerShell 7 (pwsh), then retry.
pause

:end
endlocal
