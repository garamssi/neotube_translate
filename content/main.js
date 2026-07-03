/**
 * content/main.js — 컨트롤러
 *
 * 책임: inject↔background 메시지 라우팅, 재생 시간 동기화(하이라이트·자동
 * 스크롤·seek), 패널 마운트, 테마 추종, SPA 내비게이션 리셋, 극장/전체화면
 * 처리, 액션 팝업 연동, 초기화.
 */
'use strict';

/* ═══════════════════════════════════════════════════════════
 * inject.js(MAIN world) → background 중계 (M1)
 * ═══════════════════════════════════════════════════════════ */
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== YTX.MSG_SOURCE) return;

  // 시청 페이지에서만 중계 — 홈/검색의 미리보기 자막(timedtext)은 무시
  if (!location.pathname.startsWith('/watch')) return;

  if (data.type === 'caption') {
    chrome.runtime.sendMessage({
      type: YTX.MSG.CAPTION_RAW,
      url: data.payload.url,
      body: data.payload.body,
      pageVideoId: currentVideoId(),
      via: 'intercept'
    }).catch(() => { /* SW 슬립 직후 등 일시 실패 — 폴백 A가 커버 */ });
  } else if (data.type === 'tracks') {
    // 능동 취득: CC를 켜지 않아도 플레이어 응답의 트랙 목록으로 자막 확보
    const vid = currentVideoId();
    if (data.payload.videoId && data.payload.videoId !== vid) return; // 미리보기 등 방어
    chrome.runtime.sendMessage({
      type: YTX.MSG.CAPTION_TRACKS,
      videoId: data.payload.videoId || vid,
      tracks: data.payload.tracks
    }).catch(() => {});
  }
});

/* ═══════════════════════════════════════════════════════════
 * background → content 메시지 처리 (M1/M3)
 * ═══════════════════════════════════════════════════════════ */
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  switch (msg.type) {
    case YTX.MSG.SEGMENTS: return onSegments(msg);
    case YTX.MSG.TRANS_STATUS: return onTransStatus(msg);
    case YTX.MSG.TRANS_PROGRESS: return onTransProgress(msg);
    case YTX.MSG.TRANS_CHUNK_ERROR: return onTransChunkError(msg);
    case YTX.MSG.TRANS_COMPLETE: return onTransComplete(msg);
    case YTX.MSG.SUMMARY_PROGRESS: return onSummaryProgress(msg);
    case YTX.MSG.SUMMARY_COMPLETE: return onSummaryComplete(msg);
    case YTX.MSG.SUMMARY_ERROR: return onSummaryError(msg);
  }
});

function onSummaryProgress(msg) {
  if (msg.videoId !== state.videoId || msg.level !== state.summaryLevel) return;
  state.summaryProgress = { done: msg.done, total: msg.total };
  if (state.mode === 'summary' && state.summaryPhase === 'loading') renderPanelState();
}

function onSummaryComplete(msg) {
  if (msg.videoId !== state.videoId) return;
  state.summaryByLevel[msg.level] = msg.data;
  if (msg.level === state.summaryLevel) {
    state.summaryPhase = 'done';
    state.summaryProgress = null;
  }
  log(`요약 ${msg.fromCache ? '(캐시) ' : ''}수신 — [${msg.level}] TL;DR ${msg.data.tldr.length}줄, 섹션 ${msg.data.sections.length}개`);
  renderPanelState();
}

function onSummaryError(msg) {
  if (msg.videoId !== state.videoId || msg.level !== state.summaryLevel) return;
  state.summaryPhase = 'error';
  state.summaryError = { code: msg.code, message: msg.message };
  state.summaryProgress = null;
  renderPanelState();
}

