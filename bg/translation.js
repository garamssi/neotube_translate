/**
 * bg/translation.js — 번역 오케스트레이터 + 경로 어댑터 (설계서 §4, §6)
 *
 * 청크 분할(첫 청크 소형 + 경로별 한도) → 병렬 워커 풀 → 재시도(백오프/429)
 * → id 병합 → 완료분 점진 push → chrome.storage.local 캐시.
 */
'use strict';

/* ═══════════════════════════════════════════════════════════
 * 작업 수명 관리
 * ═══════════════════════════════════════════════════════════ */
let jobCounter = 0;
const activeJobs = new Map(); // tabId → jobId (새 작업 시작 시 이전 작업 무효화)

/** SPA 내비게이션(M7): 진행 중이던 이전 영상의 번역 작업 무효화 */
function cancelTabJobs(tabId) {
  activeJobs.set(tabId, ++jobCounter); // alive() 체크 실패 → 기존 워커 루프 중단
}

/* ── SW keepalive (공식 가이드 패턴) ─────────────────────────
 * MV3 서비스 워커는 30초 유휴 시 종료되며, setTimeout 대기는 유휴
 * 타이머를 리셋하지 않는다. 확장 API 호출은 타이머를 리셋하므로,
 * 번역 작업이 진행되는 동안 25초 간격으로 trivial API를 호출해
 * 워커를 유지한다. (백오프/Retry-After 대기 중 종료 방지)
 * 근거: developer.chrome.com/blog/longer-esw-lifetimes */
let keepaliveTimer = null;
let runningJobCount = 0;

function keepaliveAcquire() {
  runningJobCount++;
  if (!keepaliveTimer) {
    keepaliveTimer = setInterval(() => {
      chrome.runtime.getPlatformInfo(() => {}); // 호출 자체가 유휴 타이머 리셋
    }, 25000);
  }
}

