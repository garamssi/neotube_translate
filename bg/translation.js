'use strict';

const activeJobs = new Map();

function cancelTabJobs(tabId) {
  const job = activeJobs.get(tabId);
  if (job) job.controller.abort();
  activeJobs.delete(tabId);
}

let keepaliveTimer = null;
let runningJobCount = 0;

function keepaliveAcquire() {
  runningJobCount++;
  if (!keepaliveTimer) {
    keepaliveTimer = setInterval(() => {
      chrome.runtime.getPlatformInfo(() => {});
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

const GEMINI_TIMEOUT_MS = 180000;
const OPENAI_TIMEOUT_MS = 120000;

async function getSettings() {
  const stored = await chrome.storage.local.get(YTX.STORAGE.SETTINGS);
  return YTX.normalizeSettings(stored[YTX.STORAGE.SETTINGS]);
}

const CACHE_MAX_ENTRIES = 30;

async function pruneCache() {
  try {
    const all = await chrome.storage.local.get(null);
    const cacheKeys = Object.keys(all)
      .filter((k) => k.startsWith(YTX.STORAGE.CACHE_PREFIX + '|') || k.startsWith(YTX.STORAGE.SUM_PREFIX + '|'))
      .sort((a, b) => (all[a].cached_at || 0) - (all[b].cached_at || 0));
    if (cacheKeys.length > CACHE_MAX_ENTRIES) {
      const evict = cacheKeys.slice(0, cacheKeys.length - CACHE_MAX_ENTRIES);
      await chrome.storage.local.remove(evict);
      log(`캐시 프루닝 — ${evict.length}개 항목 제거`);
    }
  } catch (e) { warn('캐시 프루닝 실패:', e.message); }
}

let cacheWriteChain = Promise.resolve();

function saveTranslations(key, translations, segments, title) {
  if (Object.keys(translations).length === 0) return cacheWriteChain;
  cacheWriteChain = cacheWriteChain.then(async () => {
    const prev = (await chrome.storage.local.get(key))[key];
    const map = { ...(prev && prev.map), ...translations };
    await chrome.storage.local.set({
      [key]: {
        map,
        complete: segments.every((s) => map[String(s.id)] != null),
        cached_at: Math.floor(Date.now() / 1000),
        title: title || (prev && prev.title) || ''
      }
    });
  }).catch((e) => warn('캐시 저장 실패:', e.message));
  return cacheWriteChain;
}

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
  log(`${engine} 청크 계획: 원문 ${totalChars.toLocaleString()}자 → 예상 출력 ~${totalEst.toLocaleString()} 토큰 ` +
    `→ ${chunks.length}개 요청 (예산 ${cfg.OUTPUT_TOKEN_BUDGET.toLocaleString()} 토큰/청크)`);
  return chunks;
}

const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim();

function langName(code) {
  try {
    return `${new Intl.DisplayNames(['en'], { type: 'language' }).of(code)} (${code})`;
  } catch (e) {
    return code;
  }
}

function buildTranslatorPrompt(sourceLang, targetLang) {
  const tgt = langName(targetLang);
  return [
    `You are a professional subtitle translator. Translate each numbered line from ${sourceLang || 'the source language'} to ${tgt}.`,
    'Infer the content\'s domain (e.g., software development, finance, medicine, gaming) and keep domain-specific technical terms, ' +
      'product/framework/library names, proper nouns and acronyms (Spring, Dependency Injection, endpoint, API, SQL) in their original form; ' +
      'translate the surrounding prose naturally.',
    'Input format: one segment per line as N|text.',
    'Output format: exactly one line per input line as N|translation, with the same numbers in the same order.',
    'Rules:',
    '- Never merge, split, skip, reorder or add lines. When a sentence spans several lines, translate each line\'s own fragment on its own line.',
    '- A single-line input still gets a single N|translation line.',
    `- Output only the numbered lines: no explanations, notes, markdown or code fences, and no text in any language other than ${tgt} apart from the preserved terms.`,
    '- Keep translations natural and concise for on-screen subtitles, preserving tone.',
    'Example input:',
    '1|<first segment>',
    '2|<second segment>',
    'Example output:',
    '1|<translation of the first segment>',
    '2|<translation of the second segment>'
  ].join('\n');
}

function buildLinePayload(chunk) {
  return `[${chunk.length} lines — output exactly ${chunk.length} lines]\n` +
    chunk.map((s, i) => `${i + 1}|${s.text}`).join('\n');
}

function parseNumberedLines(text, count) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('```'));
  const out = new Map();
  const dup = new Set();
  for (const line of lines) {
    const m = /^(\d+)\s*\|\s*(.*)$/.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    if (n < 1 || n > count || !m[2]) continue;
    if (out.has(n)) dup.add(n);
    else out.set(n, m[2]);
  }
  for (const n of dup) out.delete(n);
  return out;
}

function linesToItems(text, chunk, engine) {
  const parsed = parseNumberedLines(text, chunk.length);
  if (parsed.size === 0) {
    throw transError('PARSE', `${engine} 응답이 줄 형식 계약을 위반: ${String(text).slice(0, 80)}`, { retriable: true });
  }
  return [...parsed].map(([n, translated]) => ({ id: chunk[n - 1].id, text: translated }));
}

const ROUTES = {
  gemini: {
    label: (settings) => `Gemini(${settings.geminiModel})`,
    parallel: () => YTX.CHUNK_GEMINI.PARALLEL,
    precheck: (settings) => !settings.geminiApiKey
      ? { code: 'NO_API_KEY', message: 'Gemini API 키가 설정되지 않았습니다. 패널 설정에서 키를 입력하세요.' }
      : null,
    buildChunks: (segments) => buildChunksByTokenBudget(segments, YTX.CHUNK_GEMINI, 'Gemini'),
    translateChunk: callGemini
  },
  openai: {
    label: (settings) => `OpenAI(${settings.openaiModel})`,
    parallel: () => YTX.CHUNK_OPENAI.PARALLEL,
    precheck: (settings) => !settings.openaiApiKey
      ? { code: 'NO_API_KEY', message: 'OpenAI API 키가 설정되지 않았습니다. 패널 설정에서 키를 입력하세요.' }
      : null,
    buildChunks: (segments) => buildChunksByTokenBudget(segments, YTX.CHUNK_OPENAI, 'OpenAI'),
    translateChunk: callOpenAI
  },
  localhost: {
    label: (settings) => `Claude CLI · ${settings.serverAddress}`,
    parallel: () => YTX.CHUNK_LOCALHOST.PARALLEL,
    precheck: () => null,
    buildChunks: (segments) => buildChunks(segments, YTX.CHUNK_LOCALHOST),
    translateChunk: callLocalhost
  }
};

function sendToTab(tabId, payload) {
  return chrome.tabs.sendMessage(tabId, payload).catch(() => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function transError(code, message, { retriable = false, retryAfterMs = 0 } = {}) {
  return { code, message, retriable, retryAfterMs };
}

async function fetchWithTimeout(url, init, timeoutMs, signal) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort);
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (timedOut) throw transError('TIMEOUT', `응답 시간 초과 (${timeoutMs / 1000}초)`);
    if (e.name === 'AbortError') throw transError('CANCELLED', '작업 취소됨');
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function runTranslationJob(tabId, caption, title) {
  if (!caption || !Array.isArray(caption.segments) || caption.segments.length === 0) return;
  cancelTabJobs(tabId);
  const job = { controller: new AbortController() };
  activeJobs.set(tabId, job);
  keepaliveAcquire();
  try {
    await runTranslationJobInner(tabId, caption, title || '', job);
  } finally {
    keepaliveRelease();
    if (activeJobs.get(tabId) === job) activeJobs.delete(tabId);
  }
}

async function runTranslationJobInner(tabId, caption, title, job) {
  const alive = () => activeJobs.get(tabId) === job;

  const settings = await getSettings();
  const { route, targetLang } = settings;
  const strategy = ROUTES[route] || ROUTES.localhost;
  const routeLabel = strategy.label(settings);

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
    } catch (e) { warn('캐시 재사용 조회 실패:', e.message); }
  }
  const translations = {};

  if (cached && cached.map) {
    Object.assign(translations, cached.map);
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

  const knownByText = new Map();
  for (const s of caption.segments) {
    const done = translations[String(s.id)];
    if (done != null) knownByText.set(oneLine(s.text), done);
  }
  const twins = new Map();
  const repByText = new Map();
  const pending = [];
  for (const s of caption.segments) {
    const id = String(s.id);
    if (translations[id] != null) continue;
    const text = oneLine(s.text);
    if (knownByText.has(text)) {
      translations[id] = knownByText.get(text);
    } else if (repByText.has(text)) {
      twins.get(repByText.get(text)).push(id);
    } else {
      repByText.set(text, id);
      twins.set(id, []);
      pending.push({ id: s.id, text });
    }
  }

  const chunks = strategy.buildChunks(pending);
  const totalSegs = caption.segments.length;
  const deduped = totalSegs - Object.keys(translations).length - pending.length;
  if (deduped > 0) log(`중복 원문 ${deduped}개는 1회만 전송`);

  sendToTab(tabId, {
    type: YTX.MSG.TRANS_STATUS,
    videoId: caption.video_id,
    totalChunks: chunks.length,
    totalSegments: totalSegs,
    doneSegments: Object.keys(translations).length,
    translations,
    routeLabel,
    targetLang
  });

  const failedChunks = [];
  let nextIdx = 0;
  let fatal = false;

  async function processChunk(i) {
    const chunk = chunks[i];
    const ctx = {
      strategy, chunkIndex: i, totalChunks: chunks.length, caption, settings, alive,
      signal: job.controller.signal
    };
    try {
      const merged = {};
      const collect = (items) => {
        const requested = new Set(chunk.map((s) => String(s.id)));
        for (const item of items) {
          if (item && requested.has(String(item.id)) && typeof item.text === 'string') {
            merged[String(item.id)] = item.text;
          }
        }
      };
      collect(await translateChunkWithRetry(chunk, ctx));

      const missing = chunk.filter((s) => merged[String(s.id)] == null);
      if (missing.length > 0 && alive()) {
        log(`청크 ${i}: 누락 id ${missing.length}개 재시도`);
        try {
          collect(await translateChunkWithRetry(missing, ctx));
        } catch (e) { warn(`청크 ${i} 누락분 재시도 실패:`, e.message || e.code); }
        const lost = chunk.filter((s) => merged[String(s.id)] == null);
        if (lost.length > 0 && alive()) {
          failedChunks.push({ index: i, ids: lost.map((s) => s.id), code: 'MISSING', message: `${lost.length}개 줄 누락` });
        }
      }

      for (const [id, text] of Object.entries(merged)) {
        for (const twinId of twins.get(id) || []) merged[twinId] = text;
      }
      Object.assign(translations, merged);
      saveTranslations(key, merged, caption.segments, title);

      if (!alive()) return;
      sendToTab(tabId, {
        type: YTX.MSG.TRANS_PROGRESS,
        videoId: caption.video_id,
        chunkIndex: i,
        totalChunks: chunks.length,
        translations: merged,
        doneSegments: Object.keys(translations).length,
        totalSegments: totalSegs,
        routeLabel
      });
    } catch (e) {
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
      if (FATAL_CODES.includes(err.code)) fatal = true;
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

  await saveTranslations(key, translations, caption.segments, title);
  pruneCache();
  if (!alive()) { log('번역 작업 중단 — 완료분은 캐시에 보존'); return; }

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

const FATAL_CODES = ['BAD_REQUEST', 'UNSUPPORTED_LANG', 'AUTH', 'QUOTA'];
let rateLimitedUntil = 0;

async function waitForCooldown(alive) {
  while (Date.now() < rateLimitedUntil) {
    if (!alive()) throw transError('CANCELLED', '작업 취소됨');
    await sleep(Math.min(rateLimitedUntil - Date.now(), 1000));
  }
}

async function translateChunkWithRetry(chunk, ctx) {
  let backoffTries = 0;
  let rateLimitTries = 0;

  for (;;) {
    if (!ctx.alive()) throw transError('CANCELLED', '작업 취소됨');
    await waitForCooldown(ctx.alive);
    try {
      DBG.count('attempts');
      const out = await ctx.strategy.translateChunk(chunk, ctx);
      DBG.count('ok');
      return out;
    } catch (e) {
      if (e.code === 'CANCELLED') throw e;
      if (e.code === 'OUTPUT_LIMIT' && chunk.length >= 2) {
        const mid = Math.ceil(chunk.length / 2);
        log(`청크 ${ctx.chunkIndex}: 출력 한도 도달 — ${chunk.length}세그를 ${mid}+${chunk.length - mid}로 분할`);
        const items = [];
        let halfError = null;
        for (const half of [chunk.slice(0, mid), chunk.slice(mid)]) {
          try {
            items.push(...await translateChunkWithRetry(half, ctx));
          } catch (err) {
            if (err.code === 'CANCELLED' || FATAL_CODES.includes(err.code)) throw err;
            halfError = err;
          }
        }
        if (items.length === 0 && halfError) throw halfError;
        return items;
      }
      const err = e.code ? e : transError('UNKNOWN', String(e.message || e), { retriable: true });

      if (err.code === 'RATE_LIMITED' && rateLimitTries < 3) {
        rateLimitTries++;
        DBG.count('rateLimited');
        const wait = Math.min(
          err.retryAfterMs > 0 ? err.retryAfterMs : YTX.RETRY_BACKOFF_MS[Math.min(backoffTries, 1)],
          60000
        );
        rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + wait);
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

let geminiNextSlotAt = 0;
const geminiThinkingRejected = new Set();

async function acquireGeminiSlot(settings, signal) {
  const interval = YTX.GEMINI.PACING[settings.geminiTier === 'paid' ? 'paid' : 'free'];
  for (;;) {
    if (signal && signal.aborted) throw transError('CANCELLED', '작업 취소됨');
    const now = Date.now();
    if (now >= geminiNextSlotAt) {
      geminiNextSlotAt = now + interval;
      return;
    }
    await sleep(Math.min(geminiNextSlotAt - now, 500));
  }
}

async function geminiGenerate(settings, opts) {
  await acquireGeminiSlot(settings, opts.signal);
  const model = settings.geminiModel || YTX.GEMINI.DEFAULT_MODEL;
  const url = `${YTX.GEMINI.API_BASE}/${encodeURIComponent(model)}:generateContent`;
  const timeout = opts.timeoutMs || GEMINI_TIMEOUT_MS;
  const parts = typeof opts.parts === 'string' ? [{ text: opts.parts }] : opts.parts;
  const flags = { legacySchema: false, thinking: !!opts.thinkingLevel && !geminiThinkingRejected.has(model) };

  const attempt = async () => {
    const generationConfig = {};
    if (opts.schema) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig[flags.legacySchema ? 'responseSchema' : 'responseJsonSchema'] = opts.schema;
    }
    if (flags.thinking) generationConfig.thinkingConfig = { thinkingLevel: opts.thinkingLevel };

    let res;
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.geminiApiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: opts.instruction }] },
          contents: [{ parts }],
          generationConfig
        })
      }, timeout, opts.signal);
    } catch (e) {
      if (e.code) throw e;
      throw transError('NETWORK', `Gemini API에 연결할 수 없습니다: ${e.message}`, { retriable: true });
    }

    if (!res.ok) {
      const status = res.status;
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch (e) { detail = ''; }

      if (status === 429) {
        if (/day|daily|PerDay|quota.*exceeded|exhausted/i.test(detail)) {
          throw transError('QUOTA',
            'Gemini 무료 사용량(일일 한도)이 소진되었습니다 — 태평양 시간 자정에 리셋됩니다. ' +
            '설정에서 유료 티어 전환 또는 Claude CLI 경로를 사용하세요.');
        }
        const ra = parseInt(res.headers.get('Retry-After') || '0', 10);
        throw transError('RATE_LIMITED', detail || '요청 한도 초과', { retryAfterMs: ra > 0 ? ra * 1000 : 0 });
      }
      if (status === 400) {
        if (flags.thinking && /thinking/i.test(detail)) throw transError('THINKING_PARAM', detail);
        if (opts.schema && !flags.legacySchema && /response_?json_?schema|Unknown name/i.test(detail)) {
          throw transError('SCHEMA_FIELD', detail);
        }
        throw transError('BAD_REQUEST', detail || '잘못된 요청 (API 키/모델명 확인)');
      }
      if (status === 401 || status === 403) throw transError('AUTH', detail || 'API 키 인증 실패');
      if (status >= 500) throw transError('UPSTREAM_ERROR', detail || `Gemini 서버 오류 (${status})`, { retriable: true });
      throw transError('UNKNOWN', `HTTP ${status}: ${detail}`);
    }

    const data = await res.json();
    if (data?.promptFeedback?.blockReason) {
      throw transError('BLOCKED', `Gemini가 요청을 차단 (${data.promptFeedback.blockReason})`);
    }
    const cand = data?.candidates?.[0];
    const finish = cand?.finishReason;
    if (finish === 'MAX_TOKENS') {
      throw transError('OUTPUT_LIMIT', '출력 토큰 한도 도달 — 청크 분할 필요');
    }
    if (finish && finish !== 'STOP') {
      throw transError('OUTPUT_LIMIT', `생성 중단 (${finish}) — 청크 분할로 재시도`);
    }
    return cand?.content?.parts?.filter((p) => !p.thought).map((p) => p.text || '').join('') || '';
  };

  for (;;) {
    try {
      return await attempt();
    } catch (e) {
      if (e.code === 'THINKING_PARAM') {
        log('thinkingLevel 미지원 응답 — 파라미터 없이 폴백');
        flags.thinking = false;
        geminiThinkingRejected.add(model);
      } else if (e.code === 'SCHEMA_FIELD') {
        log('responseJsonSchema 미지원 응답 — 구형 responseSchema로 폴백');
        flags.legacySchema = true;
      } else {
        throw e;
      }
    }
  }
}

