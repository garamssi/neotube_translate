/**
 * content/core.js — 공유 상태 · 유틸리티 · 설정 저장소
 *
 * 콘텐츠 스크립트 계층 구조 (manifest 로드 순서 = 의존 방향):
 *   constants.js → core.js(상태/유틸) → panel.js(패널 뷰) → overlay.js(오버레이 뷰)
 *   → main.js(컨트롤러: 메시지 라우팅·비디오 동기화·마운트·내비게이션)
 *
 * 같은 isolated world에서 실행되므로 최상위 선언을 뒤 파일들이 공유한다.
 */
'use strict';

const log = (...a) => console.log(YTX.LOG, ...a);

/* ═══════════════════════════════════════════════════════════
 * 애플리케이션 상태 (단일 소스)
 * ═══════════════════════════════════════════════════════════ */
const state = {
  // 자막 (설계서 §3)
  videoId: '',
  caption: null,        // 표준 세그먼트 모델
  captionVia: '',       // 'intercept' | 'refetch' | 'proactive'
  noCaption: false,     // 취득 타임아웃 → '자막 없음' 상태

  // 번역 (설계서 §4)
  translations: {},     // id(string) → 번역 텍스트
  transPhase: 'idle',   // 'idle' | 'translating' | 'done' | 'error'
  doneSegments: 0,
  totalSegments: 0,
  failedChunks: [],
  lastError: null,      // { code, message }
  transSkipped: false,  // 동일 언어로 번역 생략됨
  routeLabel: '',
  targetLang: 'ko',

  // 요약 (수동 전용 — 번역과 독립)
  summaryLevel: 'standard', // 'brief' | 'standard' | 'detailed'
  summaryPhase: 'idle',     // 'idle' | 'loading' | 'done' | 'error'
  summaryByLevel: {},       // level → { tldr:[], sections:[] }
  summaryError: null,       // { code, message }
  summaryProgress: null,    // { done, total } — 긴 영상 분할 요약 진행
  summaryStartedAt: 0,      // 로딩 경과 시간 표시용
  summaryClaudeModel: 'auto', // 수준별 자동 매핑이 기본
  route: 'localhost',       // 요약 모델 셀렉트 노출 판단용

  // 패널 UI (설계서 §5)
  collapsed: false,
  mode: 'rows',         // 'rows' | 'para' | 'summary'
  bilingual: true,
  follow: true,
  followSuspended: false,
  activeSegId: -1,

  // 오버레이 (지시서 §6)
  overlayOn: true,
  overlayMode: 'replace',   // 'replace'(교체) | 'dual'(병기)
  overlayFontSize: 'md',    // 'sm' | 'md' | 'lg'

  // 설정 (M6)
  enabled: true,            // 전체 on/off (액션 팝업 연동)
  autoTranslate: false,     // 기본 수동 — '번역' 버튼으로 시작
  settingsOpen: false,
  cacheOpen: false,         // 캐시 관리 전용 뷰 (설정에서 진입)
  debugOpen: false,         // 디버그 로그 뷰 (설정에서 진입)
  settingsDraft: null,      // 설정 화면에서 편집 중인 값
  settingsSnapshot: null    // 열 때 스냅샷 — 닫을 때 재번역 필요 판단
};

const NO_CAPTION_TIMEOUT_MS = 10000;
let noCaptionTimer = null;

/* ═══════════════════════════════════════════════════════════
 * 유틸리티
 * ═══════════════════════════════════════════════════════════ */
function currentVideoId() {
  try {
    return new URL(location.href).searchParams.get('v') || '';
  } catch (e) {
    return '';
  }
}

function isDarkTheme() {
  return document.documentElement.hasAttribute('dark');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 정렬 배열 이진 탐색 — start <= t < end 인 세그먼트 (지시서 §6.3) */
function findActiveSegment(t) {
  const segs = state.caption?.segments;
  if (!segs || segs.length === 0) return -1;
  let lo = 0, hi = segs.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].start <= t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (ans >= 0 && t < segs[ans].end) return segs[ans].id;
  return -1;
}

/* ═══════════════════════════════════════════════════════════
 * 설정 저장소 (chrome.storage.local)
 * ═══════════════════════════════════════════════════════════ */
async function loadSettingsRaw() {
  try {
    const stored = await chrome.storage.local.get(YTX.STORAGE.SETTINGS);
    return YTX.normalizeSettings(stored[YTX.STORAGE.SETTINGS]);
  } catch (e) {
    return { ...YTX.DEFAULT_SETTINGS };
  }
}

/** 설정 로드 + 표시 기본값을 state에 반영 */
async function loadSettings() {
  const s = await loadSettingsRaw();
  state.mode = s.defMode;
  state.follow = s.defFollow;
  state.targetLang = s.targetLang;
  state.overlayOn = s.overlayOn;
  state.overlayMode = s.overlayMode;
  state.overlayFontSize = s.overlayFontSize;
  state.enabled = s.enabled;
  state.autoTranslate = s.autoTranslate;
  state.summaryLevel = s.summaryLevel;
  state.summaryClaudeModel = s.summaryClaudeModel;
  state.route = s.route;
  return s;
}

/** 현재 영상 제목 (캐시 목록 표시용) */
function getVideoTitle() {
  return (document.title || '').replace(/ - YouTube$/, '').trim();
}

/** 요약 요청 (수동 전용) — 원문 스크립트 + 제목 기반, 번역과 독립 */
function requestSummary(force) {
  if (!state.caption) return;
  state.summaryPhase = 'loading';
  state.summaryError = null;
  state.summaryProgress = null;
  state.summaryStartedAt = Date.now();
  chrome.runtime.sendMessage({
    type: YTX.MSG.SUMMARIZE_START,
    payload: {
      videoId: state.caption.video_id,
      title: getVideoTitle(),
      sourceLang: state.caption.source_lang,
      level: state.summaryLevel,
      force: !!force, // true면 캐시 무시하고 재생성
      segments: state.caption.segments.map((s) => ({ start: s.start, text: s.text }))
    }
  }).catch(() => {});
}

/** 번역 시작 요청 — 자동 모드 진입/수동 버튼/재시도 공용 */
function requestTranslation() {
  if (!state.caption) return;
  state.transPhase = 'translating';
  state.failedChunks = [];
  state.lastError = null;
  chrome.runtime.sendMessage({
    type: YTX.MSG.TRANSLATE_START,
    caption: state.caption,
    title: getVideoTitle() // 캐시 목록 표시용
  }).catch(() => {});
}

/** 설정 일부만 병합 저장 (§6.6) */
async function saveSettings(patch) {
  try {
    const stored = await chrome.storage.local.get(YTX.STORAGE.SETTINGS);
    const merged = { ...YTX.normalizeSettings(stored[YTX.STORAGE.SETTINGS]), ...patch };
    await chrome.storage.local.set({ [YTX.STORAGE.SETTINGS]: merged });
  } catch (e) { /* 저장 실패는 무시 (세션 내 상태는 유지됨) */ }
}
