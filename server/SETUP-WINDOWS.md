# Windows 설치·실행 가이드 (start-server.bat)

Windows에서 번역 서버를 처음 설치하고 `start-server.bat`으로 실행하기까지의 전체 과정입니다.
모든 명령은 **PowerShell**(시작 메뉴 → "PowerShell" 검색) 기준입니다.

---

## 0. 준비물 요약

| 필요한 것 | 용도 | 필수 여부 |
|---|---|---|
| Node.js 18+ | 번역 서버 실행 | 필수 |
| Claude Code CLI | 번역 엔진 (`claude -p`) | 필수 |
| Claude 로그인 (구독 계정) | CLI 인증 | 필수 |
| `npm install` | 없음 — **서버는 의존성 0개** (아래 참고) | 불필요 |

> 참고: 프로젝트 루트의 `package.json`은 에디터 자동완성용 타입 정의(@types/chrome)만 담고 있어
> **서버 실행에는 `npm install`이 필요 없습니다.** Node 내장 모듈만 사용합니다.
> (에디터에서 `chrome.*` 경고를 없애고 싶을 때만 루트에서 `npm install` 실행)

---

## 1. Node.js 설치

1. https://nodejs.org 접속 → **LTS** 버전 다운로드 → 설치 (기본 옵션 그대로)
2. 설치 확인:

```powershell
node --version   # v18 이상이면 OK (예: v22.x.x)
```

이미 nvm-windows 등을 쓰고 있다면 `nvm use <버전>`으로 18+ 활성화만 확인하면 됩니다.

## 2. Claude Code CLI 설치

**방법 A — 네이티브 설치 (공식 권장, Node 불필요·자동 업데이트):**

```powershell
irm https://claude.ai/install.ps1 | iex
```

**방법 B — npm 설치 (레거시, 여전히 동작):**

```powershell
npm install -g @anthropic-ai/claude-code
```

설치 확인:

```powershell
claude --version
```

> `claude`를 찾을 수 없다고 나오면 **PowerShell 창을 닫았다가 새로 열어** PATH를 갱신하세요.

## 3. Claude 로그인 (1회)

```powershell
claude
```

대화형 화면이 뜨면 `/login` 입력 → 브라우저에서 Claude 구독 계정으로 로그인.
완료 후 `Ctrl+C`로 종료. 확인:

```powershell
claude -p "hi"    # 짧은 응답이 나오면 인증 완료
```

## 4. 서버 실행

프로젝트의 `server` 폴더에서 **`start-server.bat` 더블클릭** — 끝입니다.

스크립트가 자동으로 처리하는 것: PowerShell 실행 정책 우회 → node/claude 탐지 →
기존 8787 포트 점유 프로세스 정리 → 서버 실행.

> **다른 PC로 옮겼을 때도 동작합니다.** 런처는 `node`/`claude`가 PATH에 없어도
> 표준 설치 위치를 자동 탐색합니다:
> - Node: `%ProgramFiles%\nodejs\node.exe`, `%LOCALAPPDATA%\Programs\nodejs`, nvm 등
> - Claude(네이티브): `%USERPROFILE%\.local\bin\claude.exe`
> - Claude(npm 전역): `node_modules\@anthropic-ai\claude-code\cli.js` — Node는 보안상 `.cmd`를
>   직접 실행하지 못하므로, 내부 `cli.js`를 찾아 `node`로 실행합니다.
>
> 네이티브 설치 후 PATH 등록이 누락돼도 새 창을 열 필요 없이 바로 실행되며,
> 모든 경로는 스크립트 위치 기준(상대)이라 폴더를 옮겨도 그대로 동작합니다.

정상 시작 로그 예시:

```
Claude CLI: x.x.x (Claude Code)
CLI 실행: C:\...\claude.exe  (또는  node ...\cli.js)
인증: CLI 로그인(OAuth) 사용 예정
translate-server 시작 — http://127.0.0.1:8787/translate (엔진: claude -p, 모델: sonnet)
인증 자가 테스트 중… (claude 1회 호출)
자가 테스트 통과 — 번역 요청을 처리할 준비가 되었습니다.
```

**"자가 테스트 통과"가 뜨면 준비 완료입니다.** 창은 켜 둔 채로 유튜브를 사용하세요.

다른 포트로 실행하려면:

```powershell
$env:PORT = "9000"; .\start-server.bat
```

(확장 설정의 "서버 주소"도 `localhost:9000`으로 맞춰야 합니다)

## 5. 크롬 확장 연결

1. `chrome://extensions` → 개발자 모드 ON → "압축해제된 확장 프로그램 로드" → 프로젝트 폴더 선택
2. 유튜브 영상 열기 → 패널 기어(⚙) → 번역 경로가 **Claude CLI**, 서버 주소가 `localhost:8787`인지 확인
3. 패널의 **번역** 버튼 클릭 → 번역이 진행되면 성공

---

## 문제 해결

| 증상 | 원인/해결 |
|---|---|
| 창이 뜨자마자 "node를 찾을 수 없습니다" | Node 미설치 또는 PATH 미갱신 — 1번 수행 후 새 창에서 재시도 |
| `자가 테스트 실패: ... 로그인 정보를 찾지 못했습니다` | 대개 3번(로그인) 미완료. 런처가 `%USERPROFILE%\.local\bin\claude.exe`를 자동으로 잡아 쓰므로, 그 claude로 `/login`을 마쳤는지 확인 (시작 로그의 `Claude CLI:` 경로 참고) |
| `자가 테스트 실패: 일시 제한` | 계정 처리율/사용량 제한 — 잠시 후 재시도 |
| .ps1 직접 더블클릭 시 아무 반응 없음 | 정상입니다 — **.bat을 더블클릭**하세요 (실행 정책 우회 포함) |
| 확장에서 "서버에 연결할 수 없습니다" | 서버 창이 꺼져 있거나 포트 불일치 — 4번 로그와 확장 설정의 서버 주소 확인 |
| 방화벽 허용 팝업 | "허용" 선택 (127.0.0.1 로컬 수신용) |

LAN의 다른 PC에서 이 서버를 쓰려면: `$env:HOST="0.0.0.0"; .\start-server.bat` 로 실행하고,
확장 설정의 서버 주소에 `<이 PC IP>:8787` 입력. (자세한 내용은 README.md 참고)