async function callGemini(chunk, ctx) {
  const modelDef = YTX.GEMINI.MODELS.find((m) => m.value === ctx.settings.geminiModel);
  const text = await geminiGenerate(ctx.settings, {
    instruction: buildTranslatorPrompt(ctx.caption.source_lang, ctx.settings.targetLang),
    parts: buildLinePayload(chunk),
    thinkingLevel: modelDef && modelDef.thinking,
    signal: ctx.signal
  });
  return linesToItems(text, chunk, 'Gemini');
}

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
      max_completion_tokens: YTX.OPENAI.MAX_COMPLETION_TOKENS
    };
    if (opts.schema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: opts.schemaName || 'result', strict: true, schema: toOpenAiStrictSchema(opts.schema) }
      };
    }
    if (!omitEffort && modelDef && modelDef.effort) body.reasoning_effort = modelDef.effort;

    let res;
    try {
      res = await fetchWithTimeout(YTX.OPENAI.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.openaiApiKey}` },
        body: JSON.stringify(body)
      }, timeout, opts.signal);
    } catch (e) {
      if (e.code) throw e;
      throw transError('NETWORK', `OpenAI API에 연결할 수 없습니다: ${e.message}`, { retriable: true });
    }

    if (!res.ok) {
      const status = res.status;
      let apiErr = null;
      try { apiErr = (await res.json())?.error || null; } catch (e) { apiErr = null; }
      const detail = apiErr?.message || '';
      const errCode = apiErr?.code || apiErr?.type || '';

      if (status === 429) {
        if (/insufficient_quota|quota/i.test(errCode) || /quota/i.test(detail)) {
          throw transError('QUOTA',
            'OpenAI API 크레딧/사용 한도가 소진되었습니다 — platform.openai.com에서 결제·사용량을 확인하세요.');
        }
        const ra = parseInt(res.headers.get('Retry-After') || '0', 10);
        throw transError('RATE_LIMITED', detail || '요청 한도 초과 (RPM/TPM)', { retryAfterMs: ra > 0 ? ra * 1000 : 0 });
      }
      if (status === 400) {
        if (!omitEffort && /reasoning[_.]?effort/i.test(detail)) throw transError('EFFORT_PARAM', detail);
        throw transError('BAD_REQUEST', detail || '잘못된 요청 (모델명/키 확인)');
      }
      if (status === 401 || status === 403) throw transError('AUTH', detail || 'API 키 인증 실패');
      if (status >= 500) throw transError('UPSTREAM_ERROR', detail || `OpenAI 서버 오류 (${status})`, { retriable: true });
      throw transError('UNKNOWN', `HTTP ${status}: ${detail}`);
    }

    const data = await res.json();
    const choice = data?.choices?.[0];
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

async function callOpenAI(chunk, ctx) {
  const text = await openaiGenerate(ctx.settings, {
    instruction: buildTranslatorPrompt(ctx.caption.source_lang, ctx.settings.targetLang),
    user: buildLinePayload(chunk),
    signal: ctx.signal
  });
  return linesToItems(text, chunk, 'OpenAI');
}

async function callLocalhost(chunk, ctx) {
  const url = `${YTX.buildServerBase(ctx.settings.serverAddress)}/translate`;

  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_id: ctx.caption.video_id,
        source_lang: ctx.caption.source_lang,
        target_lang: ctx.settings.targetLang,
        chunk: { index: ctx.chunkIndex, total: ctx.totalChunks },
        segments: chunk.map((s) => ({ id: s.id, text: s.text }))
      })
    }, YTX.LOCALHOST_TIMEOUT_MS, ctx.signal);
  } catch (e) {
    if (e.code) throw e;
    throw transError('CONNECTION', '서버에 연결할 수 없습니다', { retriable: true });
  }

  if (!res.ok) {
    let errBody = null;
    try { errBody = await res.json(); } catch (e) { errBody = null; }
    const code = errBody?.error?.code || 'UPSTREAM_ERROR';
    const message = errBody?.error?.message || `HTTP ${res.status}`;
    const retryAfterMs = errBody?.error?.retry_after_ms || 0;

    switch (code) {
      case 'BAD_REQUEST':      throw transError('BAD_REQUEST', message);
      case 'RATE_LIMITED':     throw transError('RATE_LIMITED', message, { retryAfterMs });
      case 'UPSTREAM_ERROR':   throw transError('UPSTREAM_ERROR', message, { retriable: true });
      case 'UNSUPPORTED_LANG': throw transError('UNSUPPORTED_LANG', message);
      default:                 throw transError('UPSTREAM_ERROR', `${code}: ${message}`, { retriable: true });
    }
  }

  const data = await res.json();
  if (!data || !Array.isArray(data.segments)) {
    throw transError('PARSE', '응답에 segments 배열이 없습니다', { retriable: true });
  }
  return data.segments;
}