function onSegments(msg) {
  const d = msg.data;
  // 시청 페이지가 아니면 무시 (홈 미리보기 등에서 번역 트리거 방지)
  if (!location.pathname.startsWith('/watch')) {
    log(`시청 페이지 아님 — 세그먼트 무시 (${d.video_id})`);
    return;
  }
  // 현재 시청 중인 영상과 불일치하면 무시 (미리보기·지연 도착 방어)
  if (!d.video_id || d.video_id !== currentVideoId()) {
    log(`다른 영상(${d.video_id})의 세그먼트 도착 — 무시`);
    return;
  }
  // M7 자막 트랙 다중 정책: "최신 트랙 우선(latest wins)" —
  // 사용자가 CC 메뉴에서 트랙을 바꾸면 그것이 곧 번역 소스가 된다.
  if (state.caption && state.caption.video_id === d.video_id
      && state.caption.source_lang !== d.source_lang) {
    log(`자막 트랙 전환 감지: ${state.caption.source_lang} → ${d.source_lang} (최신 트랙 우선)`);
  }

  clearTimeout(noCaptionTimer);
  state.noCaption = false;
  state.caption = d;
  state.captionVia = msg.via;
  state.videoId = d.video_id;
  restoreCcIfForced(); // CC 자동 켜기로 취득했다면 원래 상태(꺼짐)로 복구
  log(`세그먼트 수신 — ${d.video_id} [${d.source_lang}/${d.format}] via=${msg.via}, ${d.segments.length}개`);

  state.translations = {};
  state.doneSegments = 0;
  state.totalSegments = d.segments.length;
  state.failedChunks = [];
  state.lastError = null;
  state.transSkipped = false;

  if (state.autoTranslate) {
    requestTranslation(); // 자동 모드: 즉시 번역 시작
  } else {
    state.transPhase = 'ready'; // 수동 모드: '번역' 버튼 대기
    applyCachedIfAvailable(d); // 단, 캐시가 있으면 즉시 적용 (비용 0)
  }

  renderPanelState();
  bindVideo();
  syncOverlay(); // §6.7 — 세그먼트 확보 시점에 오버레이 (재)바인딩
}

/**
 * 수동 모드 캐시 적용 — 이미 번역해 둔 영상이면 버튼 없이 즉시 표시.
 * 완전 캐시 → 완료 상태 / 부분 캐시 → 번역분만 채우고 나머지는 버튼으로.
 * 원문이 이미 대상 언어인 경우도 비용이 없으므로 즉시 처리(번역 생략 경로).
 */
async function applyCachedIfAvailable(caption) {
  try {
    const s = await loadSettingsRaw();

    // 동일 언어: 번역 생략 경로라 비용 0 → 수동 모드여도 바로 처리
    const srcBase = (caption.source_lang || '').split('-')[0].toLowerCase();
    if (srcBase && srcBase === (s.targetLang || '').split('-')[0].toLowerCase()) {
      requestTranslation();
      renderPanelState();
      return;
    }

    const key = YTX.cacheKey(caption.video_id, s.targetLang, s.route);
    const wrap = await chrome.storage.local.get(key);
    const cached = wrap[key];
    if (!cached || !cached.map || Object.keys(cached.map).length === 0) return;

    // 그 사이 상태가 바뀌었으면(영상 전환·수동 시작 등) 적용하지 않음
    if (state.videoId !== caption.video_id || state.transPhase !== 'ready') return;

    Object.assign(state.translations, cached.map);
    state.doneSegments = Object.keys(state.translations).length;
    state.routeLabel = `캐시 (${s.route === 'gemini' ? 'Gemini' : 'Claude CLI'})`;
    state.targetLang = s.targetLang;
    if (cached.complete) {
      state.transPhase = 'done'; // 완전 캐시 → 번역 버튼 불필요
      log(`수동 모드 — 캐시 적용(완전, ${state.doneSegments}개)`);
    } else {
      log(`수동 모드 — 캐시 적용(부분, ${state.doneSegments}개) · 나머지는 번역 버튼으로`);
    }
    renderPanelState();
    refreshOverlayText();
  } catch (e) { /* 캐시 조회 실패 시 그냥 대기 상태 유지 */ }
}

function onTransStatus(msg) {
  if (msg.videoId !== state.videoId) return;
  state.transPhase = 'translating';
  state.doneSegments = msg.doneSegments;
  state.totalSegments = msg.totalSegments;
  state.routeLabel = msg.routeLabel;
  state.targetLang = msg.targetLang || state.targetLang;
  if (msg.translations && Object.keys(msg.translations).length) {
    Object.assign(state.translations, msg.translations); // 부분 캐시 즉시 반영
  }
  renderPanelState();
}

function onTransProgress(msg) {
  if (msg.videoId !== state.videoId) return;
  Object.assign(state.translations, msg.translations || {});
  state.doneSegments = msg.doneSegments;
  state.totalSegments = msg.totalSegments;
  state.routeLabel = msg.routeLabel;
  applyTranslations(Object.keys(msg.translations || {})); // 인플레이스 갱신 (스크롤 보존)
  updateProgressHeader();
  renderFooter();
}

