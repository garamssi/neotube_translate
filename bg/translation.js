/**
 * bg/translation.js — 번역 오케스트레이터 + 경로 전략 (설계서 §4, §6)
 *
 * 오케스트레이터(공통): 청크 순회 → 병렬 워커 풀 → 재시도(백오프/429)
 * → id 병합 → 완료분 점진 push → chrome.storage.local 캐시.
 * 경로별 차이는 ROUTES 전략 테이블에 집약:
 *  - localhost(Claude CLI): 세그먼트 수 기반 청크 + FIRST 소형 첫 청크 (첫 화면 우선)
 *  - gemini: 글자량 → 예상 출력 토큰 예산 기반 대형 청크 (호출 횟수 최소화)
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

// Gemini 대형 청크(600세그 ≈ 출력 2.4만 토큰) 생성 시간 확보를 위해 180초.
// SW 수명은 작업 중 상시 가동되는 keepalive(25초 간격 API 호출)로 유지 —
// URL 요약과 동일 방식. 종료가 관찰되면 offscreen document로 이전 (확인 필요)
const GEMINI_TIMEOUT_MS = 180000;

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

/**
 * 세그먼트 → 예상 "출력" 토큰 예산 기반 청크 (Gemini 경로)
 * 호출 횟수(RPM/RPD)가 가장 귀한 자원이므로, 영상의 실제 글자량을 재서
 * 예산이 찰 때까지 한 요청에 담는다. 추정식·예산은 constants.js CHUNK_GEMINI.
 * 추정이 빗나가 MAX_TOKENS로 잘리면 OUTPUT_LIMIT 이분할이 안전망.
 */
function buildChunksByTokenBudget(segments, cfg, engine) {
  const estTokens = (seg) => cfg.EST_TOKENS_PER_SEG + Math.ceil(seg.text.length * cfg.EST_TOKENS_PER_CHAR);
  const chunks = [];
  let current = [];
  let budget = 0;
  let totalChars = 0;
  let totalEst = 0;

  for (const seg of segments) {
    const t = estTokens(seg);
    if (current.length > 0 && budget + t > cfg.OUTPUT_TOKEN_BUDGET) {
      chunks.push(current);
      current = [];
      budget = 0;
    }
    current.push(seg);
    budget += t;
    totalChars += seg.text.length;
    totalEst += t;
  }
  if (current.length) chunks.push(current);
  log(`${engine || 'API'} 청크 계획: 원문 ${totalChars.toLocaleString()}자 → 예상 출력 ~${totalEst.toLocaleString()} 토큰 ` +
    `→ ${chunks.length}개 요청 (예산 ${cfg.OUTPUT_TOKEN_BUDGET.toLocaleString()} 토큰/청크)`);
  return chunks;
}

/**
 * 불완전 JSON 응답 방어 (Gemini/OpenAI 공용): 끝부분만 깨진 대형 응답에서
 * 완성된 {id, text} 항목만 건져 부분 반환 — 누락 id는 오케스트레이터가 재요청.
 */
