# localhost 번역 서버 (Claude CLI 기반)

확장의 "localhost 서버" 번역 경로를 담당하는 로컬 서버입니다.
설계서 §6 계약(`POST /translate`)을 준수하며, 내부 번역 엔진으로 **Claude Code CLI**를 `claude -p`(print 모드)로 호출합니다.

## 요구사항

- Node.js 18+
- Claude Code CLI 설치 및 로그인 상태 (`claude` 실행 → `/login`)

## 실행

```bash
node translate-server.js            # 기본 포트 8787
node translate-server.js 9000       # 포트 지정
```

간편 실행 스크립트:

| 플랫폼 | 방법 |
|---|---|
| macOS | `start-server.command` 더블클릭 (nvm 자동 로드) 또는 `./start-server.command` |
| Windows | `start-server.bat` 더블클릭 (PowerShell 실행 정책 우회 포함) — 처음이라면 [SETUP-WINDOWS.md](./SETUP-WINDOWS.md) 참고 |

두 스크립트 모두 동일 동작: 기존 포트 점유 프로세스 정리 → 서버 실행 → 종료 시 창 유지.

환경변수:

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `8787` | 수신 포트 (확장 설정의 "서버 주소"와 일치시킬 것) |
| `HOST` | `127.0.0.1` | `0.0.0.0`으로 실행하면 LAN의 다른 기기에서 접근 가능 — 확장 "서버 주소"에 `<이 기기 IP>:8787` 입력 |
| `CLAUDE_MODEL` | `sonnet` (= Sonnet 5) | `--model`로 전달할 모델 별칭/이름. 빠른 응답이 필요하면 `haiku` (확장 타임아웃 20초 참고) |
| `CLAUDE_BIN` | `claude` | Claude CLI 실행 파일 경로 |

### "Not logged in" 오류가 날 때 (CLI 로그인/OAuth 사용 기준)

서버가 띄운 claude 프로세스가 **로그인 정보를 못 찾은** 경우입니다. API 키 문제가 아니라,
대부분 "터미널의 claude"와 "서버가 실행한 claude"가 **다른 설치본**인 경우입니다.

1. 서버 시작 로그의 `CLI 경로: ...` 줄과, 평소 쓰는 터미널에서 `which claude` 결과를 **비교**
   - 다르면: `CLAUDE_BIN=<로그인된 claude 경로> node translate-server.js` 로 실행
   - 예: `CLAUDE_BIN=~/.local/bin/claude node translate-server.js`
2. 같은 터미널에서 `claude -p "hi"` 가 되는지 확인 — 되면 그 터미널에서 서버를 실행
3. 서버를 터미널이 아닌 곳(IDE, pm2, launchd 등)에서 돌려야 한다면:
   ```bash
   claude setup-token   # 장기 OAuth 토큰 발급 (구독 로그인 기반, API 키 아님)
   CLAUDE_CODE_OAUTH_TOKEN=<발급 토큰> node translate-server.js
   ```

서버는 시작 시 자가 테스트(claude 1회 호출)를 수행해 "자가 테스트 통과/실패"를 로그로 알려줍니다.

## 확인

```bash
curl http://localhost:8787/health

curl -X POST http://localhost:8787/translate \
  -H 'Content-Type: application/json' \
  -d '{"video_id":"test","source_lang":"en","target_lang":"ko",
       "chunk":{"index":0,"total":1},
       "segments":[{"id":0,"start":0,"end":3,"text":"Hello everyone"}]}'
```

## 동작 방식

1. 확장이 청크(기본 40세그먼트) 단위로 `POST /translate` 요청
2. 서버가 `claude -p "<번역 지침 + 세그먼트 JSON>"` (argv 전달, 최소 옵션)을 실행 — `CLAUDE_MODEL` 지정 시에만 `--model` 추가
3. Claude 텍스트 응답에서 JSON 배열(`[{id, text}]`)을 추출(코드펜스 방어)해 계약 형식으로 반환
4. CLI 호출은 동시 1개로 직렬화 (확장도 청크를 순차 호출)

오류 매핑: 레이트리밋 → `429 RATE_LIMITED`(retry_after_ms 5000) · CLI 실패/미로그인/파싱 실패 → `502 UPSTREAM_ERROR` · 요청 형식 오류 → `400 BAD_REQUEST`.
부분 응답은 유효합니다 — 누락 id는 확장이 자동 재시도합니다.
