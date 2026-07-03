# 유튜브 자막 번역 서버 실행 스크립트 (Windows PowerShell)
# macOS의 start-server.command와 동일 동작: 포트 정리 → 서버 실행 → 종료 대기
#
# 실행 방법:
#   1) start-server.bat 더블클릭 (권장 — 실행 정책 우회 포함)
#   2) PowerShell에서: powershell -ExecutionPolicy Bypass -File .\start-server.ps1
#
# 사전 조건: Node.js 18+ 및 Claude Code CLI 설치·로그인 (claude → /login)

$Host.UI.RawUI.WindowTitle = "YouTube 자막 번역 서버 (Claude)"

# 스크립트 위치(server\)로 이동
Set-Location -Path $PSScriptRoot

$port = if ($env:PORT) { $env:PORT } else { "8787" }

# node 확인
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "오류: node를 찾을 수 없습니다. Node.js 18+ 를 설치하세요." -ForegroundColor Red
    Read-Host "아무 키나 누르면 종료합니다"
    exit 1
}

# claude CLI 확인 (경고만 — 서버가 시작 시 자가 진단을 다시 수행)
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host "경고: claude CLI를 PATH에서 찾을 수 없습니다. 설치·로그인 후 사용하세요." -ForegroundColor Yellow
}

# 기존 서버(:포트) 종료
try {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($conns) {
        Write-Host "기존 서버(:$port) 종료 중..."
        $conns | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
            Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1
    }
} catch { }

Write-Host "========================================"
Write-Host "  YouTube 자막 번역 서버 (claude -p)"
Write-Host "  포트: $port · 종료: Ctrl+C"
Write-Host "========================================"
Write-Host ""

$env:PORT = $port
node translate-server.js

Write-Host ""
Write-Host "========================================"
Write-Host "  서버가 종료되었습니다."
Write-Host "========================================"
Read-Host "아무 키나 누르면 창을 닫습니다"
