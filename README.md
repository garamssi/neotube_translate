# 유튜브 AI 번역 크롬 익스텐션

유튜브 자막을 가로채 AI로 번역하고, 우측 **스크립트 패널**과 **영상 자막 오버레이** 두 곳에 표시하는 Manifest V3 확장.
기준 문서: 설계서 v1, 스크립트 패널 목업, 구현 지시 프롬프트(우선).

## 설치

1. `chrome://extensions` → 개발자 모드 ON → "압축해제된 확장 프로그램 로드" → 이 폴더 선택
2. 번역 경로 준비 (기본: **Claude localhost 서버**)
   ```bash
   node server/translate-server.js     # 기본 포트 8787, Claude CLI 로그인 필요
   ```
   또는 패널 설정(⚙)에서 Gemini API 키 입력 후 Gemini 경로 선택
3. 자막(CC)이 있는 유튜브 영상 재생 → 자막 버튼 ON

## 파일 구성

계층별로 분리되어 있으며, 로드 순서(manifest의 js 배열 / importScripts)가 곧 의존 방향이다.

| 파일 | 역할 |
|---|---|
| `manifest.json` | MV3 선언, MAIN world 주입, 액션 팝업 |
| `constants.js` | 셀렉터·메시지 타입·설정 기본값·청크 한도 단일 모듈 |
| `inject.js` | (MAIN world) fetch/XHR 비파괴 래핑 — timedtext 인터셉트 + 플레이어 응답 트랙 추출 |
| `content/core.js` | 공유 상태 · 유틸 · 설정 저장소 |
| `content/panel.js` | 스크립트 패널 뷰 (DOM 생성 · 상태 5종 렌더 · 인라인 설정) |
| `content/overlay.js` | 영상 오버레이 뷰 (rAF 동기화 · 교체/병기) |
| `content/main.js` | 컨트롤러 — 메시지 라우팅 · 재생 동기화 · 마운트 · SPA/극장 처리 |
| `bg/parsers.js` | 자막 파싱·정규화 (json3/vtt, 순수 함수) |
| `bg/capture.js` | 자막 취득 3경로 (능동 취득 / 인터셉트 / webRequest 폴백) |
| `bg/translation.js` | 번역 오케스트레이터 (청크·병렬·재시도·캐시) + Gemini/localhost 어댑터 |
| `background.js` | 서비스 워커 진입점 (메시지 라우터) |
| `panel.css` / `overlay.css` | 목업 시각 사양 / 오버레이 스타일 |
| `popup.html` / `popup.js` | 액션 팝업 (전체 on/off + 경로 요약) |
| `server/translate-server.js` | Claude CLI(`claude -p`) 기반 localhost 번역 서버 (§6 계약) |

## 번역 경로

- **Claude (localhost, 기본)**: `POST http://localhost:{port}/translate` — 계약은 설계서 §6.
  서버 내부는 `claude -p --output-format json` 호출. 상세는 `server/README.md`.
- **Gemini API**: 사용자 키로 `generateContent` 직접 호출. 구조화 출력(`responseFormat`) 사용.
  모델 선택: gemini-3.5-flash(기본) / 3.1-flash-lite / 2.5-flash / 2.5-flash-lite / 2.5-pro
  (2026-06 공식 문서 기준 구조화 출력 지원 안정판)

## 수용 기준 체크리스트 (지시서 §7)

- [x] 자막 자동 취득·정규화 — B(인터셉트) 주경로 + A(webRequest 재fetch) 폴백. 파서 단위 테스트 통과
- [x] 패널이 플레이어 크기 변경 없이 `#secondary` 최상단에 삽입 (jsdom 검증)
- [x] Gemini/localhost 두 경로 번역 + 완료분부터 점진 표시 (모의 서버 테스트)
- [x] 청크 실패 격리 + 성공분 유지 (BAD_REQUEST 격리 테스트 통과)
- [x] 재방문 시 캐시 즉시 표시 (`video_id+target_lang+경로` 키)
- [x] 패널: 목록/문단, 원문 병기, 하이라이트, 자동 스크롤(+재활성 버튼), 클릭 seek
- [x] 오버레이: 재생 중 현재 구간 표시, 플레이어 내부 부착으로 전체화면/극장 추종
- [x] 오버레이 교체/병기, 폰트 소/중/대, on/off 토글
- [x] 오버레이 컨트롤바 회피 (`ytp-autohide` 관찰 → 상승)
- [x] 영상 전환(SPA) 시 패널·오버레이 리셋 + bg 작업 무효화(TAB_RESET)
- [x] 상태 5종 시각 구분 (취득중/번역중/완료/오류/자막없음)

주: 자동화 테스트(jsdom·모의 서버) 기준. 실제 유튜브 페이지에서의 최종 확인은 아래 실측 항목과 함께 수행 필요.

## 구현 시 택1 결정 사항 (지시서 §6.4, §6.7, §9)

- 병기 모드 원문: **원문·번역 모두 자체 오버레이 렌더** — 싱크 보장·유튜브 DOM 비의존 (overlay.css 주석)
- 교체 모드 미번역 구간: **원문 임시 표시** (이탤릭·회색)
- 자막 트랙 다중: **최신 트랙 우선(latest wins)** — 사용자의 CC 선택 = 번역 소스
- json3 `aAppend`(ASR 이어붙기) 이벤트: 스킵 처리, 실측 후 보강 (background.js 주석)

## 실측 확인 필요 (지시서 §9 — 코드에 "확인 필요" 주석)

- timedtext 기본 fmt·URL 파라미터·서명 만료 정책 (폴백 A 재fetch 시)
- ASR 자막의 `aAppend` 동작 — 텍스트 누락 관찰 시 병합 로직 보강
- 오버레이 z-index(36)와 컨트롤바 상승 오프셋(76px) — 유튜브 z-index 체계 실측
- 극장/미니플레이어별 오버레이 위치 미세조정

## 자동화 테스트 요약

파서(json3/vtt/XML 감지), 번역 파이프라인(청크·백오프·429·격리·캐시·부분 재개·누락 id 재시도),
Gemini 요청 형식, localhost 서버(계약·오류 코드), 오버레이(교체/병기·§6.2/6.3/6.7/6.8),
설정 UI(경로 전환·즉시 반영·재번역 트리거), 팝업 연동(on/off), M7(SPA·극장·전체화면·트랙 전환) — 전부 통과.