function keepaliveRelease() {
  runningJobCount = Math.max(0, runningJobCount - 1);
  if (runningJobCount === 0 && keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

// fetch 응답이 30초를 넘으면 SW가 종료될 수 있으므로(공식 수명 규칙),
// Gemini 호출에 30초 미만의 명시적 타임아웃을 둔다.
// (localhost는 keepalive 유지 하에 YTX.LOCALHOST_TIMEOUT_MS 적용)
const GEMINI_TIMEOUT_MS = 25000;

/* ═══════════════════════════════════════════════════════════
 * 설정 · 캐시
 * ═══════════════════════════════════════════════════════════ */
async function getSettings() {
  const stored = await chrome.storage.local.get(YTX.STORAGE.SETTINGS);
  return YTX.normalizeSettings(stored[YTX.STORAGE.SETTINGS]);
}

/** 캐시 프루닝: storage.local 10MB 한도 보호 — 오래된 항목부터 제거 */
const CACHE_MAX_ENTRIES = 30;

async function pruneCache() {
  try {
    const all = await chrome.storage.local.get(null);
    const cacheKeys = Object.keys(all)
      .filter((k) => k.startsWith(YTX.STORAGE.CACHE_PREFIX + '|') || k.startsWith(YTX.STORAGE.SUM_PREFIX + '|'))
      .sort((a, b) => (all[a].cached_at || 0) - (all[b].cached_at || 0)); // 오래된 순
    if (cacheKeys.length > CACHE_MAX_ENTRIES) {
      const evict = cacheKeys.slice(0, cacheKeys.length - CACHE_MAX_ENTRIES);
      await chrome.storage.local.remove(evict);
      log(`캐시 프루닝 — ${evict.length}개 항목 제거`);
    }
  } catch (e) { warn('캐시 프루닝 실패:', e.message); }
}

/* ═══════════════════════════════════════════════════════════
 * 청크 분할
 * ═══════════════════════════════════════════════════════════ */
/**
 * 세그먼트 → 순서 보존 청크 (경로별 한도 — constants.js)
 * 첫 청크는 limits.FIRST 크기로 작게 잘라 "시작 부분이 가장 먼저"
 * 번역·표시되도록 한다 (time-to-first-content).
 */
function buildChunks(segments, limits) {
  const chunks = [];
  let current = [];
  let chars = 0;
  const maxSegsAt = (chunkIdx) =>
    (chunkIdx === 0 && limits.FIRST) ? Math.min(limits.FIRST, limits.SEGMENTS) : limits.SEGMENTS;

  for (const seg of segments) {
    if (current.length >= maxSegsAt(chunks.length) ||
        (chars + seg.text.length > limits.CHARS && current.length > 0)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(seg);
    chars += seg.text.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/* ═══════════════════════════════════════════════════════════
 * 오케스트레이터
 * ═══════════════════════════════════════════════════════════ */
function sendToTab(tabId, payload) {
  return chrome.tabs.sendMessage(tabId, payload).catch(() => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 번역 오류 표준화 */
function transError(code, message, { retriable = false, retryAfterMs = 0 } = {}) {
  return { code, message, retriable, retryAfterMs };
}

async function runTranslationJob(tabId, caption, title) {
  if (!caption || !Array.isArray(caption.segments) || caption.segments.length === 0) return;
  keepaliveAcquire();
  try {
    await runTranslationJobInner(tabId, caption, title || '');
  } finally {
    keepaliveRelease();
  }
}

async function runTranslationJobInner(tabId, caption, title) {
  const jobId = ++jobCounter;
  activeJobs.set(tabId, jobId);
  const alive = () => activeJobs.get(tabId) === jobId;

  const settings = await getSettings();
  const { route, targetLang } = settings;
  const routeLabel = route === 'gemini'
    ? `Gemini(${settings.geminiModel})`
    : `Claude CLI · ${settings.serverAddress}`;

  // 원문이 이미 대상 언어면 번역 생략 (지역 변형 무시: ko-KR ≒ ko)
  const srcBase = (caption.source_lang || '').split('-')[0].toLowerCase();
  const tgtBase = (targetLang || '').split('-')[0].toLowerCase();
  if (srcBase && srcBase === tgtBase) {
    const identity = {};
    for (const s of caption.segments) identity[String(s.id)] = s.text;
    log(`번역 생략 — 원문(${caption.source_lang})이 이미 대상 언어(${targetLang})`);
    sendToTab(tabId, {
      type: YTX.MSG.TRANS_COMPLETE,
      videoId: caption.video_id,
      translations: identity,
      failedChunks: [],
      fromCache: false,
      skipped: true,
      routeLabel: '번역 생략 (동일 언어)',
      targetLang
    });
    return;
  }

  const key = YTX.cacheKey(caption.video_id, targetLang, route);

  // ── 캐시 확인: 재방문 시 즉시 표시 (설계서 §4) ──
  const cachedWrap = await chrome.storage.local.get(key);
  const cached = cachedWrap[key];
  let translations = {}; // id(string) → 번역 텍스트

  if (cached && cached.map) {
    translations = { ...cached.map };
    if (cached.complete) {
      log(`캐시 적중(완전) — ${key}`);
      sendToTab(tabId, {
        type: YTX.MSG.TRANS_COMPLETE,
        videoId: caption.video_id,
        translations,
        failedChunks: [],
        fromCache: true,
        routeLabel,
        targetLang
      });
      return;
    }
    log(`캐시 적중(부분, ${Object.keys(translations).length}개) — 누락분만 번역 진행`);
  }

  // ── Gemini 경로 사전 점검 ──
  if (route === 'gemini' && !settings.geminiApiKey) {
    sendToTab(tabId, {
      type: YTX.MSG.TRANS_CHUNK_ERROR,
      videoId: caption.video_id,
      chunkIndex: -1,
      code: 'NO_API_KEY',
      message: 'Gemini API 키가 설정되지 않았습니다. 패널 설정에서 키를 입력하세요.',
      routeLabel
    });
    return;
  }

  // 미번역 세그먼트만 청크 대상으로 (경로별 청크 한도)
  const routeConfig = route === 'gemini' ? YTX.CHUNK_GEMINI : YTX.CHUNK_LOCALHOST;
  const pending = caption.segments.filter((s) => translations[s.id] == null);
  const chunks = buildChunks(pending, routeConfig);
  const totalSegs = caption.segments.length;

  sendToTab(tabId, {
    type: YTX.MSG.TRANS_STATUS,
    videoId: caption.video_id,
    totalChunks: chunks.length,
    totalSegments: totalSegs,
    doneSegments: Object.keys(translations).length,
    translations, // 부분 캐시 즉시 반영
    routeLabel,
    targetLang
  });

  const failedChunks = [];

  /* ── 병렬 처리: 워커 풀 (동시 PARALLEL_CHUNKS개) ─────────────
   * 워커는 청크를 앞에서부터 순서대로 집어간다(시작 부분 우선).
   * 병합이 id 기준이라 완료 순서와 무관. 청크별 재시도·실패 격리 유지.
   * 치명 오류(BAD_REQUEST 등)는 fatal 플래그로 나머지 워커도 중단. */
  let nextIdx = 0;
  let fatal = false;

  async function processChunk(i) {
    const chunk = chunks[i];
    try {
      const result = await translateChunkWithRetry(chunk, i, chunks.length, caption, settings, alive);

      // ── id 병합: 요청에 없던 id 무시 (설계서 §4) ──
      const requested = new Set(chunk.map((s) => String(s.id)));
      const merged = {};
      for (const item of result) {
        if (item && requested.has(String(item.id)) && typeof item.text === 'string') {
          merged[String(item.id)] = item.text;
        }
      }

      // ── 누락 id 1회 재시도 (설계서 §4) ──
      const missing = chunk.filter((s) => merged[String(s.id)] == null);
      if (missing.length > 0 && alive()) {
        log(`청크 ${i}: 누락 id ${missing.length}개 재시도`);
        try {
          const retryResult = await translateChunkWithRetry(missing, i, chunks.length, caption, settings, alive);
          for (const item of retryResult) {
            if (item && requested.has(String(item.id)) && typeof item.text === 'string') {
              merged[String(item.id)] = item.text;
            }
          }
        } catch (e) { warn(`청크 ${i} 누락분 재시도 실패:`, e.message || e.code); }
      }

      Object.assign(translations, merged);

      if (!alive()) return;
      sendToTab(tabId, {
        type: YTX.MSG.TRANS_PROGRESS,
        videoId: caption.video_id,
        chunkIndex: i,
        totalChunks: chunks.length,
        translations: merged, // 이번 청크 완료분만 (점진 표시)
        doneSegments: Object.keys(translations).length,
        totalSegments: totalSegs,
        routeLabel
      });
    } catch (e) {
      // ── 최종 실패 청크만 격리, 부분 결과 유지 (설계서 §4) ──
      const err = e.code ? e : transError('UNKNOWN', String(e.message || e));
      if (err.code === 'CANCELLED') return;
      failedChunks.push({ index: i, ids: chunk.map((s) => s.id), code: err.code, message: err.message });
      warn(`청크 ${i} 최종 실패 [${err.code}]: ${err.message}`);
      if (!alive()) return;
      sendToTab(tabId, {
        type: YTX.MSG.TRANS_CHUNK_ERROR,
        videoId: caption.video_id,
        chunkIndex: i,
        totalChunks: chunks.length,
        code: err.code,
        message: err.message,
        ids: chunk.map((s) => s.id),
        routeLabel
      });
      // BAD_REQUEST/UNSUPPORTED_LANG/AUTH는 이후 청크도 같은 결과 — 작업 중단
      if (['BAD_REQUEST', 'UNSUPPORTED_LANG', 'AUTH'].includes(err.code)) fatal = true;
    }
  }

  const workerCount = Math.min(routeConfig.PARALLEL || 2, chunks.length);
  const workers = Array.from({ length: workerCount }, () => (async () => {
    for (;;) {
      if (!alive() || fatal) return;
      const i = nextIdx++;
      if (i >= chunks.length) return;
      await processChunk(i);
    }
  })());
  await Promise.all(workers);

  if (!alive()) { log('번역 작업 중단(새 작업으로 대체됨)'); return; }

  // ── 캐시 저장: video_id + target_lang + 경로 키 (설계서 §4) ──
  const complete = caption.segments.every((s) => translations[String(s.id)] != null);
  await chrome.storage.local.set({
    [key]: {
      map: translations,
      complete,
      cached_at: Math.floor(Date.now() / 1000),
      title: title || (cached && cached.title) || '' // 캐시 목록 표시용
    }
  });
  pruneCache(); // 비동기, 결과 무관

  sendToTab(tabId, {
    type: YTX.MSG.TRANS_COMPLETE,
    videoId: caption.video_id,
    translations,
    failedChunks,
    fromCache: false,
    routeLabel,
    targetLang
  });
  log(`번역 작업 종료 — ${Object.keys(translations).length}/${totalSegs} 세그먼트, 실패 청크 ${failedChunks.length}개`);
}

/* ── 공유 레이트리밋 쿨다운 ──────────────────────────────────
 * 429는 계정 단위 처리율 초과이므로, 한 워커가 429를 받으면
 * 모든 워커가 쿨다운이 끝날 때까지 새 호출을 시작하지 않는다.
 * (병렬 워커들이 동시에 재시도해 다시 한도를 치는 stampede 방지) */
let rateLimitedUntil = 0;

async function waitForCooldown(alive) {
  while (Date.now() < rateLimitedUntil) {
    if (!alive()) throw transError('CANCELLED', '작업 취소됨');
    await sleep(Math.min(rateLimitedUntil - Date.now(), 1000));
  }
}

/**
 * 청크 번역 + 재시도 정책 (설계서 §4)
 * - 지수 백오프 2회(1s→4s): retriable 오류만
 * - RATE_LIMITED(429): Retry-After / retry_after_ms 존중 (별도 카운트, 최대 3회, 60s 캡)
 *   + 전 워커 공유 쿨다운
 */
async function translateChunkWithRetry(chunk, chunkIndex, totalChunks, caption, settings, alive) {
  const callOnce = () => settings.route === 'gemini'
    ? callGemini(chunk, caption, settings)
    : callLocalhost(chunk, chunkIndex, totalChunks, caption, settings);

  let backoffTries = 0;
  let rateLimitTries = 0;

  for (;;) {
    if (!alive()) throw transError('CANCELLED', '작업 취소됨');
    await waitForCooldown(alive); // 다른 워커가 429를 받았다면 함께 대기
    try {
      return await callOnce();
    } catch (e) {
      const err = e.code ? e : transError('UNKNOWN', String(e.message || e), { retriable: true });

      if (err.code === 'RATE_LIMITED' && rateLimitTries < 3) {
        rateLimitTries++;
        const wait = Math.min(
          err.retryAfterMs > 0 ? err.retryAfterMs : YTX.RETRY_BACKOFF_MS[Math.min(backoffTries, 1)],
          60000
        );
        rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + wait); // 전 워커 공유
        log(`429 — ${wait}ms 쿨다운 (전 워커 공유, ${rateLimitTries}/3)`);
        await sleep(wait);
        continue;
      }
      if (err.retriable && backoffTries < YTX.RETRY_BACKOFF_MS.length) {
        const wait = YTX.RETRY_BACKOFF_MS[backoffTries];
        backoffTries++;
        log(`재시도 대기 ${wait}ms (${backoffTries}/${YTX.RETRY_BACKOFF_MS.length}) — ${err.code}`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

/* ═══════════════════════════════════════════════════════════
 * 경로 어댑터 공통 — 번역 시스템 프롬프트 (도메인 용어 보존)
 * ═══════════════════════════════════════════════════════════ */
function buildTranslatorPrompt(sourceLang, targetLang) {
  return (
    `You are a professional subtitle translator. Translate each subtitle segment from ` +
    `${sourceLang || 'the source language'} to ${targetLang}. ` +
    `First, infer the content's domain (e.g., software development, finance, medicine, gaming). ` +
    `Keep domain-specific technical terms, product/framework/library names, and widely-used ` +
    `industry jargon in their original English form (IT examples: Spring, Bean, Dependency Injection, ` +
    `Controller, endpoint, deploy, container, commit). Proper nouns and acronyms (API, JVM, SQL) stay as-is; ` +
    `translate the surrounding prose naturally. ` +
    `Rules: (1) Respond ONLY with a JSON array of objects {"id": <number>, "text": "<translation>"}. ` +
    `(2) Include exactly one object per requested id — no extra or missing ids. ` +
    `(3) Keep translations natural and concise, suitable for on-screen subtitles. ` +
    `(4) Preserve tone; do not add explanations or notes. ` +
    `(5) JSON safety: never use an unescaped double-quote inside "text" values — ` +
    `use 『 』 for quotations instead of double quotes.`
  );
}

/* ═══════════════════════════════════════════════════════════
 * 경로 1 — Gemini API 직접 호출
 *
 * 공식 문서 확인(2026-06 기준, 추정 금지 준수):
 * - 엔드포인트: POST {API_BASE}/{model}:generateContent (헤더 x-goog-api-key)
 * - 구조화 출력: generationConfig.responseFormat.text.{mimeType, schema}
 * - 시스템 프롬프트: systemInstruction 필드
 * ═══════════════════════════════════════════════════════════ */
async function callGemini(chunk, caption, settings) {
  const model = settings.geminiModel || YTX.GEMINI.DEFAULT_MODEL;
  const url = `${YTX.GEMINI.API_BASE}/${encodeURIComponent(model)}:generateContent`;
  const userPayload = JSON.stringify(chunk.map((s) => ({ id: s.id, text: s.text })));

  const body = {
    systemInstruction: { parts: [{ text: buildTranslatorPrompt(caption.source_lang, settings.targetLang) }] },
    contents: [{ parts: [{ text: `Translate these subtitle segments:\n${userPayload}` }] }],
    generationConfig: {
      responseFormat: {
        text: {
          mimeType: 'application/json',
          schema: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'integer', description: 'Segment id from the request' },
                text: { type: 'string', description: 'Translated subtitle text' }
              },
              required: ['id', 'text']
            }
          }
        }
      }
    }
  };

  // 타임아웃 필수: 30초 이상 걸리는 fetch는 SW 종료를 유발할 수 있음 (수명 규칙)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.geminiApiKey },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw transError('TIMEOUT', `Gemini 응답 시간 초과 (${GEMINI_TIMEOUT_MS / 1000}초)`);
    }
    throw transError('NETWORK', `Gemini API에 연결할 수 없습니다: ${e.message}`, { retriable: true });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const status = res.status;
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch (e) { /* 무시 */ }

    if (status === 429) {
      // Retry-After 헤더(초) 존중 (설계서 §4)
      const ra = parseInt(res.headers.get('Retry-After') || '0', 10);
      throw transError('RATE_LIMITED', detail || '요청 한도 초과', { retryAfterMs: ra > 0 ? ra * 1000 : 0 });
    }
    if (status === 400) throw transError('BAD_REQUEST', detail || '잘못된 요청 (API 키/모델명 확인)');
    if (status === 401 || status === 403) throw transError('AUTH', detail || 'API 키 인증 실패');
    if (status >= 500) throw transError('UPSTREAM_ERROR', detail || `Gemini 서버 오류 (${status})`, { retriable: true });
    throw transError('UNKNOWN', `HTTP ${status}: ${detail}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error('배열 아님');
    return arr;
  } catch (e) {
    // 구조화 출력 위반 — 재시도 가치 있음
    throw transError('PARSE', `Gemini 응답이 JSON 배열 계약을 위반: ${text.slice(0, 80)}`, { retriable: true });
  }
}

/* ═══════════════════════════════════════════════════════════
 * 경로 2 — localhost 서버 (설계서 §6 계약 · Claude CLI 기반)
 * POST /translate · chunk{index,total} · 오류 코드표
 * ═══════════════════════════════════════════════════════════ */
async function callLocalhost(chunk, chunkIndex, totalChunks, caption, settings) {
  // LAN/원격 주소도 허용 — 서버가 CORS(Access-Control-Allow-Origin: *)를 내려주므로
  // host_permissions 확장 없이 표준 CORS 요청으로 동작한다.
  const url = `${YTX.buildServerBase(settings.serverAddress)}/translate`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), YTX.LOCALHOST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        video_id: caption.video_id,
        source_lang: caption.source_lang,
        target_lang: settings.targetLang,
        chunk: { index: chunkIndex, total: totalChunks },
        segments: chunk.map((s) => ({ id: s.id, start: s.start, end: s.end, text: s.text }))
      })
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      // 시간 초과: 조용한 재시도 대신 즉시 표면화 — 청크만 격리되고 사용자에게 원인 노출
      throw transError('TIMEOUT', `번역 응답 시간 초과 (${YTX.LOCALHOST_TIMEOUT_MS / 1000}초)`);
    }
    // 연결 불가 (설계서 §6 오류 코드표 마지막 행)
    throw transError('CONNECTION', '서버에 연결할 수 없습니다', { retriable: true });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let errBody = null;
    try { errBody = await res.json(); } catch (e) { /* 무시 */ }
    const code = errBody?.error?.code || 'UPSTREAM_ERROR';
    const message = errBody?.error?.message || `HTTP ${res.status}`;
    const retryAfterMs = errBody?.error?.retry_after_ms || 0;

    // 오류 코드표 매핑 (설계서 §6)
    switch (code) {
      case 'BAD_REQUEST':      throw transError('BAD_REQUEST', message);                         // 재시도 없음
      case 'RATE_LIMITED':     throw transError('RATE_LIMITED', message, { retryAfterMs });      // retry_after_ms 후 재시도
      case 'UPSTREAM_ERROR':   throw transError('UPSTREAM_ERROR', message, { retriable: true }); // 백오프 2회
      case 'UNSUPPORTED_LANG': throw transError('UNSUPPORTED_LANG', message);                    // 언어 변경 유도
      default:                 throw transError('UPSTREAM_ERROR', `${code}: ${message}`, { retriable: true });
    }
  }

  const data = await res.json();
  // 부분 응답 규칙(설계서 §6): segments가 요청 id의 부분집합이어도 유효
  if (!data || !Array.isArray(data.segments)) {
    throw transError('PARSE', '응답에 segments 배열이 없습니다', { retriable: true });
  }
  return data.segments;
}
