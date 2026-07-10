<p align="center">
  <img src="icons/icon128.png" width="88" alt="">
</p>

<h1 align="center">YouTube AI Subtitle Translator</h1>

<p align="center">
  유튜브 자막을 AI로 번역해서 <b>스크립트 패널</b>과 <b>영상 위 자막</b>으로 보여주는 크롬 확장입니다.<br>
  번역 엔진은 직접 준비해서 사용합니다 — Claude 구독(CLI), 본인의 Gemini 또는 OpenAI API 키.<br>
  개발자가 운영하는 서버는 없습니다.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Manifest-V3-4285F4" alt="Manifest V3">
  <img src="https://img.shields.io/badge/Chrome-111%2B-34A853" alt="Chrome 111+">
  <img src="https://img.shields.io/badge/version-0.1.1-333333" alt="v0.1.1">
</p>

## 기능

| | |
|---|---|
| 스크립트 패널 | 시청 페이지 우측에 번역 자막 패널이 붙습니다. 타임스탬프 목록/문단 보기를 지원하고, 재생 위치를 하이라이트하며 자동 스크롤됩니다. 줄을 클릭하면 해당 시점으로 이동합니다. |
| 오버레이 자막 | 번역 자막을 영상 위에 직접 표시합니다. 교체/원문 병기 모드와 글자 크기 3단계를 지원하고, 극장·전체화면 모드를 따라가며 컨트롤바를 피해 표시됩니다. |
| 영상 요약 | TL;DR과 함께 클릭하면 이동되는 구간 타임라인을 만들어 줍니다. 짧게/표준/상세 3단계로 조절할 수 있고, 수준에 맞는 모델이 자동 선택됩니다. |
| 수동 우선 | 기본은 수동입니다. 번역 버튼을 누르기 전에는 아무것도 전송하지 않으므로 API 사용량을 직접 관리할 수 있습니다. (자동 번역은 옵션) |
| 로컬 캐시 | 번역·요약 결과를 영상별로 저장해 두어 다시 방문하면 즉시 표시됩니다. 검색·필터·개별/전체 삭제가 가능한 캐시 관리 화면도 내장되어 있습니다. |

## 동작 구조

```
YouTube 시청 페이지
 │  inject.js(MAIN world)가 자막(timedtext) 응답을 가로채고,
 │  플레이어 응답에서 자막 트랙 URL을 추출
 ▼
Service Worker ─ 정규화 → 청크 분할 → 병렬 번역 → 완료분부터 패널·오버레이에 반영
 │
 ├─▶ Claude CLI 서버  (localhost:8787, claude -p 호출) ← 기본
 ├─▶ Gemini API      (generateContent, 본인 키)
 └─▶ OpenAI API      (chat/completions, 본인 키)
```

자막은 세 가지 경로로 가져옵니다. ① 플레이어 응답의 트랙 URL로 직접 요청(CC를 켜지 않아도 됩니다) → ② 페이지의 자막 요청 가로채기 → ③ webRequest로 관찰한 URL 재요청. 세 경로가 모두 실패하면 CC를 잠깐 켜서 자막을 받아온 뒤 원래 상태로 되돌립니다.

## 설치

### 1. 확장 로드

`chrome://extensions` → 개발자 모드 ON → **압축해제된 확장 프로그램 로드** → 이 폴더를 선택합니다.

### 2. 번역 엔진 준비 (택1)

**Claude CLI — 기본.** Node.js 18+와 로그인된 Claude Code CLI가 필요합니다.

| 플랫폼 | 실행 |
|---|---|
| macOS | `server/start-server.command` 더블클릭 |
| Windows | `server/start-server.bat` 더블클릭 — 처음이라면 [SETUP-WINDOWS.md](server/SETUP-WINDOWS.md) 참고 |

서버는 의존성이 없어서 `npm install`이 필요 없습니다. 창에 "자가 테스트 통과"가 뜨면 준비 완료입니다.
환경변수, LAN 공유, "Not logged in" 해결 방법 등은 [server/README.md](server/README.md)에 정리되어 있습니다.

