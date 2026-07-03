/**
 * bg/summary.js — 영상 요약 (수동 전용)
 *
 * 스크립트 원문 + 영상 제목으로 대상 언어 요약을 생성한다.
 * 번역과 독립적으로 동작(번역 불필요·비용 절감). 결과는 수준별로 캐시.
 *
 * 긴 영상 전략 (정확성 우선 — 샘플링 없음):
 *  - 단문(≤ SUMMARY_SINGLE_MAX_CHARS): 단일 호출 (가장 빠름)
 *  - 장문: map-reduce — 블록별 부분 요약(병렬) → 통합 요약.
 *    정보 손실 없이 전 구간을 커버하고, 진행 상황을 패널에 전달한다.
 *
 * 출력 계약: { tldr: string[], sections: [{start, title, summary}] }
 *  - brief: sections는 빈 배열 / 섹션 start(초)는 패널에서 클릭 seek에 사용
 */
'use strict';

const SUMMARY_SINGLE_MAX_CHARS = 60000; // ≈ 1시간 영상 — 이하 단일 호출
const SUMMARY_BLOCK_CHARS = 40000;      // ≈ 45분 — map 블록 크기 (세그먼트 경계 분할)

function fmtTimeBg(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ═══════════════════════════════════════════════════════════
 * 트랜스크립트 · 블록 분할
 * ═══════════════════════════════════════════════════════════ */
function buildTranscript(segments) {
  return segments.map((s) => `[${fmtTimeBg(s.start)}] ${s.text}`).join('\n');
}

/** 세그먼트 경계를 유지하며 SUMMARY_BLOCK_CHARS 단위 블록으로 분할 */
function buildSummaryBlocks(segments) {
  const blocks = [];
  let cur = [];
  let chars = 0;
  for (const s of segments) {
    const line = `[${fmtTimeBg(s.start)}] ${s.text}`;
    if (chars + line.length > SUMMARY_BLOCK_CHARS && cur.length > 0) {
      blocks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push({ line, start: s.start });
    chars += line.length + 1;
  }
  if (cur.length) blocks.push(cur);
  return blocks.map((b) => ({
    start: b[0].start,
    end: b[b.length - 1].start,
    text: b.map((x) => x.line).join('\n')
  }));
}

/* ═══════════════════════════════════════════════════════════
 * 프롬프트 (단일/맵/리듀스) — 두 경로 공용
 * 서버는 instruction+content를 그대로 실행하는 범용 실행기이므로
 * 프롬프트 정의는 여기 한 곳에만 존재한다.
 * ═══════════════════════════════════════════════════════════ */
/* 수준별 하네스 2계층 구조:
 *  - OUTPUT_CONTRACT: 공통 골격(스키마·JSON 안전·용어) — 수준 무관 고정
 *  - levelRule: 수준별 분량 + 문체 — 짧게=초압축 개조식 / 표준=간결 개조식 /
 *    상세=서술형 허용(개조식 강제는 설명·예시·수치를 깎으므로) */
function levelRule(level) {
  switch (level) {
    case 'brief':
      return (
        'Level: BRIEF — "tldr" with 3-5 bullet points. "sections" must be an empty array.\n' +
        'Style for BRIEF: ultra-compressed 개조식 (noun-form/–함 endings), each bullet within 40 Korean characters, ' +
        'conclusions only — no explanations or examples.'
      );
    case 'detailed':
      return (
        'Level: DETAILED — "tldr" with 3-5 bullets, then 8-15 sections covering the full flow.\n' +
        'Style for DETAILED: tldr stays 개조식; section summaries use complete declarative sentences ("-다" endings), ' +
        '2-4 sentences each, including concrete numbers, examples, and takeaways mentioned in the content. ' +
        'Prefer completeness of information over brevity.'
      );
    default:
      return (
        'Level: STANDARD — "tldr" with 3-5 bullets, then 5-10 sections.\n' +
        'Style for STANDARD: concise 개조식 (noun-form/–함 endings) throughout; each section summary 1-2 sentences, no filler.'
      );
  }
}

/** 수준별 실행 설정(모델·effort). 사용자가 'auto'가 아닌 모델을 고르면 오버라이드 */
function summaryExecConfig(settings, level) {
  const lv = YTX.SUMMARY_LEVELS.find((l) => l.value === level) || YTX.SUMMARY_LEVELS[1];
  const chosen = settings.summaryClaudeModel || 'auto';
  return {
    model: chosen === 'auto' ? lv.model : chosen,
    effort: lv.effort // effort는 항상 수준을 따름 (상세=medium)
  };
}

/* 하네스: 출력 규격·문체를 고정해 실행마다 형식이 달라지지 않게 한다.
 * - 필드 순서·타입·항목 수 범위 고정, 추가 필드 금지
 * - 문체 고정: 개조식(명사형/–함 종결), 이모지·마크다운 금지
 * - 제목 형식 고정: 15자 이내 명사구 */
const OUTPUT_CONTRACT =
  `STRICT OUTPUT RULES (must follow exactly):\n` +
  `1) Output ONLY one JSON object — no markdown fences, no text before/after.\n` +
  `2) Use EXACTLY the specified keys in the specified order. No extra keys.\n` +
  `3) "start" is an integer number of seconds, taken from the [m:ss] markers (never invented).\n` +
  `4) No emojis, no markdown formatting, no honorifics, no filler phrases. ` +
  `(Sentence style follows the Level rules below.)\n` +
  `5) Section titles: noun phrases within 15 characters.\n` +
  `6) Keep domain-specific technical terms, product/framework names in English (e.g., Spring, JWT, endpoint).\n` +
  `7) JSON safety: NEVER use the double-quote character (") inside any string value — ` +
  `for quotations use 『 』 instead. Do not use backslashes inside string values.`;

function promptFinal(level, targetLang, title) {
  return (
    `You are a video content summarizer. Summarize the YouTube video transcript in ${targetLang}. ` +
    `Video title: "${title}".\n` +
    `Schema (exact key order): {"tldr": ["..."], "sections": [{"start": 0, "title": "...", "summary": "..."}]}\n` +
    `${levelRule(level)}\n${OUTPUT_CONTRACT}`
  );
}

/** Gemini URL 모드 — 영상을 직접 시청·분석. 하네스 규칙은 동일 적용 */
function promptVideoUrl(level, targetLang, title) {
  return (
    `You are a video content summarizer. Watch the attached YouTube video and summarize it in ${targetLang}. ` +
    `Video title: "${title}".\n` +
    `Schema (exact key order): {"tldr": ["..."], "sections": [{"start": 0, "title": "...", "summary": "..."}]}\n` +
    `"start" is the integer number of seconds from the beginning of the video where the section begins ` +
    `(derive from the video timeline; never invent).\n` +
    `${levelRule(level)}\n${OUTPUT_CONTRACT}`
  );
}

function promptMap(targetLang, title, idx, total, fromT, toT) {
  return (
    `You are summarizing PART ${idx + 1} of ${total} (${fromT}–${toT}) of a video titled "${title}". ` +
    `Summarize ONLY this part in ${targetLang}.\n` +
    `Schema (exact key order): {"sections": [{"start": 0, "title": "...", "summary": "..."}], "points": ["..."]}\n` +
    `Exactly 3-6 sections for this part; exactly 3-8 key points capturing important details.\n` +
    `${OUTPUT_CONTRACT}`
  );
}

function promptReduce(level, targetLang, title) {
  return (
    `You are consolidating partial summaries of a long video titled "${title}". ` +
    `The input is a JSON array of parts, each with timestamped sections and key points, in chronological order. ` +
    `Produce the FINAL summary of the whole video in ${targetLang}.\n` +
    `Schema (exact key order): {"tldr": ["..."], "sections": [{"start": 0, "title": "...", "summary": "..."}]}\n` +
    `Reuse the given section timestamps (merge/select — never invent new ones).\n` +
    `${levelRule(level)}\n${OUTPUT_CONTRACT}`
  );
}

const FINAL_SCHEMA = {
  type: 'object',
  properties: {
    tldr: { type: 'array', items: { type: 'string' } },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: { start: { type: 'number' }, title: { type: 'string' }, summary: { type: 'string' } },
        required: ['start', 'title', 'summary']
      }
    }
  },
  required: ['tldr', 'sections']
};

