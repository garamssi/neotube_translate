/**
 * constants.js — 공용 상수 모듈
 *
 * 지시서 §8: 유튜브 DOM 셀렉터는 변경될 수 있으므로 한 곳에 모아 관리한다.
 * - content script: manifest에서 content.js보다 먼저 로드되어 전역 YTX 사용 가능.
 * - service worker: background.js에서 importScripts('constants.js')로 로드.
 */
const YTX = {
  // ── 메시지 식별자 ──────────────────────────────────────────
  MSG_SOURCE: 'yt-sub-ext', // inject.js ↔ content.js postMessage 식별자

  // inject → content → background 메시지 타입
  MSG: {
    CAPTION_RAW: 'CAPTION_RAW',   // 가로챈 timedtext 원본 (content → bg)
    CAPTION_TRACKS: 'CAPTION_TRACKS', // 플레이어 응답의 자막 트랙 목록 — CC 없이 능동 취득용
    SEGMENTS: 'SEGMENTS',         // 정규화된 세그먼트 (bg → content)
    CAPTION_ERROR: 'CAPTION_ERROR',
    // ── 번역 파이프라인 (M3) ──
    TRANSLATE_START: 'TRANSLATE_START',   // content → bg: 번역 시작 요청 (caption 동봉)
    TRANS_STATUS: 'TRANS_STATUS',         // bg → content: 작업 시작/청크 수 안내
    TRANS_PROGRESS: 'TRANS_PROGRESS',     // bg → content: 청크 완료분 점진 전달
    TRANS_CHUNK_ERROR: 'TRANS_CHUNK_ERROR', // bg → content: 실패 청크 격리 통지
    TRANS_COMPLETE: 'TRANS_COMPLETE',     // bg → content: 전체 완료(부분 실패 포함)
    // ── 요약 ──
    SUMMARIZE_START: 'SUMMARIZE_START',   // content → bg: 요약 요청 (수동 전용)
    SUMMARY_PROGRESS: 'SUMMARY_PROGRESS', // bg → content: 긴 영상 분할 요약 진행 상황
    SUMMARY_COMPLETE: 'SUMMARY_COMPLETE', // bg → content: 요약 결과
    SUMMARY_ERROR: 'SUMMARY_ERROR',       // bg → content: 요약 실패
    // ── 엣지케이스 (M7) ──
    TAB_RESET: 'TAB_RESET'                // content → bg: SPA 내비게이션 — 탭 상태/작업 리셋
  },

  // ── 유튜브 DOM 셀렉터 (변경 가능성 있음 — 실측 확인 필요) ──
  SEL: {
    SECONDARY: '#secondary',                          // 우측 사이드 컬럼
    SECONDARY_INNER: '#secondary-inner',
    PLAYER: '#movie_player',                          // 플레이어 컨테이너
    PLAYER_FALLBACK: '.html5-video-player',
    VIDEO: 'video.html5-main-video',
    NATIVE_CAPTION: '.ytp-caption-window-container',  // 네이티브 자막 컨테이너
    CC_BUTTON: '.ytp-subtitles-button',               // 자막(CC) 토글 버튼
    CONTROLS_AUTOHIDE_CLASS: 'ytp-autohide',          // 컨트롤바 숨김 상태 클래스
    FULLSCREEN_CLASS: 'ytp-fullscreen',               // 플레이어 전체화면 상태 클래스
    WATCH_FLEXY: 'ytd-watch-flexy',                   // 시청 페이지 루트 (theater/fullscreen 속성 보유)
    THEATER_ATTR: 'theater',                          // 극장 모드 속성
    FULLSCREEN_ATTR: 'fullscreen'                     // 전체화면 속성
  },

  // ── 자막 취득 ──────────────────────────────────────────────
  TIMEDTEXT_URL_PATTERN: '*://*.youtube.com/api/timedtext*', // webRequest 관찰용
  TIMEDTEXT_KEYWORD: 'timedtext',                            // inject.js URL 매칭용
  FALLBACK_REFETCH_DELAY_MS: 4000, // B(인터셉트) 미도착 시 A(재fetch) 가동까지 대기
  CC_AUTO_ENABLE_DELAY_MS: 3000,   // 능동 취득 실패 시 CC 자동 켜기까지 대기

  // ── 번역 파이프라인 (설계서 §4에서 조정) ───────────────────
  // Claude(localhost) 경로: Sonnet 5 최대 출력 128K 토큰·컨텍스트 1M(공식 문서 확인).
  // 120세그먼트 청크의 번역 출력은 ~10K 토큰 수준 — 한도의 10% 미만으로 안정적.
  // 토큰이 아니라 지연이 병목이므로 청크를 더 키우기보다 병렬 3개와 조합하고,
  // 타임아웃을 함께 상향(아래). 더 키우려면 SEGMENTS만 조정하면 됨.
  // FIRST: 첫 청크는 작게 잘라 영상 시작 부분이 가장 먼저 번역·표시되게 한다.
  // PARALLEL: 동시 처리 청크 수 — "청크 출력 토큰 × 병렬 수"가 계정의 분당
  // 처리율(TPM)을 넘으면 생성 도중 끊기므로(레이트리밋 재시도 반복의 원인)
  // Claude 경로는 80세그먼트 × 2병렬로 처리율 예산 안에 맞춘다.
  CHUNK_LOCALHOST: { SEGMENTS: 80, CHARS: 10000, FIRST: 20, PARALLEL: 2 },
  // Gemini 경로: 입력 1M/출력 65K 토큰(공식 확인). 번역의 병목은 "출력"이며
  // 세그당 ~40토큰 → 600세그 출력 ≈ 2.4만 토큰(한도의 ~37%)로 안전.
  // 출력이 한도에 걸리면(MAX_TOKENS) 청크 자동 이분할로 방어(bg/translation.js).
  CHUNK_GEMINI: { SEGMENTS: 600, CHARS: 60000, FIRST: 20, PARALLEL: 2 },
  RETRY_BACKOFF_MS: [1000, 4000], // 지수 백오프 2회
  // 설계서 §6의 20s에서 상향: 대형 청크 + Sonnet 지연 대응.
  // SW 30s fetch 수명 규칙은 keepalive(25s 간격 API 호출)로 워커를 유지해 대응.
  LOCALHOST_TIMEOUT_MS: 150000,

  // ── Gemini 경로 (공식 문서 확인: ai.google.dev, 2026-06 기준) ──
  GEMINI: {
    API_BASE: 'https://generativelanguage.googleapis.com/v1beta/models',
    // 구조화 출력(responseFormat) 지원 모델만 나열
    // 출처: https://ai.google.dev/gemini-api/docs/models ,
    //       https://ai.google.dev/gemini-api/docs/structured-output (Model support 표)
    MODELS: [
      'gemini-3.5-flash',      // 기본값 — 안정판, 최고 성능
      'gemini-3.1-flash-lite', // 안정판, 저비용
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-pro'
    ],
    DEFAULT_MODEL: 'gemini-3.5-flash',
    // 사전 페이싱: 호출 간 최소 간격(ms) — 429를 맞기 전에 예방.
    // 무료 티어는 flash 계열 RPM이 한 자릿수~십수 회 수준(프로젝트 단위)이라 보수적으로.
    PACING: { free: 6500, paid: 400 }
  },

  // ── 설정 기본값 (chrome.storage.local 'settings' 키) ───────
  DEFAULT_SETTINGS: {
    enabled: true,              // 전체 on/off (액션 팝업)
    autoTranslate: false,       // 기본 수동 — 패널의 '번역' 버튼을 눌렀을 때만 번역
    route: 'localhost',         // 'localhost'(Claude CLI 서버, 기본) | 'gemini'
    geminiApiKey: '',
    geminiModel: 'gemini-3.5-flash',
    geminiTier: 'free',         // 'free'(사전 페이싱 강함) | 'paid'(Tier 1+)
    serverAddress: 'localhost:8787', // Claude CLI 서버 주소 (host:port, LAN 주소 가능)
    targetLang: 'ko',
    summaryLevel: 'standard',   // 요약 수준: 'brief'(짧게) | 'standard'(표준) | 'detailed'(상세)
    summaryClaudeModel: 'auto', // 'auto' = 수준별 자동 (짧게=haiku, 표준/상세=sonnet)
    defMode: 'rows',            // 패널 표시 모드 기본값
    defFollow: true,            // 자동 스크롤 기본값
    // 오버레이(M5, 지시서 §6.6)
    overlayOn: true,
    overlayMode: 'replace',     // 'replace'(교체) | 'dual'(병기)
    overlayFontSize: 'md'       // 'sm' | 'md' | 'lg'
  },

  // ── storage 키 ─────────────────────────────────────────────
  STORAGE: {
    SETTINGS: 'settings',
    CACHE_PREFIX: 'cache', // cache|video_id|target_lang|route (번역)
    SUM_PREFIX: 'sum'      // sum|video_id|target_lang|route|level (요약)
  },

  // ── 요약 수준 — 수준별 모델·effort 자동 매핑 ────────────────
  // 짧게: 단순 압축 → Haiku(빠름) / 표준·상세: Sonnet 5(품질),
  // 상세는 effort를 한 단계 올려 깊이 확보
  SUMMARY_LEVELS: [
    { value: 'brief', label: '짧게', model: 'haiku', effort: 'low' },
    { value: 'standard', label: '표준', model: 'sonnet', effort: 'low' },
    { value: 'detailed', label: '상세', model: 'sonnet', effort: 'medium' }
  ],

  // ── 요약용 Claude 모델 (CLI 별칭) — 'auto'는 수준별 매핑 사용 ──
  CLAUDE_SUMMARY_MODELS: [
    { value: 'auto', label: '자동 (수준별 권장)' },
    { value: 'haiku', label: 'Haiku (빠름)' },
    { value: 'sonnet', label: 'Sonnet 5 (정밀)' },
    { value: 'opus', label: 'Opus (최고 품질, 느림)' }
  ],

  // ── 로그 접두어 ────────────────────────────────────────────
  LOG: '[yt-sub-ext]',

  /* ── 설정 헬퍼 (content/bg 공용) ─────────────────────────── */
  /** 저장된 설정 → 기본값 병합 + 구버전 키 마이그레이션(port → serverAddress) */
  normalizeSettings(stored) {
    const s = { ...YTX.DEFAULT_SETTINGS, ...(stored || {}) };
    if ((!stored || !stored.serverAddress) && stored && stored.port) {
      s.serverAddress = `localhost:${stored.port}`; // 구버전 마이그레이션
    }
    delete s.port;
    return s;
  },

  /** 번역 캐시 키 — content(캐시 조회/목록)와 bg(저장)가 공유 */
  cacheKey(videoId, targetLang, route) {
    return `${YTX.STORAGE.CACHE_PREFIX}|${videoId}|${targetLang}|${route}`;
  },

  /** 요약 캐시 키 — 모델별 분리 (모델 전환 시 결과 혼합 방지) */
  sumKey(videoId, targetLang, route, model, level) {
    return `${YTX.STORAGE.SUM_PREFIX}|${videoId}|${targetLang}|${route}|${model}|${level}`;
  },

  /** 서버 주소 문자열 → base URL. 'localhost:8787' / '192.168.0.10:9000' / 'http://…' 허용 */
  buildServerBase(address) {
    let a = String(address || YTX.DEFAULT_SETTINGS.serverAddress).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(a)) a = `http://${a}`;
    return a;
  }
};

// service worker(importScripts)와 content script 양쪽에서 전역으로 노출
if (typeof self !== 'undefined') self.YTX = YTX;
