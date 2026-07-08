# YouTube 자막 번역 서버 실행 스크립트 (Windows PowerShell)
#
# 어느 컴퓨터에서든 "프로젝트만 받으면" 더블클릭으로 동작하도록 작성됨:
#   - 실행 직전 레지스트리에서 최신 PATH를 다시 읽음(설치 직후 반영 안 된 창 대비)
#   - Node.js / Claude CLI가 PATH에 없어도 표준 설치 위치를 자동 탐색
#   - PATH의 claude 항목을 "전부" 조사해 실제 존재하는 실행 대상만 채택
#   - npm 래퍼(claude.cmd/.ps1)는 내부를 파싱해 실제 실행 파일(bin\claude.exe 또는 cli.js)을 채택
#   - 모든 상대경로는 스크립트 위치 기준 → 폴더를 옮겨도 동작
#
# 실행: start-server.bat 더블클릭 (권장)
# 사전 조건: Node.js 18+ 및 Claude Code CLI 설치·로그인 (claude → /login)

$ErrorActionPreference = 'Continue'

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Host.UI.RawUI.WindowTitle = "YouTube 자막 번역 서버 (Claude)"
Set-Location -LiteralPath $PSScriptRoot
$port = if ($env:PORT) { $env:PORT } else { "8787" }

# ── 최신 PATH 재적용 ─────────────────────────────────────────────
# 설치 직후 PATH 변경이 "이미 떠 있던" 탐색기/셸에는 반영되지 않는다.
# bat을 그런 곳에서 더블클릭하면 옛 PATH를 물고 오므로, 레지스트리의
# 최신 Machine+User PATH를 다시 읽어 이 세션 PATH를 갱신한다(관리자 불필요).
try {
    $machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath    = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $seen = @{}
    $clean = foreach ($seg in (($machinePath, $userPath, $env:Path) -join ';') -split ';') {
        $s = $seg.Trim()
        if ($s -and -not $seen.ContainsKey($s.ToLower())) { $seen[$s.ToLower()] = $true; $s }
    }
    $env:Path = ($clean -join ';')
} catch {}