const MAP_SCHEMA = {
  type: 'object',
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: { start: { type: 'number' }, title: { type: 'string' }, summary: { type: 'string' } },
        required: ['start', 'title', 'summary']
      }
    },
    points: { type: 'array', items: { type: 'string' } }
  },
  required: ['sections', 'points']
};

/* ═══════════════════════════════════════════════════════════
 * 파싱/검증
 * ═══════════════════════════════════════════════════════════ */
function sanitizeSections(sections) {
  return (Array.isArray(sections) ? sections : [])
    .filter((s) => s && typeof s.title === 'string')
    .map((s) => ({ start: Number(s.start) || 0, title: String(s.title), summary: String(s.summary || '') }))
    .sort((a, b) => a.start - b.start);
}

function parseSummaryPayload(obj) {
  if (!obj || !Array.isArray(obj.tldr)) throw transError('PARSE', '요약 응답에 tldr 배열이 없습니다', { retriable: true });
  return {
    tldr: obj.tldr.map(String).filter(Boolean),
    sections: sanitizeSections(obj.sections)
  };
}

function parseMapPayload(obj) {
  if (!obj || (!Array.isArray(obj.sections) && !Array.isArray(obj.points))) {
    throw transError('PARSE', '부분 요약 응답 형식 오류', { retriable: true });
  }
  return {
    sections: sanitizeSections(obj.sections),
    points: (Array.isArray(obj.points) ? obj.points : []).map(String).filter(Boolean)
  };
}