function onTransChunkError(msg) {
  if (msg.videoId !== state.videoId) return;
  state.failedChunks.push({ index: msg.chunkIndex, code: msg.code, message: msg.message });
  state.lastError = { code: msg.code, message: msg.message };
  if (msg.chunkIndex === -1) state.transPhase = 'error'; // 작업 자체가 시작 불가
  state.routeLabel = msg.routeLabel || state.routeLabel;
  renderPanelState();
}

function onTransComplete(msg) {
  if (msg.videoId !== state.videoId) return;
  state.transSkipped = !!msg.skipped; // 동일 언어 → 번역 생략 (원문 그대로)
  Object.assign(state.translations, msg.translations || {});
  state.doneSegments = Object.keys(state.translations).length;
  state.failedChunks = msg.failedChunks || [];
  state.routeLabel = msg.routeLabel;
  state.targetLang = msg.targetLang || state.targetLang;
  state.transPhase = state.doneSegments > 0 ? 'done' : 'error';
  log(`번역 ${msg.fromCache ? '(캐시) ' : ''}완료 — ${state.doneSegments}/${state.totalSegments || state.caption?.segments.length}`);
  renderPanelState();
  refreshOverlayText(); // 오버레이에 떠 있는 구간도 최종 번역으로 갱신
}

/* ═══════════════════════════════════════════════════════════
 * 재생 시간 동기화 (M4) — 하이라이트 · 자동 스크롤 · seek
 * ═══════════════════════════════════════════════════════════ */
let videoEl = null;

function getVideo() {
  return document.querySelector(YTX.SEL.VIDEO) || document.querySelector('video');
}

function bindVideo() {
  const v = getVideo();
  if (!v || v === videoEl) return;
  if (videoEl) {
    videoEl.removeEventListener('timeupdate', onTimeUpdate);
    videoEl.removeEventListener('play', onVideoPlay);
    videoEl.removeEventListener('pause', onVideoPauseLike);
    videoEl.removeEventListener('ended', onVideoPauseLike);
    videoEl.removeEventListener('seeked', onVideoSeeked);
  }
  videoEl = v;
  // 패널 하이라이트는 세그먼트 단위 해상도면 충분 → timeupdate(~4Hz).
  // (프레임 단위가 필요한 오버레이는 rAF 루프로 별도 처리 — §6.8)
  videoEl.addEventListener('timeupdate', onTimeUpdate);
  videoEl.addEventListener('play', onVideoPlay);
  videoEl.addEventListener('pause', onVideoPauseLike);
  videoEl.addEventListener('ended', onVideoPauseLike);
  videoEl.addEventListener('seeked', onVideoSeeked);
}

function onTimeUpdate() { updateActiveHighlight(false); }
function onVideoPlay() { startOverlayLoop(); }
function onVideoPauseLike() {
  stopOverlayLoop();          // 일시정지 중 rAF 정지 (§6.8)
  refreshOverlayText();       // 현재 구간은 유지 표시
}
function onVideoSeeked() {
  refreshOverlayText();       // 정지 상태 seek에도 즉시 반영
  updateActiveHighlight(true);
}

function updateActiveHighlight(force) {
  if (!panelEl || !state.caption || !videoEl) return;
  const id = findActiveSegment(videoEl.currentTime);
  if (id === state.activeSegId && !force) return;

  const body = panelEl.querySelector('[data-ytx="body"]');
  if (state.activeSegId >= 0) {
    body.querySelector(`[data-seg="${state.activeSegId}"]`)?.classList.remove('ytx-active');
  }
  state.activeSegId = id;
  if (id >= 0) {
    body.querySelector(`[data-seg="${id}"]`)?.classList.add('ytx-active');
    scrollToActive(false);
  }
}