# ── Node.js 확인 ─────────────────────────────────────────────────
function Find-Node {
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c -and $c.Source) { return $c.Source }
    $cands = @()
    if ($env:ProgramFiles)        { $cands += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
    if (${env:ProgramFiles(x86)}) { $cands += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe') }
    if ($env:LOCALAPPDATA)        { $cands += (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe') }
    if ($env:NVM_SYMLINK)         { $cands += (Join-Path $env:NVM_SYMLINK 'node.exe') }
    foreach ($p in $cands) { if ($p -and (Test-Path -LiteralPath $p)) { return $p } }
    return $null
}
$nodePath = Find-Node
if (-not $nodePath) {
    Write-Host "오류: Node.js를 찾을 수 없습니다. https://nodejs.org 에서 LTS(18+) 설치 후 재실행." -ForegroundColor Red
    Read-Host "아무 키나 누르면 종료합니다"; exit 1
}
$nodeDir = Split-Path -Parent $nodePath
if (($env:Path -split ';') -notcontains $nodeDir) { $env:Path = "$nodeDir;$env:Path" }
try {
    $ver = (& $nodePath --version) -replace '^v', ''
    if ([int]($ver.Split('.')[0]) -lt 18) { Write-Host "경고: Node $ver — 18 이상 권장." -ForegroundColor Yellow }
} catch {}

# ── Claude CLI 확인 ──────────────────────────────────────────────
# 서버는 CLAUDE_BIN이 (a).exe 또는 (b)cli.js(node로 실행) 형태를 지원한다.
# PATH에 claude가 여러 개(깨진 잔여 shim 포함)일 수 있으므로 전부 조사해
# "실제로 존재하는" 실행 대상만 고른다.

# 래퍼(.cmd/.ps1/무확장자) 안에서 실제 진입 .js 경로를 뽑아낸다.
function Parse-ShimTargets($shimPath) {
    $out = @()
    try {
        $txt = Get-Content -LiteralPath $shimPath -Raw -ErrorAction SilentlyContinue
        if ($txt) {
            foreach ($mo in [regex]::Matches($txt, 'node_modules[\\/][^"''\s]+\.(?:exe|js|mjs)')) {
                $out += (Join-Path (Split-Path -Parent $shimPath) $mo.Value)
            }
        }
    } catch {}
    return $out
}

$claudeBin = $null
$cands = @()             # 실행 대상 후보(.exe 또는 cli.js)
$shimSources = @()       # 진단용: PATH에서 찾은 claude 항목들

# 1) PATH의 claude 항목 전부
foreach ($c in @(Get-Command claude -All -ErrorAction SilentlyContinue)) {
    $src = if ($c.Source) { $c.Source } elseif ($c.Path) { $c.Path } else { $null }
    if (-not $src) { continue }
    $shimSources += $src
    if ($src.ToLower().EndsWith('.exe')) { $cands += $src }
    else { $cands += (Parse-ShimTargets $src) }
}

# 2) 네이티브 설치본(.exe) 표준 위치
if ($env:USERPROFILE)  { $cands += (Join-Path $env:USERPROFILE '.local\bin\claude.exe') }
if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'Programs\claude\claude.exe') }

# 3) npm 전역 cli.js 표준 위치
try {
    $npmRoot = (& npm root -g 2>$null | Select-Object -First 1)
    if ($npmRoot) {
        $cands += (Join-Path $npmRoot '@anthropic-ai\claude-code\bin\claude.exe')
        $cands += (Join-Path $npmRoot '@anthropic-ai\claude-code\cli.js')
    }
} catch {}
if ($env:APPDATA) {
    $cands += (Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe')
    $cands += (Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code\cli.js')
}
# npm 전역 prefix가 Node 설치 폴더인 경우(요즘 흔함)
if ($env:ProgramFiles) { $cands += (Join-Path $env:ProgramFiles 'nodejs\node_modules\@anthropic-ai\claude-code\bin\claude.exe') }

# 실제 존재하는 첫 후보 채택
foreach ($p in $cands) { if ($p -and (Test-Path -LiteralPath $p)) { $claudeBin = $p; break } }

if ($claudeBin) {
    $env:CLAUDE_BIN = $claudeBin
    Write-Host "Claude CLI: $claudeBin" -ForegroundColor DarkGray
} else {
    Write-Host "경고: 실행 가능한 Claude CLI(claude.exe / cli.js)를 찾지 못했습니다." -ForegroundColor Yellow
    if ($shimSources.Count -gt 0) {
        Write-Host "  PATH에서 찾은 claude 항목:" -ForegroundColor DarkYellow
        $shimSources | Select-Object -Unique | ForEach-Object { Write-Host "    · $_" -ForegroundColor DarkYellow }
    } else {
        Write-Host "  PATH에서 claude를 전혀 찾지 못했습니다." -ForegroundColor DarkYellow
    }
    if ($cands.Count -gt 0) {
        Write-Host "  확인했지만 없던 실행 대상 후보:" -ForegroundColor DarkYellow
        $cands | Select-Object -Unique | ForEach-Object { Write-Host "    - $_" -ForegroundColor DarkYellow }
    }
    Write-Host "  → 해결: 아래 중 하나로 재설치 후, 컴퓨터 재부팅(또는 새 창)에서 다시 실행" -ForegroundColor Yellow
    Write-Host "     네이티브:  irm https://claude.ai/install.ps1 | iex" -ForegroundColor Yellow
    Write-Host "     npm:       npm install -g @anthropic-ai/claude-code" -ForegroundColor Yellow
    Write-Host "  (서버는 계속 시작하지만, CLI가 없으면 번역이 실패합니다)" -ForegroundColor Yellow
}

# ── 서버 본체 확인 ───────────────────────────────────────────────
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'translate-server.js'))) {
    Write-Host "오류: translate-server.js를 찾을 수 없습니다 ($PSScriptRoot)." -ForegroundColor Red
    Read-Host "아무 키나 누르면 종료합니다"; exit 1
}

# ── 기존 서버(:포트) 종료 ────────────────────────────────────────
try {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($conns) {
        Write-Host "기존 서버(:$port) 종료 중..."
        $conns | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
            Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1
    }
} catch {
    try {
        netstat -ano -p tcp | Select-String ":$port\s" | ForEach-Object {
            $cols = ($_.Line.Trim() -split '\s+')
            if ($cols[-2] -eq 'LISTENING') { Stop-Process -Id ([int]$cols[-1]) -Force -ErrorAction SilentlyContinue }
        }
    } catch {}
}

Write-Host "========================================"
Write-Host "  YouTube 자막 번역 서버 (claude -p)"
Write-Host "  포트: $port · 종료: Ctrl+C"
Write-Host "========================================"
Write-Host ""

$env:PORT = $port
& $nodePath translate-server.js

Write-Host ""
Write-Host "========================================"
Write-Host "  서버가 종료되었습니다."
Write-Host "========================================"
Read-Host "아무 키나 누르면 창을 닫습니다"
