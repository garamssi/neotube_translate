/**
 * bg/parsers.js — 자막 파싱 · 정규화 (설계서 §2~§3)
 *
 * 서비스 워커 계층 구조 (importScripts 순서 = 의존 방향):
 *   constants.js → debuglog.js(로거·디버그 버스) → parsers.js(순수 함수)
 *   → capture.js(취득) → translation.js(번역) → background.js(메시지 라우터)
 * log()/warn()은 debuglog.js에서 정의된다 (콘솔 + 디버그 버퍼 겸용).
 */
'use strict';

/** timedtext URL에서 메타데이터 추출 */
function parseTimedtextUrl(url) {
  try {
    const u = new URL(url, 'https://www.youtube.com');
    const p = u.searchParams;
    return {
      videoId: p.get('v') || '',
      lang: p.get('lang') || p.get('tlang') || '',
      fmt: p.get('fmt') || '', // 빈 값이면 유튜브 기본(XML srv 계열) — 확인 필요(설계서 §8)
      kind: p.get('kind') || '' // 'asr' = 자동 생성 자막
    };
  } catch (e) {
    return { videoId: '', lang: '', fmt: '', kind: '' };
  }
}

/** 중복 전달 방지 키: 같은 영상·언어·형식은 탭당 1회만 전달 */
function captionKey(meta) {
  return `${meta.videoId}|${meta.lang}|${meta.fmt}|${meta.kind}`;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * json3 파서
 * 구조: { events: [{ tStartMs, dDurMs, segs: [{ utf8, tOffsetMs }], aAppend?, ... }] }
 * - segs가 없는 이벤트(윈도 정의 등)·개행만 있는 이벤트는 건너뜀
 * - aAppend(ASR 이어붙기) 이벤트: 스킵 — 텍스트 누락 관찰 시 병합 로직 보강
 *   (확인 필요 — ASR 자막 실측)
 */
function parseJson3(body) {
  const data = JSON.parse(body);
  if (!data || !Array.isArray(data.events)) throw new Error('json3: events 배열 없음');

  const segments = [];
  for (const ev of data.events) {
    if (!Array.isArray(ev.segs)) continue;
    if (ev.aAppend) continue; // 확인 필요: ASR 이어붙기 이벤트 처리

    const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\n/g, ' ').trim();
    if (!text) continue;

    const start = (ev.tStartMs || 0) / 1000;
    const dur = ev.dDurMs != null ? ev.dDurMs / 1000 : null;
    segments.push({ start, dur, text });
  }

  // end 계산: dDurMs가 없으면 다음 세그먼트 시작까지로 보정
  return segments.map((s, i) => ({
    id: i,
    start: round3(s.start),
    end: round3(s.dur != null ? s.start + s.dur : (segments[i + 1]?.start ?? s.start + 3)),
    text: s.text
  }));
}

/** vtt 파서 — WEBVTT 큐 블록 기반, 인라인 태그 제거 */
function parseVtt(body) {
  const lines = body.replace(/\r/g, '').split('\n');
  const segments = [];
  const TIME_RE = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/;

  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(TIME_RE);
    if (!m) { i++; continue; }

    const start = toSec(m[1], m[2], m[3], m[4]);
    const end = toSec(m[5], m[6], m[7], m[8]);
    i++;

    const textLines = [];
    while (i < lines.length && lines[i].trim() !== '') {
      textLines.push(lines[i]);
      i++;
    }
    const text = textLines.join(' ').replace(/<[^>]*>/g, '').trim();
    if (text) segments.push({ start, end, text });
  }

  return segments.map((s, idx) => ({
    id: idx,
    start: round3(s.start),
    end: round3(s.end),
    text: s.text
  }));

  function toSec(h, m, s, ms) {
    return (parseInt(h || '0', 10) * 3600) + (parseInt(m, 10) * 60) + parseInt(s, 10) + parseInt(ms, 10) / 1000;
  }
}

/**
 * 본문 → 표준 세그먼트 모델(설계서 §3) 정규화
 * @returns {object|null} null이면 파싱 불가(미지원 형식 등)
 */
function normalizeCaption(url, body, pageVideoId) {
  const meta = parseTimedtextUrl(url);
  const videoId = meta.videoId || pageVideoId || '';
  const trimmed = (body || '').trimStart();

  let format = meta.fmt;
  let segments = null;

  try {
    if (format === 'json3' || trimmed.startsWith('{')) {
      segments = parseJson3(body);
      format = 'json3';
    } else if (format === 'vtt' || trimmed.startsWith('WEBVTT')) {
      segments = parseVtt(body);
      format = 'vtt';
    } else if (trimmed.startsWith('<')) {
      // srv1/2/3 (XML) — 1차 미지원. 감지 시 경고만 (지시서 §3)
      warn(`XML(srv 계열) 자막 감지 — 1차 미지원, 파서 확장 지점. url=${url.slice(0, 120)}`);
      // TODO(확장 지점): srv1/2/3 XML 파서 — <text start="..." dur="...">
      return null;
    } else {
      warn(`알 수 없는 자막 형식 — fmt=${format}, 본문 앞부분: ${trimmed.slice(0, 60)}`);
      return null;
    }
  } catch (e) {
    warn('자막 파싱 실패:', e.message);
    return null;
  }

  if (!segments || segments.length === 0) {
    warn('파싱 결과 세그먼트 0개 — 무시');
    return null;
  }

  return {
    video_id: videoId,
    source_lang: meta.lang,
    format,
    fetched_at: Math.floor(Date.now() / 1000),
    segments
  };
}
