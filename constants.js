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
    // ── 디버그 뷰 ──
    DEBUG_GET: 'DEBUG_GET',               // content → bg: 디버그 로그/통계 요청 (sendResponse)
    DEBUG_CLEAR: 'DEBUG_CLEAR',           // content → bg: 디버그 로그 초기화
    // ── 액션 팝업 ──
    OPEN_SETTINGS: 'OPEN_SETTINGS',       // popup → content: 패널 설정 화면 열기
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
  // Claude(localhost) 경로: Udemy(transcriptByU)에서 검증된 프로파일로 정렬 —
  // 60세그 청크 × 병렬 3 (서버 세마포어 MAX_CONCURRENT=3과 일치).
  // - 120세그×2병렬 운용 결과: 청크당 출력 ~5K 토큰 → 한 덩어리 생성에 1분+
  //   걸려 체감이 느렸다. 60세그면 화면 갱신 주기가 절반으로 줄고, 청크 실패
  //   시 재시도 비용도 절반. 동시 부하는 60×3=180세그로 Udemy와 동일(TPM 안전).
  // - 속도의 나머지 절반은 서버의 --effort low (translate-server.js CLAUDE_EFFORT
  //   기본값 — Sonnet 5의 확장 사고를 끄면 번역 지연이 크게 준다).
  // FIRST: 첫 청크는 작게 잘라 영상 시작 부분이 가장 먼저 번역·표시되게 한다.
  // PARALLEL: "청크 출력 토큰 × 병렬 수"가 계정의 분당 처리율(TPM)을 넘으면
  // 생성 도중 끊기므로(레이트리밋 재시도 반복의 원인) 늘릴 때 주의.
  CHUNK_LOCALHOST: { SEGMENTS: 60, CHARS: 8000, FIRST: 20, PARALLEL: 3 },
  // Gemini 경로: 입력 1M/출력 65,536 토큰(공식 확인). 번역의 병목은 "출력"이다.
  // 고정 세그먼트 수 대신 영상의 실제 글자량을 재서 "예상 출력 토큰"이 예산에
  // 찰 때까지 한 요청에 담는다 (호출 횟수 절약 — 무료 티어 RPM/RPD 보호).
  // 예산 산정 기준은 토큰 한도가 아니라 "생성 시간": 32K 예산으로 운용해 보니
  // 879세그 영상이 1요청(출력 ~26K 토큰)이 되어 생성에만 ~2분 → 백엔드 5xx·
  // 타임아웃·진행률 0% 문제 발생(실측). 8K 예산이면 요청당 생성 ~30-40초로
  // 안정적이고, 같은 영상이 4요청 — 무료 RPD 대비 여전히 미미하다.
  // 추정이 빗나가 MAX_TOKENS로 잘리면 OUTPUT_LIMIT 이분할(translation.js)이 안전망.
  // FIRST(첫 청크 소형화) 없음 — 호출 수 절약이 첫 화면 속도보다 우선.
  CHUNK_GEMINI: {
    OUTPUT_TOKEN_BUDGET: 8000,  // 청크당 예상 출력 토큰 예산 (생성 ~30-40초 목표)
    EST_TOKENS_PER_CHAR: 0.6,   // 원문 1자 → 번역 출력 토큰 보수 추정 (EN→KO 기준 여유 포함)
    EST_TOKENS_PER_SEG: 8,      // 세그당 JSON 래퍼({"id":..,"text":".."}) 오버헤드
    PARALLEL: 2
  },
  // OpenAI 경로: Gemini와 동일한 토큰 예산 방식. 유료 API(Tier 1 = 500 RPM/500K TPM)라
  // 호출 횟수 압박은 없지만, 요청당 생성 시간 30-40초 목표는 동일하게 적용.
  CHUNK_OPENAI: {
    OUTPUT_TOKEN_BUDGET: 8000,
    EST_TOKENS_PER_CHAR: 0.6,
    EST_TOKENS_PER_SEG: 8,
    PARALLEL: 2
  },
  RETRY_BACKOFF_MS: [1000, 4000], // 지수 백오프 2회
  // 설계서 §6의 20s에서 상향: 대형 청크 + Sonnet 지연 대응.
  // SW 30s fetch 수명 규칙은 keepalive(25s 간격 API 호출)로 워커를 유지해 대응.
  LOCALHOST_TIMEOUT_MS: 180000, // 여유 상한 — 60세그+effort low면 보통 수십 초 내 완료 (Gemini 경로와 동일한 180s)

  // ── Gemini 경로 (공식 문서 확인: ai.google.dev, 2026-07 기준) ──
  GEMINI: {
    API_BASE: 'https://generativelanguage.googleapis.com/v1beta/models',
    // 구조화 출력(responseFormat) 지원 모델만 나열
    // 출처: https://ai.google.dev/gemini-api/docs/models ,
    //       https://ai.google.dev/gemini-api/docs/structured-output (Model support 표)
    MODELS: [
      'gemini-3.6-flash',      // 기본값 — 최신 안정판 (2026-07-21 출시, 3.5 대비 출력 토큰 -17%)
      'gemini-3.5-flash',      // 안정판, 최고 지능
      'gemini-3.5-flash-lite'  // 안정판, 저비용
    ],
    DEFAULT_MODEL: 'gemini-3.6-flash',
    // 사전 페이싱: 호출 간 최소 간격(ms) — 429를 맞기 전에 예방.
    // 무료 티어는 flash 계열 RPM이 한 자릿수~십수 회 수준(프로젝트 단위)이라 보수적으로.
    PACING: { free: 6500, paid: 400 }
  },

  // ── OpenAI 경로 (공식 문서 확인: developers.openai.com, 2026-07 기준) ──
  // - 엔드포인트: POST /v1/chat/completions (Authorization: Bearer <key>)
  // - 구조화 출력: response_format.json_schema (strict) — 루트는 객체여야 하며
  //   모든 object에 additionalProperties:false + 전 필드 required (변환기가 처리)
  // - 아래 모델 전부 최대 출력 128,000 토큰, 구조화 출력 지원 (모델 페이지 확인)
  // - API 무료 티어 없음(결제 필요), Tier 1 = 500 RPM/500K TPM → 사전 페이싱 불필요
  // - effort: 5.6 계열은 none(기본)~max 전 범위 허용.
  //   번역은 사고 불필요 → 'none'을 명시하고, 400(파라미터 거부) 시 제거 후 1회 폴백.
  OPENAI: {
    API_URL: 'https://api.openai.com/v1/chat/completions',
    MODELS: [
      { value: 'gpt-5.6-luna', label: 'gpt-5.6-luna (권장·저가·고속)', effort: 'none' },
      { value: 'gpt-5.6-terra', label: 'gpt-5.6-terra (균형)', effort: 'none' },
      { value: 'gpt-5.6-sol', label: 'gpt-5.6-sol (품질 우선)', effort: 'none' }
    ],
    DEFAULT_MODEL: 'gpt-5.6-luna',
    MAX_COMPLETION_TOKENS: 16384 // 과금 보호 상한 — 초과 시 finish_reason=length → 이분할
  },

  // ── 설정 기본값 (chrome.storage.local 'settings' 키) ───────
  DEFAULT_SETTINGS: {
    enabled: true,              // 전체 on/off (액션 팝업)
    autoTranslate: false,       // 기본 수동 — 패널의 '번역' 버튼을 눌렀을 때만 번역
    route: 'localhost',         // 'localhost'(Claude CLI 서버, 기본) | 'gemini' | 'openai'
    geminiApiKey: '',
    geminiModel: 'gemini-3.6-flash',
    geminiTier: 'free',         // 'free'(사전 페이싱 강함) | 'paid'(Tier 1+)
    openaiApiKey: '',
    openaiModel: 'gpt-5.6-luna',
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
    CACHE_PREFIX: 'cache', // cache|video_id|target_lang|route|model (번역 — 모델별 분리)
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

  // ── 대상 언어 (설정 select — 디자인 리뉴얼: 15개+) ──────────
  TARGET_LANGS: [
    ['ko', '한국어'], ['en', 'English'], ['ja', '日本語'],
    ['zh-CN', '中文(简体)'], ['zh-TW', '中文(繁體)'],
    ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'],
    ['pt', 'Português'], ['ru', 'Русский'], ['vi', 'Tiếng Việt'],
    ['th', 'ไทย'], ['id', 'Bahasa Indonesia'], ['hi', 'हिन्दी'],
    ['ar', 'العربية'], ['it', 'Italiano'], ['tr', 'Türkçe']
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

  /** 번역 엔진의 모델 식별자 — 캐시 키 분리용 (모델을 바꾸면 새로 번역) */
  engineModelTag(s) {
    if (s.route === 'gemini') return s.geminiModel || YTX.GEMINI.DEFAULT_MODEL;
    if (s.route === 'openai') return s.openaiModel || YTX.OPENAI.DEFAULT_MODEL;
    return 'cli'; // localhost — 모델은 서버 설정(CLAUDE_MODEL)이라 확장에서 알 수 없음
  },

  /** 번역 캐시 키 — content(캐시 조회/목록)와 bg(저장)가 공유. 모델별 분리 */
  cacheKey(videoId, targetLang, route, modelTag) {
    return `${YTX.STORAGE.CACHE_PREFIX}|${videoId}|${targetLang}|${route}|${modelTag || ''}`;
  },

  /** 같은 영상+언어의 캐시 키 접두어 — 모델/경로 무관 "완전 번역 재사용" 조회용.
   *  이미 번역이 끝난 영상은 엔진을 바꿔도 재번역하지 않는다 (토큰 절약).
   *  구 형식 키(cache|vid|lang|route)도 이 접두어에 걸려 그대로 재사용된다. */
  cacheKeyPrefix(videoId, targetLang) {
    return `${YTX.STORAGE.CACHE_PREFIX}|${videoId}|${targetLang}|`;
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