function salvageIdTextItems(text) {
  const out = [];
  const re = /\{\s*"id"\s*:\s*(\d+)\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try { out.push({ id: Number(m[1]), text: JSON.parse(`"${m[2]}"`) }); } catch (e) { /* 항목 스킵 */ }
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════
 * 경로 전략 (Strategy) — 경로별 차이를 한 곳에 모은다.
 * 오케스트레이터(청크 순회·재시도·병합·캐시)는 전략을 통해서만
 * 경로를 만지므로, 새 엔진 추가 = 이 테이블에 항목 추가.
 * ═══════════════════════════════════════════════════════════ */
const ROUTES = {
  gemini: {
    label: (settings) => `Gemini(${settings.geminiModel})`,
    parallel: () => YTX.CHUNK_GEMINI.PARALLEL || 2,
    /** 시작 전 점검 — 문제가 있으면 {code, message} 반환 */
    precheck: (settings) => !settings.geminiApiKey
      ? { code: 'NO_API_KEY', message: 'Gemini API 키가 설정되지 않았습니다. 패널 설정에서 키를 입력하세요.' }
      : null,
    // 호출 횟수 최소화: 글자량 → 토큰 추정 기반 대형 청크 (FIRST 소형 청크 없음)
    buildChunks: (segments) => buildChunksByTokenBudget(segments, YTX.CHUNK_GEMINI, 'Gemini'),
    translateChunk: (chunk, ctx) => callGemini(chunk, ctx.caption, ctx.settings)
  },
  openai: {
    label: (settings) => `OpenAI(${settings.openaiModel || YTX.OPENAI.DEFAULT_MODEL})`,
    parallel: () => YTX.CHUNK_OPENAI.PARALLEL || 2,
    precheck: (settings) => !settings.openaiApiKey
      ? { code: 'NO_API_KEY', message: 'OpenAI API 키가 설정되지 않았습니다. 패널 설정에서 키를 입력하세요.' }
      : null,
    buildChunks: (segments) => buildChunksByTokenBudget(segments, YTX.CHUNK_OPENAI, 'OpenAI'),
    translateChunk: (chunk, ctx) => callOpenAI(chunk, ctx.caption, ctx.settings)
  },
  localhost: {
    label: (settings) => `Claude CLI · ${settings.serverAddress}`,
    parallel: () => YTX.CHUNK_LOCALHOST.PARALLEL || 2,
    precheck: () => null,
    // 로컬 서버는 호출 횟수 제약이 없으므로 첫 청크 소형화(FIRST)로 첫 화면 우선
    buildChunks: (segments) => buildChunks(segments, YTX.CHUNK_LOCALHOST),
    translateChunk: (chunk, ctx) => callLocalhost(chunk, ctx.chunkIndex, ctx.totalChunks, ctx.caption, ctx.settings)
  }
};

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
  const strategy = ROUTES[route] || ROUTES.localhost;
  const routeLabel = strategy.label(settings);

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

  const key = YTX.cacheKey(caption.video_id, targetLang, route, YTX.engineModelTag(settings));

  // ── 캐시 확인: 재방문 시 즉시 표시 (설계서 §4) ──
  // 1) 현재 엔진·모델 키 → 2) 없으면 모델/경로 무관 "완전 번역" 재사용.
  //    이미 번역이 끝난 영상은 엔진을 바꿔도 재번역하지 않는다 (토큰 절약).
  //    새 엔진으로 다시 번역하려면 캐시 관리에서 해당 항목 삭제 후 번역.
  const cachedWrap = await chrome.storage.local.get(key);
  let cached = cachedWrap[key];
  let reused = false;
  if (!(cached && cached.map && cached.complete)) {
    try {
      const all = await chrome.storage.local.get(null);
      const prefix = YTX.cacheKeyPrefix(caption.video_id, targetLang);
      const alt = Object.entries(all).find(([k, v]) =>
        k !== key && k.startsWith(prefix) && v && v.map && v.complete);
      if (alt) { cached = alt[1]; reused = true; }
    } catch (e) { /* 무시 — 재사용 조회 실패 시 일반 흐름 */ }
  }
  let translations = {}; // id(string) → 번역 텍스트

  if (cached && cached.map) {
    translations = { ...cached.map };
    if (cached.complete) {
      log(reused
        ? `캐시 재사용(다른 엔진/모델의 완전 번역) — ${caption.video_id}`
        : `캐시 적중(완전) — ${key}`);
      sendToTab(tabId, {
        type: YTX.MSG.TRANS_COMPLETE,
        videoId: caption.video_id,
        translations,
        failedChunks: [],
        fromCache: true,
        routeLabel: reused ? '저장된 번역 재사용' : routeLabel,
        targetLang
      });
      return;
    }
    log(`캐시 적중(부분, ${Object.keys(translations).length}개) — 누락분만 번역 진행`);
  }

  // ── 경로별 사전 점검 (전략) ──
  const pre = strategy.precheck(settings);
  if (pre) {
    sendToTab(tabId, {
      type: YTX.MSG.TRANS_CHUNK_ERROR,
      videoId: caption.video_id,
      chunkIndex: -1,
      code: pre.code,
      message: pre.message,
      routeLabel
    });
    return;
  }

  // 미번역 세그먼트만 청크 대상으로 (분할 방식은 경로 전략이 결정)
  const pending = caption.segments.filter((s) => translations[s.id] == null);
  const chunks = strategy.buildChunks(pending);
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
      const result = await translateChunkWithRetry(strategy, chunk, i, chunks.length, caption, settings, alive);

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
          const retryResult = await translateChunkWithRetry(strategy, missing, i, chunks.length, caption, settings, alive);
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
      // BAD_REQUEST/UNSUPPORTED_LANG/AUTH/QUOTA는 이후 청크도 같은 결과 — 작업 중단
      if (['BAD_REQUEST', 'UNSUPPORTED_LANG', 'AUTH', 'QUOTA'].includes(err.code)) fatal = true;
    }
  }

  const workerCount = Math.min(strategy.parallel(), chunks.length);
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