function scrollToActive(force) {
  if (!panelEl || state.activeSegId < 0) return;
  if (!force && (!state.follow || state.followSuspended)) return;
  const body = panelEl.querySelector('[data-ytx="body"]');
  const el = body.querySelector(`[data-seg="${state.activeSegId}"]`);
  if (!el) return;
  const top = el.offsetTop - body.clientHeight / 2 + el.offsetHeight / 2;
  body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function seekTo(segId) {
  const seg = state.caption?.segments.find((s) => s.id === segId);
  if (!seg) return;
  bindVideo();
  if (videoEl) {
    videoEl.currentTime = seg.start + 0.01;
    updateActiveHighlight(true);
  }
}

/** 초 단위 직접 seek (요약 섹션 타임스탬프 클릭용) */
function seekToTime(sec) {
  bindVideo();
  if (videoEl) {
    videoEl.currentTime = Math.max(0, sec);
    updateActiveHighlight(true);
    refreshOverlayText();
  }
}

/* ═══════════════════════════════════════════════════════════
 * 마운트 · 테마 · SPA 내비게이션 · 극장/전체화면 (M2/M7)
 * ═══════════════════════════════════════════════════════════ */
function armNoCaptionTimer() {
  clearTimeout(noCaptionTimer);
  state.noCaption = false;
  noCaptionTimer = setTimeout(() => {
    if (!state.caption) {
      state.noCaption = true;
      renderPanelState();
    }
  }, NO_CAPTION_TIMEOUT_MS);
  armCcAutoEnable();
}

/* ═══════════════════════════════════════════════════════════
 * CC 자동 켜기 폴백 — 능동 취득이 실패한 영상 대응
 *
 * 능동 취득(baseUrl fetch)이 서명/POT 정책으로 빈 응답을 주는 영상이
 * 있어, 일정 시간 내 자막 미확보 시 CC 버튼을 잠깐 켜서 인터셉트(B)로
 * 취득한 뒤 원래 상태(꺼짐)로 되돌린다.
 * - 비공개 플레이어 API 대신 접근성 속성(aria-pressed) 기반 클릭 (안정성)
 * - 켜기 전 네이티브 자막 숨김 클래스를 선적용해 화면 번쩍임 방지
 * - 자막 없는 영상(버튼 없음/비활성)은 건너뜀 → 기존 '자막 없음' 흐름
 * ═══════════════════════════════════════════════════════════ */
let ccAutoTimer = null;
let ccForcedOn = false; // 우리가 켠 상태 (취득 후 원복 대상)

function armCcAutoEnable() {
  clearTimeout(ccAutoTimer);
  ccAutoTimer = setTimeout(() => {
    if (state.caption || !state.enabled) return; // 이미 확보(능동/인터셉트) 시 불필요
    tryEnableCcForCapture();
  }, YTX.CC_AUTO_ENABLE_DELAY_MS);
}

function tryEnableCcForCapture() {
  const btn = document.querySelector(YTX.SEL.CC_BUTTON);
  if (!btn) return; // 플레이어 미준비 — 10초 노캡션 타이머가 후속 처리
  if (btn.getAttribute('aria-disabled') === 'true') return; // 자막 없는 영상
  if (btn.getAttribute('aria-pressed') === 'true') return;  // 이미 켜져 있는데 미확보 — 다른 원인

  // 번쩍임 방지: 켜기 전에 네이티브 자막 숨김 (자막 확보 후 syncOverlay가 상태 재정리)
  getPlayer()?.classList.add('ytx-hide-native');
  btn.click();
  ccForcedOn = true;
  log('자막 미확보 — CC 자동 켜기 (취득 후 원상 복구)');
}

/** 자막 확보 후: 우리가 켠 CC를 원래 상태(꺼짐)로 되돌림 */
function restoreCcIfForced() {
  clearTimeout(ccAutoTimer);
  if (!ccForcedOn) return;
  ccForcedOn = false;
  const btn = document.querySelector(YTX.SEL.CC_BUTTON);
  if (btn && btn.getAttribute('aria-pressed') === 'true') {
    btn.click();
    log('자막 확보 완료 — CC 원상 복구(끔)');
  }
  // 오버레이 미사용 상태라면 임시 숨김 클래스 제거 (사용 중이면 syncOverlay가 유지)
  if (!(state.enabled && state.overlayOn && state.caption)) {
    getPlayer()?.classList.remove('ytx-hide-native');
  }
}

function mountPanel() {
  if (!state.enabled) return; // 전체 off (액션 팝업)
  if (!location.pathname.startsWith('/watch')) return;

  const secondary = document.querySelector(YTX.SEL.SECONDARY_INNER)
    || document.querySelector(YTX.SEL.SECONDARY);
  if (!secondary) return;
  if (document.getElementById(PANEL_ID)) { bindVideo(); return; }

  panelEl = buildPanel();
  secondary.insertBefore(panelEl, secondary.firstChild); // 추천 목록 위 (설계서 §5)
  renderPanelState();
  bindVideo();
  armNoCaptionTimer();
  observeWatchFlexy(); // M7: 극장/전체화면 감시
  log('패널 삽입 완료 (#secondary 최상단)');
}

const mountObserver = new MutationObserver(() => mountPanel());

function startMountObserver() {
  mountPanel();
  mountObserver.observe(document.documentElement, { childList: true, subtree: true });
}

/* ── 테마 추종: html[dark] 관찰 (설계서 §5) ─────────────────── */
new MutationObserver(() => {
  if (panelEl) panelEl.dataset.ytxTheme = isDarkTheme() ? 'dark' : 'light';
}).observe(document.documentElement, { attributes: true, attributeFilter: ['dark'] });

/* ── 액션 팝업 연동: 전체 on/off 반영 (M6) ──────────────────── */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[YTX.STORAGE.SETTINGS]) return;
  const next = { ...YTX.DEFAULT_SETTINGS, ...(changes[YTX.STORAGE.SETTINGS].newValue || {}) };
  if (next.enabled === state.enabled) return;

  state.enabled = next.enabled;
  if (!state.enabled) {
    panelEl?.remove();
    panelEl = null;
    syncOverlay(); // 오버레이 제거 + 네이티브 자막 복원
    log('확장 비활성화됨 (팝업)');
  } else {
    mountPanel();
    syncOverlay();
    log('확장 활성화됨 (팝업)');
  }
});

