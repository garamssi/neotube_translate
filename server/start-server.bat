@echo off
rem 유튜브 자막 번역 서버 — Windows 더블클릭 실행용
rem PowerShell 실행 정책을 우회해 start-server.ps1을 실행한다.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-server.ps1"