/* ── Gemini 사전 페이싱 게이트 ──────────────────────────────
 * 무료 티어의 낮은 RPM에 걸리지 않도록, 429를 맞기 전에 호출 간격을
 * 강제한다. 번역 청크·요약 등 모든 Gemini 호출이 이 게이트를 공유하며,
 * 병렬 워커도 게이트를 통과하는 순서대로 자연히 직렬화된다. */
let geminiNextSlotAt = 0;

async function acquireGeminiSlot(settings, alive) {
  const interval = YTX.GEMINI.PACING[settings.geminiTier === 'paid' ? 'paid' : 'free'];
  for (;;) {
    const now = Date.now();
    if (now >= geminiNextSlotAt) {
      geminiNextSlotAt = now + interval;
      return;
    }
    if (alive && !alive()) throw transError('CANCELLED', '작업 취소됨');
    await sleep(Math.min(geminiNextSlotAt - now, 500));
  }
}

/* ═══════════════════════════════════════════════════════════
 * Gemini 공용 요청 빌더 — 번역·요약이 공유하는 단일 진입점
 *
 * 구조화 출력 규격 (실 API 검증 기준):
 *  - 문서의 responseFormat.text.mimeType 예제는 실제 v1beta 프로토와 불일치
 *    (mime_type이 enum이라 "application/json" 거부 — 실사용 오류로 확인)
 *  - 같은 공식 문서의 Go SDK 예제가 쓰는 responseMimeType + responseJsonSchema
 *    조합이 REST에서 안정 동작 → 이를 1차 규격으로 사용
 *  - 필드 미지원 응답 시 구형 responseSchema(OpenAPI 서브셋)로 1회 폴백
 * ═══════════════════════════════════════════════════════════ */
function geminiGenerationConfig(schema, useLegacySchema) {
  const cfg = { temperature: 0, responseMimeType: 'application/json' }; // 하네스: 변동 최소화
  if (useLegacySchema) cfg.responseSchema = schema;
  else cfg.responseJsonSchema = schema;
  return cfg;
}

/**
 * @param opts { instruction, parts(문자열 또는 parts배열), schema, timeoutMs?, alive? }
 * @returns 모델 응답 텍스트 (JSON 문자열)
 */