/* ═══════════════════════════════════════════════════════════
 * 라우트 공용 JSON 호출 + 재시도
 * ═══════════════════════════════════════════════════════════ */
async function modelJsonCall(settings, instruction, content, schema, exec) {
  return settings.route === 'gemini'
    ? geminiJsonCall(settings, instruction, content, schema)
    : localhostJsonCall(settings, instruction, content, exec);
}

/** 재시도: 번역과 동일 정책(백오프 2회 + 429 공유 쿨다운) */
async function withSummaryRetry(callOnce) {
  let backoffTries = 0;
  let rateLimitTries = 0;
  const alive = () => true; // 결과는 content에서 videoId로 필터

  for (;;) {
    await waitForCooldown(alive);
    try {
      return await callOnce();
    } catch (e) {
      const err = e.code ? e : transError('UNKNOWN', String(e.message || e), { retriable: true });
      if (err.code === 'RATE_LIMITED' && rateLimitTries < 3) {
        rateLimitTries++;
        const wait = Math.min(err.retryAfterMs > 0 ? err.retryAfterMs : YTX.RETRY_BACKOFF_MS[Math.min(backoffTries, 1)], 60000);
        rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + wait);
        log(`요약 429 — ${wait}ms 쿨다운 (${rateLimitTries}/3)`);
        await sleep(wait);
        continue;
      }
      if (err.retriable && backoffTries < YTX.RETRY_BACKOFF_MS.length) {
        const wait = YTX.RETRY_BACKOFF_MS[backoffTries];
        backoffTries++;
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

// Gemini URL 모드: 영상 처리 시간이 텍스트보다 길다 → 별도 타임아웃.
// 주의: SW 수명 규칙상 장시간 fetch는 keepalive(요약 작업 중 상시 가동)로
// 워커를 유지한다 — 그래도 종료가 관찰되면 offscreen document로 이전 (확인 필요).
const GEMINI_VIDEO_TIMEOUT_MS = 180000;

/**
 * @param parts 문자열(텍스트 콘텐츠) 또는 Gemini parts 배열(fileData 포함 가능)
 */
async function geminiJsonCall(settings, instruction, parts, schema, timeoutMs) {
  const model = settings.geminiModel || YTX.GEMINI.DEFAULT_MODEL;
  const url = `${YTX.GEMINI.API_BASE}/${encodeURIComponent(model)}:generateContent`;
  const timeout = timeoutMs || GEMINI_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.geminiApiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instruction }] },
        contents: [{ parts: typeof parts === 'string' ? [{ text: parts }] : parts }],
        generationConfig: {
          temperature: 0, // 하네스: 실행 간 결과 변동 최소화
          responseFormat: { text: { mimeType: 'application/json', schema } }
        }
      }),
      signal: controller.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      // 시간 초과: 조용한 재시도 루프 대신 즉시 오류 표면화 (재시도는 사용자 버튼으로)
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
      const ra = parseInt(res.headers.get('Retry-After') || '0', 10);
      throw transError('RATE_LIMITED', detail || '요청 한도 초과', { retryAfterMs: ra > 0 ? ra * 1000 : 0 });
    }
    if (status === 400) throw transError('BAD_REQUEST', detail || '잘못된 요청');
    if (status === 401 || status === 403) throw transError('AUTH', detail || 'API 키 인증 실패');
    throw transError('UPSTREAM_ERROR', detail || `Gemini 서버 오류 (${status})`, { retriable: status >= 500 });
  }

  const dataJson = await res.json();
  const text = dataJson?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  try {
    return JSON.parse(text);
  } catch (e) {
    throw transError('PARSE', `요약 응답 파싱 실패: ${text.slice(0, 80)}`, { retriable: true });
  }
}

