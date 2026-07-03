/**
 * content/overlay.js — 번역 자막 영상 오버레이 뷰 (지시서 §6)
 *
 * - 플레이어 컨테이너 내부 부착 → 전체화면/극장/미니플레이어 추종 (§6.1)
 * - 컨트롤바 표시 중 오버레이 상승 (§6.2)
 * - rAF 동기화: 재생 중에만 루프, 세그먼트 변경 시에만 DOM 갱신 (§6.3, §6.8)
 * - 교체/병기 모드 — 둘 다 자체 렌더, 네이티브 자막 숨김 (§6.4)
 * - 미번역 구간: 원문 임시 표시 (§6.7 채택 정책)
 */
'use strict';

let overlayEl = null;
let overlayInner = null;
let overlayMain = null;
let overlaySrc = null;
let overlaySegId = -2;   // 현재 표시 중인 세그먼트 (-1=없음, -2=미초기화)
let overlayRafId = 0;
let playerEl = null;
let playerClassObserver = null;

function getPlayer() {
  return document.querySelector(YTX.SEL.PLAYER) || document.querySelector(YTX.SEL.PLAYER_FALLBACK);
}

/** 오버레이 DOM 생성/재부착 (§6.1 — body가 아닌 플레이어 내부) */
function ensureOverlay() {
  const player = getPlayer();
  if (!player) return false;
  playerEl = player;

  if (overlayEl && player.contains(overlayEl)) return true;
  overlayEl?.remove();

  overlayEl = document.createElement('div');
  overlayEl.className = 'ytx-overlay';
  overlayEl.dataset.ytxFont = state.overlayFontSize;
  overlayEl.innerHTML = `
    <div class="ytx-overlay-inner" hidden>
      <span class="ytx-overlay-line ytx-overlay-src" hidden></span>
      <span class="ytx-overlay-line ytx-overlay-main"></span>
    </div>`;
  player.appendChild(overlayEl);
  overlayInner = overlayEl.querySelector('.ytx-overlay-inner');
  overlaySrc = overlayEl.querySelector('.ytx-overlay-src');
  overlayMain = overlayEl.querySelector('.ytx-overlay-main');
  overlaySegId = -2;

  // 플레이어 class 관찰: 컨트롤바 표시(ytp-autohide 해제)·전체화면 감지 (§6.2)
  playerClassObserver?.disconnect();
  playerClassObserver = new MutationObserver(syncPlayerChrome);
  playerClassObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
  syncPlayerChrome();
  return true;
}

function syncPlayerChrome() {
  if (!overlayEl || !playerEl) return;
  // ytp-autohide가 없으면 컨트롤바가 보이는 상태 → 오버레이 상승 (§6.2)
  overlayEl.classList.toggle(
    'ytx-controls-visible',
    !playerEl.classList.contains(YTX.SEL.CONTROLS_AUTOHIDE_CLASS)
  );
  overlayEl.classList.toggle(
    'ytx-fullscreen',
    playerEl.classList.contains(YTX.SEL.FULLSCREEN_CLASS)
  );
}

/**
 * 오버레이 전체 동기화 — on/off·자막 유무·설정 변경 시 호출.
 * off 또는 자막 없음 → DOM 제거 + 네이티브 자막 복원 (§6.6, §6.7)
 */
function syncOverlay() {
  const shouldShow = state.enabled && state.overlayOn && !!state.caption;
  const player = getPlayer();

  if (!shouldShow) {
    stopOverlayLoop();
    overlayEl?.remove();
    overlayEl = null;
    playerClassObserver?.disconnect();
    playerClassObserver = null;
    player?.classList.remove('ytx-hide-native'); // 네이티브 자막 복원
    overlaySegId = -2;
    return;
  }

  if (!ensureOverlay()) return;
  overlayEl.dataset.ytxFont = state.overlayFontSize;
  // 교체/병기 모두 자체 렌더 방식 → 네이티브 자막 숨겨 겹침 방지 (§6.4)
  playerEl.classList.add('ytx-hide-native');
  refreshOverlayText();
  startOverlayLoop();
}

/** 현재 재생 시간 기준 강제 갱신 (seek·번역 도착·모드 변경 시) */
function refreshOverlayText() {
  if (!overlayEl || !videoEl) return;
  setOverlaySegment(findActiveSegment(videoEl.currentTime), true);
}

/** 활성 세그먼트 변경 시에만 DOM 텍스트 갱신 (§6.8) */
function setOverlaySegment(id, force) {
  if (!overlayInner) return;
  if (id === overlaySegId && !force) return;
  overlaySegId = id;

  if (id < 0) {
    overlayInner.hidden = true; // 활성 세그먼트 없음 → 비움 (§6.3 잔상 방지)
    return;
  }

  // 파서가 id를 배열 인덱스로 부여하므로 O(1) 접근, 방어적으로 검증
  const segs = state.caption.segments;
  const seg = (segs[id] && segs[id].id === id) ? segs[id] : segs.find((s) => s.id === id);
  if (!seg) { overlayInner.hidden = true; return; }

  const tr = state.translations[String(id)];

  if (state.overlayMode === 'dual') {
    // 병기: 원문(위) + 번역(아래). 번역 미도착 시 원문만 (§6.7)
    overlaySrc.textContent = seg.text;
    overlaySrc.hidden = false;
    if (tr != null) {
      overlayMain.textContent = tr;
      overlayMain.classList.remove('ytx-overlay-pending');
      overlayMain.hidden = false;
    } else {
      overlayMain.hidden = true;
    }
  } else {
    // 교체: 번역만. 미번역 구간은 원문 임시 표시 (§6.7 채택 정책)
    overlaySrc.hidden = true;
    overlayMain.hidden = false;
    if (tr != null) {
      overlayMain.textContent = tr;
      overlayMain.classList.remove('ytx-overlay-pending');
    } else {
      overlayMain.textContent = seg.text;
      overlayMain.classList.add('ytx-overlay-pending');
    }
  }
  overlayInner.hidden = false;
}

/* ── rAF 루프: 재생 중 + 탭 가시 상태에서만 (§6.8) ─────────── */
function overlayTick() {
  overlayRafId = 0;
  if (!overlayEl || !videoEl) return;
  setOverlaySegment(findActiveSegment(videoEl.currentTime), false);
  if (!videoEl.paused && !videoEl.ended && !document.hidden) {
    overlayRafId = requestAnimationFrame(overlayTick);
  }
}

function startOverlayLoop() {
  if (overlayRafId || !overlayEl || !videoEl) return;
  if (videoEl.paused || videoEl.ended || document.hidden) {
    refreshOverlayText(); // 정지 상태에서도 현재 구간은 1회 표시
    return;
  }
  overlayRafId = requestAnimationFrame(overlayTick);
}

function stopOverlayLoop() {
  if (overlayRafId) {
    cancelAnimationFrame(overlayRafId);
    overlayRafId = 0;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopOverlayLoop();
  else startOverlayLoop();
});
