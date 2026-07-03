/**
 * bg/capture.js — 자막 취득 (설계서 §2)
 *
 * 3단계 취득 체계:
 *   1) 능동 취득: 플레이어 응답의 captionTracks.baseUrl 직접 fetch (CC 불필요)
 *   2) 인터셉트(B): 페이지 컨텍스트에서 가로챈 timedtext 본문 수신
 *   3) 재fetch(A): webRequest 관찰 → 인터셉트 미도착 시 재요청 (폴백)
 * 세 경로 모두 동일한 중복 방지 키(captionKey)로 수렴한다.
 */
'use strict';

/* ── 탭 단위 취득 상태 ────────────────────────────────────────
 * SW는 ~30초 유휴 시 종료되어 이 메모리 상태가 사라진다.
 * "중복 전달 방지"와 "폴백 타이머"용 단기 상태로만 쓰고,
 * 영속 데이터(설정·번역 캐시)는 chrome.storage에 둔다. */
const tabState = new Map(); // tabId → { delivered:Set<key>, pendingFallback:Map<key,timerId> }

function getTabState(tabId) {
  if (!tabState.has(tabId)) {
    tabState.set(tabId, { delivered: new Set(), pendingFallback: new Map() });
  }
  return tabState.get(tabId);
}

/** SPA 내비게이션(M7): 재방문 시 재전달 허용을 위해 탭 상태 초기화 */
function resetTabCapture(tabId) {
  tabState.delete(tabId);
}

chrome.tabs.onRemoved.addListener((tabId) => tabState.delete(tabId));

/* ── 전달 ──────────────────────────────────────────────────── */
function deliverSegments(tabId, normalized, via) {
  chrome.tabs.sendMessage(tabId, {
    type: YTX.MSG.SEGMENTS,
    via, // 'proactive' | 'intercept'(B) | 'refetch'(A)
    data: normalized
  }).catch(() => { /* 탭이 닫혔거나 content script 미로드 — 무시 */ });
}

/** 공통 처리: 본문 파싱 → 중복 확인 → 전달 */
function handleCaptionBody(tabId, url, body, pageVideoId, via) {
  const meta = parseTimedtextUrl(url);
  const key = captionKey(meta);
  const state = getTabState(tabId);

  // 이미 같은 트랙을 전달했으면 스킵 (fetch+XHR 이중 수신, 경로 간 중복 대비)
  if (state.delivered.has(key)) return;

  const normalized = normalizeCaption(url, body, pageVideoId);
  if (!normalized) return;

  state.delivered.add(key);

  // 이 트랙에 걸려 있던 폴백 타이머 해제
  const timer = state.pendingFallback.get(key);
  if (timer) {
    clearTimeout(timer);
    state.pendingFallback.delete(key);
  }

  log(`자막 정규화 완료 (${via}) — ${normalized.video_id} [${normalized.source_lang}/${normalized.format}] ${normalized.segments.length}개 세그먼트`);
  deliverSegments(tabId, normalized, via);
}

/* ═══════════════════════════════════════════════════════════
 * 1) 능동 취득 — captionTracks.baseUrl 직접 fetch (CC 불필요)
 *
 * 트랙 선택: 수동 자막(non-asr) 우선, 없으면 자동 생성(asr).
 * 주의: baseUrl 서명 만료·POT 정책은 실측 확인 필요(설계서 §8) —
 * 빈 응답이 오면 경고만 남기고 폴백 경로에 맡긴다.
 * ═══════════════════════════════════════════════════════════ */
async function fetchTrackProactively(tabId, videoId, tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return;

  const track = tracks.find((t) => t.kind !== 'asr') || tracks[0];
  if (!track || !track.baseUrl) return;

  const url = track.baseUrl + (track.baseUrl.includes('fmt=') ? '' : '&fmt=json3');
  const meta = parseTimedtextUrl(url);
  if (!meta.videoId) meta.videoId = videoId;
  const key = captionKey({ ...meta, videoId: meta.videoId || videoId });
  const state = getTabState(tabId);
  if (state.delivered.has(key) || state.pendingFallback.has(key)) return; // 이미 확보/진행 중

  log(`능동 취득 시도 — ${videoId} [${track.languageCode}${track.kind ? '/' + track.kind : ''}]`);
  let body = '';
  try {
    // 30초 초과 fetch는 SW 종료 유발 가능(수명 규칙) → 15초 타임아웃
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.text();
  } catch (e) {
    warn('능동 취득 fetch 실패 (CC 켜면 인터셉트로 폴백):', e.message);
    return;
  }
  if (!body || !body.trim()) {
    // 확인 필요: 일부 환경에서 서명/POT 정책으로 빈 응답 가능 — 폴백에 맡김
    warn('능동 취득 응답이 비어 있음 — CC 켜면 인터셉트로 폴백');
    return;
  }
  handleCaptionBody(tabId, url, body, videoId, 'proactive');
}

/* ═══════════════════════════════════════════════════════════
 * 3) 재fetch(A) 폴백 — webRequest로 timedtext URL 관찰
 *
 * 인터셉트(B)가 FALLBACK_REFETCH_DELAY_MS 안에 같은 트랙을 전달하지
 * 않으면 background에서 URL을 재요청한다.
 * 주의: timedtext URL은 만료형 서명을 포함 — 관찰 직후 재fetch하므로
 * 일반적으로 유효하나, 만료 정책은 실측 확인 필요(설계서 §8).
 * ═══════════════════════════════════════════════════════════ */
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return; // 탭 외 요청 무시
    const meta = parseTimedtextUrl(details.url);
    const key = captionKey(meta);
    const state = getTabState(details.tabId);

    if (state.delivered.has(key) || state.pendingFallback.has(key)) return;

    const timerId = setTimeout(async () => {
      state.pendingFallback.delete(key);
      if (state.delivered.has(key)) return; // 그 사이 B가 도착

      log(`인터셉트 미도착 — 폴백 A 재fetch 시도: ${key}`);
      try {
        const res = await fetch(details.url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.text();
        handleCaptionBody(details.tabId, details.url, body, '', 'refetch');
      } catch (e) {
        warn('폴백 A 재fetch 실패:', e.message);
      }
    }, YTX.FALLBACK_REFETCH_DELAY_MS);

    state.pendingFallback.set(key, timerId);
  },
  { urls: [YTX.TIMEDTEXT_URL_PATTERN] }
);