async function localhostJsonCall(settings, instruction, content, exec) {
  const url = `${YTX.buildServerBase(settings.serverAddress)}/summarize`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), YTX.LOCALHOST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        instruction,
        content,
        model: exec.model,  // 수준별 자동(짧게=haiku, 표준/상세=sonnet) 또는 사용자 오버라이드
        effort: exec.effort // 짧게/표준=low, 상세=medium
      })
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      // 시간 초과: 즉시 오류 표면화 (조용한 150초×3 재시도 루프 제거)
      throw transError('TIMEOUT', `요약 응답 시간 초과 (${YTX.LOCALHOST_TIMEOUT_MS / 1000}초) — 모델을 haiku로 바꾸면 빨라집니다`);
    }
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
    if (code === 'RATE_LIMITED') throw transError('RATE_LIMITED', message, { retryAfterMs });
    if (code === 'BAD_REQUEST') throw transError('BAD_REQUEST', message);
    throw transError('UPSTREAM_ERROR', message, { retriable: true });
  }
  return res.json();
}

/* ═══════════════════════════════════════════════════════════
 * 오케스트레이터
 * ═══════════════════════════════════════════════════════════ */
async function runSummaryJob(tabId, payload) {
  if (!payload || !Array.isArray(payload.segments) || payload.segments.length === 0) return;
  keepaliveAcquire();
  try {
    await runSummaryJobInner(tabId, payload);
  } finally {
    keepaliveRelease();
  }
}

async function runSummaryJobInner(tabId, payload) {
  const { videoId, title, level, segments, force } = payload;
  const settings = await getSettings();
  const { route, targetLang } = settings;
  const exec = route === 'gemini' ? null : summaryExecConfig(settings, level); // 수준별 모델·effort
  const model = route === 'gemini' ? settings.geminiModel : exec.model;
  const routeLabel = route === 'gemini'
    ? `Gemini(${model})`
    : `Claude CLI(${model}) · ${settings.serverAddress}`;
  const key = YTX.sumKey(videoId, targetLang, route, model, level);

  const sendProgress = (done, total) =>
    sendToTab(tabId, { type: YTX.MSG.SUMMARY_PROGRESS, videoId, level, done, total });

  // 캐시 확인 (force = '다시 요약')
  const wrap = force ? {} : await chrome.storage.local.get(key);
  if (wrap[key] && wrap[key].data) {
    log(`요약 캐시 적중 — ${key}`);
    sendToTab(tabId, { type: YTX.MSG.SUMMARY_COMPLETE, videoId, level, data: wrap[key].data, routeLabel, fromCache: true });
    return;
  }

  if (route === 'gemini' && !settings.geminiApiKey) {
    sendToTab(tabId, {
      type: YTX.MSG.SUMMARY_ERROR, videoId, level,
      code: 'NO_API_KEY', message: 'Gemini API 키가 설정되지 않았습니다.', routeLabel
    });
    return;
  }

  let data;
  try {
    if (route === 'gemini') {
      /* ── Gemini URL 모드: 영상을 직접 분석 (트랜스크립트 전송 불필요) ──
       * 하네스 동일 적용: STRICT 규격 + temperature 0 + 스키마 강제 */
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      log(`요약(Gemini URL 모드) — ${videoUrl} [${level}] (${routeLabel})`);
      sendProgress(0, 1);
      const obj = await withSummaryRetry(() => geminiJsonCall(
        settings,
        promptVideoUrl(level, targetLang, title),
        [
          { fileData: { fileUri: videoUrl } },
          { text: `Summarize this video titled "${title}".` }
        ],
        FINAL_SCHEMA,
        GEMINI_VIDEO_TIMEOUT_MS
      ));
      data = parseSummaryPayload(obj);
      sendProgress(1, 1);
    } else {
      data = await summarizeFromTranscript(videoId, title, level, segments, settings, targetLang, exec, sendProgress);
    }
  } catch (e) {
    const err = e.code ? e : transError('UNKNOWN', String(e.message || e));
    warn(`요약 실패 [${err.code}]: ${err.message}`);
    sendToTab(tabId, { type: YTX.MSG.SUMMARY_ERROR, videoId, level, code: err.code, message: err.message, routeLabel });
    return;
  }

  await chrome.storage.local.set({
    [key]: { data, cached_at: Math.floor(Date.now() / 1000), title: title || '', level }
  });
  pruneCache();

  sendToTab(tabId, { type: YTX.MSG.SUMMARY_COMPLETE, videoId, level, data, routeLabel, fromCache: false });
  log(`요약 완료 — TL;DR ${data.tldr.length}줄, 섹션 ${data.sections.length}개`);
}