**Gemini API.** [Google AI Studio](https://aistudio.google.com/apikey)에서 키를 발급받아 패널 설정(⚙)에서 번역 경로를 Gemini로 바꾸고 키를 입력합니다. 무료 키라면 티어를 "무료"로 두세요 — 분당 호출 제한에 맞춰 요청 간격을 자동으로 조절합니다.

**OpenAI API.** [platform.openai.com](https://platform.openai.com/api-keys)에서 키를 발급받아 번역 경로를 OpenAI로 바꾸고 키를 입력합니다. OpenAI API는 무료 티어가 없어 결제 등록된 키가 필요합니다. 기본 모델은 gpt-5.4-mini이며 설정에서 바꿀 수 있습니다. 요약은 Claude 경로와 같은 자막 기반 방식으로 동작합니다 (OpenAI는 영상 URL 분석을 지원하지 않음).

## 사용법

자막(CC)이 있는 영상을 열면 우측에 패널이 나타납니다. **번역** 버튼을 누르면 시작되고, 완료된 부분부터 바로 표시됩니다. 요약은 요약 탭에서 수준을 고르고 실행하면 됩니다 — Gemini 경로에서는 자막 대신 영상 URL만 보내서 Gemini가 영상을 직접 분석합니다.

주요 설정(패널 ⚙):

| 설정 | 기본값 | 비고 |
|---|---|---|
| 번역 경로 | Claude CLI | Gemini 또는 OpenAI API로 전환할 수 있습니다 |
| 서버 주소 | `localhost:8787` | LAN의 다른 PC 주소도 입력할 수 있습니다 |
| 자동 번역 | 꺼짐 | 켜면 영상을 열 때 바로 번역합니다 |
| Gemini 티어 | 무료 | 무료/유료에 따라 호출 간격을 조절합니다 |
| 요약 수준 · 모델 | 표준 · 자동 | 자동 = 짧게는 haiku, 표준·상세는 sonnet |
| 오버레이 | 켜짐 · 교체 | 병기 모드, 글자 크기 소/중/대 |

## 프로젝트 구조

```
├─ manifest.json
├─ constants.js            셀렉터 · 메시지 타입 · 청크 한도 · 기본 설정 (단일 소스)
├─ inject.js               MAIN world — fetch/XHR 래핑으로 자막 응답 가로채기
├─ background.js           서비스 워커 진입점 (메시지 라우터)
├─ bg/
│   ├─ parsers.js          json3/vtt 파싱 · 정규화 (순수 함수)
│   ├─ capture.js          자막 취득 3경로 + 폴백
│   ├─ translation.js      번역 파이프라인 (청크 · 병렬 · 재시도 · 캐시) + Gemini 어댑터
│   └─ summary.js          요약 파이프라인 (map-reduce, 수준별 모델)
├─ content/
│   ├─ core.js             공유 상태 · 설정 · 유틸
│   ├─ panel.js            스크립트 패널 (목록/문단/요약 탭 · 설정 · 캐시 관리)
│   ├─ overlay.js          영상 위 자막 (교체/병기, rAF 동기화)
│   └─ main.js             컨트롤러 — 메시지 라우팅 · 재생 동기화 · SPA 대응
├─ popup.html · popup.js   액션 팝업 (전체 on/off)
└─ server/
    └─ translate-server.js  Claude CLI 번역 서버 (Node 내장 모듈만 사용)
```

## 구현 노트

- **청크 전략** — Claude 경로는 120세그먼트씩 처리하되, 첫 청크만 20세그먼트로 작게 잘라 영상 초반이 가장 먼저 표시되게 했습니다. Gemini 경로는 출력 토큰 한도가 커서 600세그먼트씩 크게 보내 무료 티어의 일일 호출 수를 아낍니다. 두 경로 모두 병렬 2로 처리합니다.
- **실패 격리** — 청크 하나가 실패해도 성공한 부분은 유지되고, 누락된 세그먼트만 자동으로 재시도합니다.
- **무료 티어 보호(Gemini)** — 호출 간 최소 간격을 지켜 429를 예방하고, 출력 한도에 걸리면 청크를 자동으로 반씩 쪼개 재시도합니다. 일일 무료 사용량 소진(RPD)은 분당 제한과 구분해서 화면에 안내합니다.
- **서비스 워커 수명** — MV3의 30초 idle 종료에 대비해, 번역 중에는 25초 간격 keepalive로 워커를 유지합니다.

## 개인정보

추적·분석 도구나 개발자 서버가 전혀 없습니다. 설정과 캐시는 브라우저 로컬(chrome.storage)에만 저장되고, 자막 텍스트는 사용자가 직접 고른 엔진(본인 로컬 서버 또는 Gemini API)으로만 전송됩니다. 전문은 [PRIVACY.md](PRIVACY.md)를 참고하세요.

## 문서

| 문서 | 내용 |
|---|---|
| [server/README.md](server/README.md) | 번역 서버 상세 — 환경변수, API 계약, 문제 해결 |
| [server/SETUP-WINDOWS.md](server/SETUP-WINDOWS.md) | Windows 처음 설치 가이드 |
| [docs/CHROME-WEBSTORE-GUIDE.md](docs/CHROME-WEBSTORE-GUIDE.md) | 크롬 웹스토어 등록 가이드 |
| [PRIVACY.md](PRIVACY.md) | 개인정보처리방침 (영문) |
