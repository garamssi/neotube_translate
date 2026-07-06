<p align="center">
  <img src="icons/icon128.png" width="88" alt="">
</p>

<h1 align="center">YouTube AI Subtitle Translator</h1>

<p align="center">
  유튜브 자막을 AI로 번역해서 <b>스크립트 패널</b>과 <b>영상 위 자막</b>으로 보여주는 크롬 확장.<br>
  번역 엔진은 내 것을 쓴다 — Claude 구독(CLI) 또는 본인의 Gemini API 키. 개발자 서버는 없다.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Manifest-V3-4285F4" alt="Manifest V3">
  <img src="https://img.shields.io/badge/Chrome-111%2B-34A853" alt="Chrome 111+">
  <img src="https://img.shields.io/badge/version-0.1.1-333333" alt="v0.1.1">
</p>

## 기능

| | |
|---|---|
| 스크립트 패널 | 시청 페이지 우측에 붙는 번역 자막 패널. 타임스탬프 목록/문단 보기, 재생 위치 하이라이트와 자동 스크롤, 줄 클릭으로 해당 시점 이동 |
| 오버레이 자막 | 번역 자막을 영상 위에 직접 렌더. 교체/원문 병기 모드, 글자 크기 3단계, 극장·전체화면 추종, 컨트롤바 회피 |
| 영상 요약 | TL;DR + 클릭하면 이동되는 구간 타임라인. 짧게/표준/상세 3단계, 수준별 모델 자동 매칭 |
| 수동 우선 | 기본은 수동 — 번역 버튼을 누르기 전엔 아무것도 전송하지 않는다 (자동 번역은 옵션) |
| 로컬 캐시 | 번역·요약 결과를 영상별로 저장해 재방문 시 즉시 표시. 검색·필터·개별/전체 삭제가 되는 캐시 관리 화면 내장 |

## 동작 구조

```
YouTube 시청 페이지
 │  inject.js(MAIN world)가 자막(timedtext) 응답을 가로채고,
 │  플레이어 응답에서 자막 트랙 URL을 추출
 ▼
Service Worker ─ 정규화 → 청크 분할 → 병렬 번역 → 완료분부터 패널·오버레이에 반영
 │
 ├─▶ Claude CLI 서버  (localhost:8787, claude -p 호출) ← 기본
 └─▶ Gemini API      (generateContent, 본인 키)
```

자막은 세 경로로 취득한다. ① 플레이어 응답의 트랙 URL로 능동 fetch(CC를 켜지 않아도 됨) → ② 페이지의 자막 요청 가로채기 → ③ webRequest로 관찰한 URL 재요청. 셋 다 실패하면 CC를 잠깐 켜서 받아온 뒤 원래 상태로 되돌린다.

## 설치

### 1. 확장 로드

`chrome://extensions` → 개발자 모드 ON → **압축해제된 확장 프로그램 로드** → 이 폴더 선택

### 2. 번역 엔진 준비 (택1)

**Claude CLI — 기본.** Node.js 18+와 로그인된 Claude Code CLI가 필요하다.

| 플랫폼 | 실행 |
|---|---|
| macOS | `server/start-server.command` 더블클릭 |
| Windows | `server/start-server.bat` 더블클릭 — 처음이면 [SETUP-WINDOWS.md](server/SETUP-WINDOWS.md) |

`npm install`은 필요 없다(서버 의존성 0개). 창에 "자가 테스트 통과"가 뜨면 준비 완료.
환경변수, LAN 공유, "Not logged in" 해결 등 상세는 [server/README.md](server/README.md).

**Gemini API.** [Google AI Studio](https://aistudio.google.com/apikey)에서 키 발급 → 패널 설정(⚙)에서 번역 경로를 Gemini로 바꾸고 키 입력. 무료 키라면 티어를 "무료"로 두면 분당 호출 제한에 맞춰 간격을 자동 조절한다.

## 사용법

자막(CC)이 있는 영상을 열면 우측에 패널이 나타난다. **번역** 버튼을 누르면 시작되고, 완료된 부분부터 바로 표시된다. 요약은 요약 탭에서 수준을 고르고 실행하면 된다 — Gemini 경로에서는 자막 대신 영상 URL만 보내 Gemini가 영상을 직접 분석한다.

주요 설정(패널 ⚙):

| 설정 | 기본값 | 비고 |
|---|---|---|
| 번역 경로 | Claude CLI | Gemini API로 전환 가능 |
| 서버 주소 | `localhost:8787` | LAN의 다른 PC 주소도 가능 |
| 자동 번역 | 꺼짐 | 켜면 영상을 열 때 바로 번역 |
| Gemini 티어 | 무료 | 무료/유료에 따라 호출 간격 조절 |
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

- **청크 전략** — Claude 경로는 120세그먼트씩, 첫 청크만 20세그먼트로 작게 잘라 영상 초반이 가장 먼저 표시된다. Gemini 경로는 출력 토큰 한도가 커서 600세그먼트씩 크게 보내 무료 티어의 일일 호출 수를 아낀다. 두 경로 모두 병렬 2.
- **실패 격리** — 청크 하나가 실패해도 성공분은 유지되고, 누락된 세그먼트만 자동 재시도한다.
- **무료 티어 보호(Gemini)** — 호출 간 최소 간격을 지켜 429를 예방하고, 출력 한도에 걸리면 청크를 자동으로 반씩 쪼개 재시도한다. 일일 무료 사용량 소진(RPD)은 분당 제한과 구분해 화면에 안내한다.
- **서비스 워커 수명** — MV3의 30초 idle 종료에 대비해 번역 중 25초 간격 keepalive로 워커를 유지한다.

## 개인정보

추적·분석·개발자 서버가 전혀 없다. 설정과 캐시는 브라우저 로컬(chrome.storage)에만 저장되고, 자막 텍스트는 사용자가 직접 고른 엔진(본인 로컬 서버 또는 Gemini API)으로만 전송된다. 전문: [PRIVACY.md](PRIVACY.md)

## 문서

| 문서 | 내용 |
|---|---|
| [server/README.md](server/README.md) | 번역 서버 상세 — 환경변수, API 계약, 문제 해결 |
| [server/SETUP-WINDOWS.md](server/SETUP-WINDOWS.md) | Windows 처음 설치 가이드 |
| [docs/CHROME-WEBSTORE-GUIDE.md](docs/CHROME-WEBSTORE-GUIDE.md) | 크롬 웹스토어 등록 가이드 |
| [PRIVACY.md](PRIVACY.md) | 개인정보처리방침 (영문) |