/** Claude CLI 경로: 트랜스크립트 기반 (단일 또는 map-reduce). 결과 data 반환 */
async function summarizeFromTranscript(videoId, title, level, segments, settings, targetLang, exec, sendProgress) {
  const transcript = buildTranscript(segments);

  if (transcript.length <= SUMMARY_SINGLE_MAX_CHARS) {
    /* ── 단일 호출 (짧은 영상 — 가장 빠름) ── */
    log(`요약(단일) — ${videoId} [${level}] ${transcript.length}자 (${exec.model}/${exec.effort})`);
    sendProgress(0, 1);
    const obj = await withSummaryRetry(() =>
      modelJsonCall(settings, promptFinal(level, targetLang, title), `Transcript:\n${transcript}`, FINAL_SCHEMA, exec));
    return parseSummaryPayload(obj);
  }

  /* ── map-reduce (긴 영상 — 샘플링 없이 전 구간 커버) ── */
  {
    const blocks = buildSummaryBlocks(segments);
    const total = blocks.length + 1; // 블록 + 통합
    log(`요약(map-reduce) — ${videoId} [${level}] ${transcript.length}자 → ${blocks.length}개 블록`);
    let done = 0;
    sendProgress(done, total);

    // map: 블록별 부분 요약 (병렬 한도)
    const parallel = YTX.CHUNK_LOCALHOST.PARALLEL || 2;
      const results = new Array(blocks.length);
      let nextIdx = 0;
      let mapError = null;

      const workers = Array.from({ length: Math.min(parallel, blocks.length) }, () => (async () => {
        for (;;) {
          if (mapError) return;
          const i = nextIdx++;
          if (i >= blocks.length) return;
          try {
            const b = blocks[i];
            const obj = await withSummaryRetry(() => modelJsonCall(
              settings,
              promptMap(targetLang, title, i, blocks.length, fmtTimeBg(b.start), fmtTimeBg(b.end)),
              `Part transcript:\n${b.text}`,
              MAP_SCHEMA,
              exec
            ));
            results[i] = parseMapPayload(obj);
            done++;
            sendProgress(done, total);
          } catch (e) {
            // 정확성 우선: 블록 하나라도 최종 실패하면 전체 실패로 처리 (재시도는 위에서 소진)
            mapError = e;
          }
        }
      })());
      await Promise.all(workers);
      if (mapError) throw mapError;

      // reduce: 부분 요약 통합 (입력이 작아 빠름)
    const reduceInput = JSON.stringify(results.map((r, i) => ({
      part: i + 1,
      from: fmtTimeBg(blocks[i].start),
      sections: r.sections,
      points: r.points
    })));
    const obj = await withSummaryRetry(() =>
      modelJsonCall(settings, promptReduce(level, targetLang, title), `Partial summaries:\n${reduceInput}`, FINAL_SCHEMA, exec));
    const data = parseSummaryPayload(obj);
    done++;
    sendProgress(done, total);
    return data;
  }
}
