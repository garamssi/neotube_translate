/**
 * background.js — 서비스 워커 진입점 (메시지 라우터)
 *
 * 계층 구조 (importScripts 순서 = 의존 방향):
 *   constants.js      공용 상수 (셀렉터·설정 기본값·청크 한도)
 *   bg/parsers.js     자막 파싱·정규화 — 순수 함수 (설계서 §2~§3)
 *   bg/capture.js     자막 취득 — 능동 취득 / 인터셉트 / webRequest 폴백
 *   bg/translation.js 번역 오케스트레이터 + Gemini/localhost 경로 (설계서 §4, §6)
 *
 * 이 파일은 content script 메시지를 각 모듈로 위임하는 라우팅만 담당한다.
 */
importScripts('constants.js', 'bg/parsers.js', 'bg/capture.js', 'bg/translation.js', 'bg/summary.js');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !sender.tab) return;
  const tabId = sender.tab.id;

  switch (msg.type) {
    case YTX.MSG.CAPTION_RAW: // 인터셉트(B) 본문 수신
      handleCaptionBody(tabId, msg.url, msg.body, msg.pageVideoId, msg.via || 'intercept');
      break;

    case YTX.MSG.CAPTION_TRACKS: // 능동 취득 — CC 없이 트랙 baseUrl 직접 fetch
      fetchTrackProactively(tabId, msg.videoId, msg.tracks)
        .catch((e) => warn('능동 취득 실패:', e.message));
      break;

    case YTX.MSG.TRANSLATE_START: // caption 동봉 — SW 재시작에도 안전
      runTranslationJob(tabId, msg.caption, msg.title || '')
        .catch((e) => warn('번역 작업 예외:', e));
      break;

    case YTX.MSG.SUMMARIZE_START: // 요약 (수동 전용)
      runSummaryJob(tabId, msg.payload)
        .catch((e) => warn('요약 작업 예외:', e));
      break;

    case YTX.MSG.TAB_RESET: // SPA 내비게이션(M7) — 취득 상태·번역 작업 리셋
      resetTabCapture(tabId);
      cancelTabJobs(tabId);
      break;

    default:
      return;
  }
  sendResponse({ ok: true });
  return false;
});

log('service worker 시작 (parsers/capture/translation)');
