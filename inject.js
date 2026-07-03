/**
 * inject.js — MAIN world 주입 스크립트 (설계서 §2 방법 B)
 *
 * window.fetch / XMLHttpRequest를 래핑해 timedtext 응답 본문을 가로채
 * window.postMessage로 content script에 전달한다.
 *
 * 코딩 규칙(지시서 §8): 래핑은 비파괴 — 원 동작을 그대로 통과시키고,
 * 우리 쪽 처리에서 예외가 나도 페이지 동작에 영향을 주지 않는다.
 *
 * 주입 방식 메모: 지시서는 chrome.scripting(world: MAIN)을 예시로 들었으나,
 * manifest content_scripts의 "world": "MAIN" 선언(Chrome 111+)이
 * 동일 효과 + 더 이른 주입 타이밍 + 권한 표면 축소(scripting 권한 불요)이므로
 * 이를 채택했다. (권한 최소화 지시 준수)
 */
(() => {
  'use strict';

  // 이중 주입 가드 (SPA 내비게이션/재주입 대비)
  if (window.__ytSubExtInjected) return;
  window.__ytSubExtInjected = true;

  const MSG_SOURCE = 'yt-sub-ext'; // constants.js와 동일 값 (MAIN world에서는 YTX 접근 불가)
  const KEYWORD = 'timedtext';
  const PLAYER_API = '/youtubei/v1/player'; // SPA 내비게이션 시 플레이어 응답 (자막 트랙 포함)

  function postCaption(url, body) {
    try {
      window.postMessage(
        { source: MSG_SOURCE, type: 'caption', payload: { url, body } },
        window.location.origin
      );
    } catch (e) {
      /* 전달 실패는 무시 — 페이지 동작에 영향 금지 */
    }
  }

  function isTimedtextUrl(url) {
    return typeof url === 'string' && url.includes(KEYWORD);
  }

  function isPlayerApiUrl(url) {
    return typeof url === 'string' && url.includes(PLAYER_API);
  }

  /**
   * 플레이어 응답 → 자막 트랙 목록 추출 (CC를 켜지 않아도 존재)
   * 능동 취득: background가 baseUrl을 직접 fetch해 자막을 확보한다.
   */
  function postTracksFromPlayerResponse(json) {
    try {
      const tracks = json?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!Array.isArray(tracks) || tracks.length === 0) return;
      const videoId = json?.videoDetails?.videoId || '';
      const slim = tracks.map((t) => ({
        baseUrl: t.baseUrl || '',
        languageCode: t.languageCode || '',
        kind: t.kind || '', // 'asr' = 자동 생성
        name: (t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || ''
      })).filter((t) => t.baseUrl);
      if (!slim.length) return;
      window.postMessage(
        { source: MSG_SOURCE, type: 'tracks', payload: { videoId, tracks: slim } },
        window.location.origin
      );
    } catch (e) { /* 무시 — 페이지 동작에 영향 금지 */ }
  }

  // ── fetch 래핑 ─────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    let url = '';
    try {
      const input = args[0];
      url = typeof input === 'string' ? input : (input && input.url) || '';
    } catch (e) { /* URL 추출 실패 시 원 동작만 수행 */ }

    const resultPromise = origFetch.apply(this, args);

    if (isTimedtextUrl(url)) {
      resultPromise
        .then((res) => {
          // clone()으로 본문을 읽어 원 스트림을 소비하지 않는다 (비파괴)
          try {
            res.clone().text().then((body) => postCaption(url, body)).catch(() => {});
          } catch (e) { /* clone 실패 무시 */ }
        })
        .catch(() => { /* 네트워크 오류는 페이지 쪽에서 처리 */ });
    } else if (isPlayerApiUrl(url)) {
      // SPA 내비게이션 시 플레이어 응답에서 자막 트랙 목록 추출 (능동 취득)
      resultPromise
        .then((res) => {
          try {
            res.clone().json().then((json) => postTracksFromPlayerResponse(json)).catch(() => {});
          } catch (e) { /* 무시 */ }
        })
        .catch(() => {});
    }
    return resultPromise;
  };

  // ── XMLHttpRequest 래핑 ────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      this.__ytSubExtUrl = typeof url === 'string' ? url : String(url);
    } catch (e) { /* 무시 */ }
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      if (isTimedtextUrl(this.__ytSubExtUrl)) {
        this.addEventListener('load', () => {
          try {
            // responseType이 ''/'text'일 때만 responseText 접근 가능
            if (this.responseType === '' || this.responseType === 'text') {
              postCaption(this.__ytSubExtUrl, this.responseText);
            } else if (this.responseType === 'json' && this.response != null) {
              postCaption(this.__ytSubExtUrl, JSON.stringify(this.response));
            }
            // 그 외 responseType(blob/arraybuffer)은 폴백 A(webRequest 재fetch)가 커버
          } catch (e) { /* 무시 */ }
        });
      } else if (isPlayerApiUrl(this.__ytSubExtUrl)) {
        this.addEventListener('load', () => {
          try {
            let json = null;
            if (this.responseType === '' || this.responseType === 'text') json = JSON.parse(this.responseText);
            else if (this.responseType === 'json') json = this.response;
            if (json) postTracksFromPlayerResponse(json);
          } catch (e) { /* 무시 */ }
        });
      }
    } catch (e) { /* 무시 */ }
    return origSend.apply(this, args);
  };

  // ── 최초 페이지 로드: ytInitialPlayerResponse에서 트랙 추출 ──
  // (첫 진입은 /youtubei/v1/player 요청 없이 HTML에 인라인됨)
  function readInitialPlayerResponse() {
    try {
      if (window.ytInitialPlayerResponse) {
        postTracksFromPlayerResponse(window.ytInitialPlayerResponse);
      }
    } catch (e) { /* 무시 */ }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', readInitialPlayerResponse, { once: true });
  } else {
    readInitialPlayerResponse();
  }
})();