async function geminiGenerate(settings, opts) {
  await acquireGeminiSlot(settings, opts.alive); // 사전 페이싱 — 429 예방
  const model = settings.geminiModel || YTX.GEMINI.DEFAULT_MODEL;
  const url = `${YTX.GEMINI.API_BASE}/${encodeURIComponent(model)}:generateContent`;
  const timeout = opts.timeoutMs || GEMINI_TIMEOUT_MS;
  const parts = typeof opts.parts === 'string' ? [{ text: opts.parts }] : opts.parts;

  const attempt = async (useLegacySchema) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.geminiApiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: opts.instruction }] },
          contents: [{ parts }],
          generationConfig: geminiGenerationConfig(opts.schema, useLegacySchema)
        }),
        signal: controller.signal
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        throw transError('TIMEOUT', `Gemini 응답 시간 초과 (${timeout / 1000}초)`);
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
        // RPD(일일 무료 사용량) 소진은 재시도 불가 → 별도 코드로 화면 표면화
        if (/day|daily|PerDay|quota.*exceeded|exhausted/i.test(detail)) {
          throw transError('QUOTA',
            'Gemini 무료 사용량(일일 한도)이 소진되었습니다 — 태평양 시간 자정에 리셋됩니다. ' +
            '설정에서 유료 티어 전환 또는 Claude CLI 경로를 사용하세요.');
        }
        const ra = parseInt(res.headers.get('Retry-After') || '0', 10);
        throw transError('RATE_LIMITED', detail || '요청 한도 초과', { retryAfterMs: ra > 0 ? ra * 1000 : 0 });
      }
      if (status === 400) {
        // 스키마 필드 미지원(구버전 백엔드) → 구형 responseSchema로 1회 폴백
        if (!useLegacySchema && /response_?json_?schema|Unknown name/i.test(detail)) {
          throw transError('SCHEMA_FIELD', detail); // attempt 루프에서 폴백 처리
        }
        throw transError('BAD_REQUEST', detail || '잘못된 요청 (API 키/모델명 확인)');
      }
      if (status === 401 || status === 403) throw transError('AUTH', detail || 'API 키 인증 실패');
      if (status >= 500) throw transError('UPSTREAM_ERROR', detail || `Gemini 서버 오류 (${status})`, { retriable: true });
      throw transError('UNKNOWN', `HTTP ${status}: ${detail}`);
    }

    const data = await res.json();
    // 프롬프트 자체가 차단된 경우 (candidates 없음)
    if (data?.promptFeedback?.blockReason) {
      throw transError('BLOCKED', `Gemini가 요청을 차단 (${data.promptFeedback.blockReason})`);
    }
    const cand = data?.candidates?.[0];
    const finish = cand?.finishReason;
    // 출력 토큰 한도 도달 → JSON이 잘려 있음. 호출부가 청크를 쪼개 재시도하도록 별도 코드
    if (finish === 'MAX_TOKENS') {
      throw transError('OUTPUT_LIMIT', '출력 토큰 한도 도달 — 청크 분할 필요');
    }
    // RECITATION(원문 재현 감지)·SAFETY 등으로 생성이 중단된 경우:
    // 같은 내용을 통째로 재시도해도 같은 이유로 끊긴다 → 청크를 쪼개면
    // 감지 문맥이 달라져 통과하는 경우가 많으므로 OUTPUT_LIMIT처럼 이분할로 처리
    if (finish && finish !== 'STOP') {
      throw transError('OUTPUT_LIMIT', `생성 중단 (${finish}) — 청크 분할로 재시도`);
    }
    return cand?.content?.parts?.map((p) => p.text || '').join('') || '';
  };

  try {
    return await attempt(false);
  } catch (e) {
    if (e.code === 'SCHEMA_FIELD') {
      log('responseJsonSchema 미지원 응답 — 구형 responseSchema로 폴백');
      return attempt(true);
    }
    throw e;
  }
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
async function translateChunkWithRetry(strategy, chunk, chunkIndex, totalChunks, caption, settings, alive) {
  const callOnce = () => strategy.translateChunk(chunk, { chunkIndex, totalChunks, caption, settings });

  let backoffTries = 0;
  let rateLimitTries = 0;

  for (;;) {
    if (!alive()) throw transError('CANCELLED', '작업 취소됨');
    await waitForCooldown(alive); // 다른 워커가 429를 받았다면 함께 대기
    try {
      DBG.count('attempts');
      const out = await callOnce();
      DBG.count('ok');
      return out;
    } catch (e) {
      // 출력 한도 도달(대형 청크의 유일한 실패 모드) → 이분할 재귀로 자동 복구
      if (e.code === 'OUTPUT_LIMIT' && chunk.length >= 2) {
        const mid = Math.ceil(chunk.length / 2);
        log(`청크 ${chunkIndex}: 출력 한도 도달 — ${chunk.length}세그를 ${mid}+${chunk.length - mid}로 분할`);
        const left = await translateChunkWithRetry(strategy, chunk.slice(0, mid), chunkIndex, totalChunks, caption, settings, alive);
        const right = await translateChunkWithRetry(strategy, chunk.slice(mid), chunkIndex, totalChunks, caption, settings, alive);
        return left.concat(right);
      }
      const err = e.code ? e : transError('UNKNOWN', String(e.message || e), { retriable: true });

      if (err.code === 'RATE_LIMITED' && rateLimitTries < 3) {
        rateLimitTries++;
        DBG.count('rateLimited');
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
        DBG.count('retries');
        log(`재시도 대기 ${wait}ms (${backoffTries}/${YTX.RETRY_BACKOFF_MS.length}) — ${err.code}`);
        await sleep(wait);
        continue;
      }
      DBG.count('failed', `${err.code}: ${err.message}`);
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
  const userPayload = JSON.stringify(chunk.map((s) => ({ id: s.id, text: s.text })));

  const text = await geminiGenerate(settings, {
    instruction: buildTranslatorPrompt(caption.source_lang, settings.targetLang),
    parts: `Translate these subtitle segments:\n${userPayload}`,
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
  });

  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error('배열 아님');
    return arr;
  } catch (e) {
    const salvaged = salvageIdTextItems(text);
    if (salvaged.length > 0) {
      log(`Gemini 응답 JSON 불완전 — 완성 항목 ${salvaged.length}개 salvage, 누락분은 재요청`);
      return salvaged;
    }
    // 건질 것도 없으면 계약 위반 — 재시도 가치 있음
    throw transError('PARSE', `Gemini 응답이 JSON 배열 계약을 위반: ${text.slice(0, 80)}`, { retriable: true });
  }
}

/* ═══════════════════════════════════════════════════════════
 * OpenAI 공용 요청 빌더 — 번역·요약이 공유하는 단일 진입점
 *
 * 규격 (공식 문서 확인, developers.openai.com 2026-07):
 * - POST /v1/chat/completions · Authorization: Bearer <key>
 * - 구조화 출력: response_format { type:'json_schema', json_schema:{ name, strict, schema } }
 *   strict 모드는 "루트=객체, 모든 object에 additionalProperties:false,
 *   전 필드 required"를 요구 → toOpenAiStrictSchema()가 자동 변환
 * - reasoning_effort: 모델 세대별 허용값 상이 → 모델 정의(constants)의 값을 쓰고,
 *   서버가 파라미터를 거부하면(400) 제거 후 1회 폴백
 * - finish_reason: 'length'(출력 한도)·'content_filter' → OUTPUT_LIMIT (이분할 재시도)
 * - 429: insufficient_quota(크레딧 소진, 재시도 불가) vs rate limit(RPM/TPM) 구분
 * ═══════════════════════════════════════════════════════════ */
const OPENAI_TIMEOUT_MS = 120000;

/** OpenAI strict 스키마 변환 — 모든 object에 required 전체 + additionalProperties:false */
function toOpenAiStrictSchema(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  const out = { ...node };
  if (out.type === 'object' && out.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(node.properties)) out.properties[k] = toOpenAiStrictSchema(v);
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  if (out.type === 'array' && out.items) out.items = toOpenAiStrictSchema(node.items);
  return out;
}

/**
 * @param opts { instruction, user, schemaName, schema, timeoutMs? }
 * @returns 모델 응답 텍스트 (JSON 문자열)
 */
async function openaiGenerate(settings, opts) {
  const model = settings.openaiModel || YTX.OPENAI.DEFAULT_MODEL;
  const modelDef = YTX.OPENAI.MODELS.find((m) => m.value === model);
  const timeout = opts.timeoutMs || OPENAI_TIMEOUT_MS;

  const attempt = async (omitEffort) => {
    const body = {
      model,
      messages: [
        { role: 'system', content: opts.instruction },
        { role: 'user', content: opts.user }
      ],
      max_completion_tokens: YTX.OPENAI.MAX_COMPLETION_TOKENS,
      response_format: {
        type: 'json_schema',
        json_schema: { name: opts.schemaName || 'result', strict: true, schema: toOpenAiStrictSchema(opts.schema) }
      }
    };
    if (!omitEffort && modelDef && modelDef.effort) body.reasoning_effort = modelDef.effort;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let res;
    try {
      res = await fetch(YTX.OPENAI.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.openaiApiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (e) {
      if (e.name === 'AbortError') throw transError('TIMEOUT', `OpenAI 응답 시간 초과 (${timeout / 1000}초)`);
      throw transError('NETWORK', `OpenAI API에 연결할 수 없습니다: ${e.message}`, { retriable: true });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const status = res.status;
      let apiErr = null;
      try { apiErr = (await res.json())?.error || null; } catch (e) { /* 무시 */ }
      const detail = apiErr?.message || '';
      const errCode = apiErr?.code || apiErr?.type || '';

      if (status === 429) {
        // 크레딧/한도 소진(재시도 불가) vs 순간 처리율(RPM/TPM) 구분 — Gemini QUOTA와 동일 취급
        if (/insufficient_quota|quota/i.test(errCode) || /quota/i.test(detail)) {
          throw transError('QUOTA',
            'OpenAI API 크레딧/사용 한도가 소진되었습니다 — platform.openai.com에서 결제·사용량을 확인하세요.');
        }
        const ra = parseInt(res.headers.get('Retry-After') || '0', 10);
        throw transError('RATE_LIMITED', detail || '요청 한도 초과 (RPM/TPM)', { retryAfterMs: ra > 0 ? ra * 1000 : 0 });
      }
      if (status === 400) {
        if (!omitEffort && /reasoning[_.]?effort/i.test(detail)) {
          throw transError('EFFORT_PARAM', detail); // attempt 루프에서 폴백 처리
        }
        throw transError('BAD_REQUEST', detail || '잘못된 요청 (모델명/키 확인)');
      }
      if (status === 401 || status === 403) throw transError('AUTH', detail || 'API 키 인증 실패');
      if (status >= 500) throw transError('UPSTREAM_ERROR', detail || `OpenAI 서버 오류 (${status})`, { retriable: true });
      throw transError('UNKNOWN', `HTTP ${status}: ${detail}`);
    }

    const data = await res.json();
    const choice = data?.choices?.[0];
    // 구조화 출력의 명시적 거부 응답
    if (choice?.message?.refusal) {
      throw transError('BLOCKED', `OpenAI가 요청을 거부: ${String(choice.message.refusal).slice(0, 100)}`);
    }
    const finish = choice?.finish_reason;
    if (finish === 'length') throw transError('OUTPUT_LIMIT', '출력 토큰 한도 도달 — 청크 분할 필요');
    if (finish === 'content_filter') throw transError('OUTPUT_LIMIT', '생성 중단 (content_filter) — 청크 분할로 재시도');
    return choice?.message?.content || '';
  };

  try {
    return await attempt(false);
  } catch (e) {
    if (e.code === 'EFFORT_PARAM') {
      log('reasoning_effort 미지원 응답 — 파라미터 없이 폴백');
      return attempt(true);
    }
    throw e;
  }
}

/* ═══════════════════════════════════════════════════════════
 * 경로 3 — OpenAI API 직접 호출
 * strict 스키마는 루트가 객체여야 하므로 {segments:[...]} 래핑 사용
 * ═══════════════════════════════════════════════════════════ */
async function callOpenAI(chunk, caption, settings) {
  const userPayload = JSON.stringify(chunk.map((s) => ({ id: s.id, text: s.text })));

  const text = await openaiGenerate(settings, {
    instruction: buildTranslatorPrompt(caption.source_lang, settings.targetLang),
    user: `Translate these subtitle segments:\n${userPayload}`,
    schemaName: 'subtitle_translations',
    schema: {
      type: 'object',
      properties: {
        segments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer', description: 'Segment id from the request' },
              text: { type: 'string', description: 'Translated subtitle text' }
            }
          }
        }
      }
    }
  });

  try {
    const obj = JSON.parse(text);
    if (!obj || !Array.isArray(obj.segments)) throw new Error('segments 배열 아님');
    return obj.segments;
  } catch (e) {
    const salvaged = salvageIdTextItems(text);
    if (salvaged.length > 0) {
      log(`OpenAI 응답 JSON 불완전 — 완성 항목 ${salvaged.length}개 salvage, 누락분은 재요청`);
      return salvaged;
    }
    throw transError('PARSE', `OpenAI 응답이 JSON 계약을 위반: ${text.slice(0, 80)}`, { retriable: true });
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