/* ── M7: SPA 내비게이션 정밀 리셋 ───────────────────────────── */
window.addEventListener('yt-navigate-finish', () => {
  // watch 이탈(홈/검색 등): 패널·오버레이 완전 제거
  if (!location.pathname.startsWith('/watch')) {
    clearTimeout(noCaptionTimer);
    clearTimeout(ccAutoTimer);
    ccForcedOn = false;
    panelEl?.remove();
    panelEl = null;
    state.caption = null;
    state.videoId = '';
    syncOverlay();
    return;
  }

  const vid = currentVideoId();
  if (vid && vid !== state.videoId) {
    // 영상 전환: content 상태 리셋 + background 탭 상태/작업 리셋
    ccForcedOn = false; // 이전 영상에서 켠 CC는 그대로 두고 상태만 리셋 (새 영상에서 재판단)
    chrome.runtime.sendMessage({ type: YTX.MSG.TAB_RESET }).catch(() => {});
    state.caption = null;
    state.captionVia = '';
    state.videoId = vid;
    state.translations = {};
    state.transPhase = 'idle';
    state.failedChunks = [];
    state.lastError = null;
    state.activeSegId = -1;
    state.followSuspended = false;
    state.settingsOpen = false;
    state.cacheOpen = false;
    state.summaryPhase = 'idle';
    state.summaryByLevel = {};
    state.summaryError = null;
    state.summaryProgress = null;
    syncOverlay(); // §6.7 — 오버레이 제거 후 세그먼트 도착 시 재생성
    renderPanelState();
    armNoCaptionTimer();
  }
  mountPanel();
  bindVideo();
  observeWatchFlexy();
});

/* ── M7: 극장/전체화면 — 패널 숨김 (설계서 §5, 1차 범위)
 * 오버레이는 플레이어 내부에 있으므로 계속 표시된다(§6의 핵심). */
let watchFlexyEl = null;
let watchFlexyObserver = null;

function observeWatchFlexy() {
  const flexy = document.querySelector(YTX.SEL.WATCH_FLEXY);
  if (!flexy || flexy === watchFlexyEl) { syncPanelVisibility(); return; }
  watchFlexyEl = flexy;
  watchFlexyObserver?.disconnect();
  watchFlexyObserver = new MutationObserver(syncPanelVisibility);
  watchFlexyObserver.observe(flexy, {
    attributes: true,
    attributeFilter: [YTX.SEL.THEATER_ATTR, YTX.SEL.FULLSCREEN_ATTR]
  });
  syncPanelVisibility();
}

function syncPanelVisibility() {
  if (!panelEl || !watchFlexyEl) return;
  const hide = watchFlexyEl.hasAttribute(YTX.SEL.THEATER_ATTR)
    || watchFlexyEl.hasAttribute(YTX.SEL.FULLSCREEN_ATTR);
  panelEl.classList.toggle('ytx-hidden', hide);
}

/* ── 초기화 ─────────────────────────────────────────────────── */
loadSettings().then(() => {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startMountObserver, { once: true });
  } else {
    startMountObserver();
  }
});

log('content script 로드됨 (core/panel/overlay/main)');
