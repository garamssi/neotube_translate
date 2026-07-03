#!/usr/bin/env node
/**
 * translate-server.js — localhost 번역 서버 (Claude CLI 기반)
 *
 * 확장의 "localhost 서버" 경로(설계서 §6 계약)를 구현한다.
 * 내부 번역 엔진: Claude Code CLI를 `claude -p`(print 모드)로 호출.
 *
 * 계약 (설계서 §6 확정안 v1):
 *   POST /translate
 *   요청:  { video_id, source_lang, target_lang, chunk{index,total}, segments[{id,start,end,text}] }
 *   응답:  { video_id, target_lang, segments[{id,text}] }   — 부분집합 허용, id 필수
 *   오류:  { error: { code, message, retry_after_ms? } }
 *          BAD_REQUEST | RATE_LIMITED | UPSTREAM_ERROR | UNSUPPORTED_LANG
 *
 * CLI 호출 방식: `claude -p "<프롬프트>"` — 프롬프트를 argv로 전달하는 최소
 * 옵션 구성. (실사용 검증된 프록시 패턴에 맞춤. stdin 파이프 + 다중 플래그
 * 조합에서 인증 컨텍스트 문제가 보고되어 단순화함)
 *
 * 실행:
 *   node translate-server.js [포트]
 *   환경변수:
 *     PORT          기본 8787
 *     CLAUDE_BIN    기본 'claude'
 *     CLAUDE_MODEL  기본 'sonnet' (= Sonnet 5, CLI 별칭). 빈 값으로 주면 CLI 기본 모델.
 *                   빠른 응답이 필요하면 CLAUDE_MODEL=haiku (확장 타임아웃 20초 참고)
 *
 * "Not logged in" 오류가 나면:
 *   1) 서버를 실행한 같은 터미널에서 `claude -p "hi"` 가 되는지 확인
 *   2) 그 셸에 ANTHROPIC_API_KEY가 빈 값/무효 값으로 설정돼 있지 않은지 확인
 *      (설정돼 있으면 OAuth 로그인 대신 이 키를 우선 사용함)
 *   3) `which claude`로 PATH의 claude가 로그인한 설치본과 같은지 확인
 */
'use strict';

const http = require('http');
const { spawn, execFileSync } = require('child_process');

const PORT = parseInt(process.env.PORT || process.argv[2] || '8787', 10);
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'sonnet'; // 기본: Sonnet 5 (CLI 별칭 'sonnet' = 최신 Sonnet)
const CLI_TIMEOUT_MS = 150000; // 확장의 요청 타임아웃(150s)과 동일 상한

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ── 응답 헬퍼 ─────────────────────────────────────────────── */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // 설계서 §6: host_permissions 호출이라 필수는 아니지만 디버깅 편의를 위한 권고사항
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function sendError(res, status, code, message, retryAfterMs) {
  const error = { code, message };
  if (retryAfterMs) error.retry_after_ms = retryAfterMs;
  sendJson(res, status, { error });
}

/* ── Claude CLI 호출 (세마포어 — 동시 MAX_CONCURRENT개) ─────── */
const MAX_CONCURRENT = parseInt(process.env.CLAUDE_CONCURRENCY || '3', 10);
let running = 0;
const waitQueue = [];

function acquireSlot() {
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve));
}

function releaseSlot() {
  const next = waitQueue.shift();
  if (next) next();
  else running--;
}

function runClaude(prompt, opts = {}) {
  const task = () => new Promise((resolve, reject) => {
    // 검증된 최소 호출: 프롬프트를 argv로 전달, stdin 미사용
    const args = ['-p', prompt];
    const model = opts.model || CLAUDE_MODEL; // 요청별 모델 오버라이드 (요약 등)
    if (model) args.push('--model', model);
    if (opts.effort) args.push('--effort', opts.effort); // low: 사고 최소화 → 응답 속도·일관성 향상

    const child = spawn(CLAUDE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '', stderr = '';
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('Claude CLI 타임아웃'), { kind: 'UPSTREAM_ERROR' }));
    }, CLI_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(killer);
      reject(Object.assign(new Error(`Claude CLI 실행 실패: ${e.message}`), { kind: 'UPSTREAM_ERROR' }));
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      const combined = stdout + stderr;
      const lower = combined.toLowerCase();
      // 종료 코드와 무관하게 인증/한도 문구를 우선 감지
      if (lower.includes('not logged in')) {
        reject(Object.assign(
          new Error(
            '서버가 실행한 claude 프로세스가 로그인 정보를 찾지 못했습니다. ' +
            '터미널의 claude와 다른 설치본이 잡혔을 가능성이 큽니다. ' +
            '서버 시작 로그의 "CLI 경로"와, 평소 쓰는 터미널의 `which claude` 결과를 비교하세요. ' +
            '다르면 CLAUDE_BIN=<로그인된 claude 경로> 로 서버를 실행하거나, `claude setup-token`으로 토큰을 만들어 CLAUDE_CODE_OAUTH_TOKEN으로 전달하세요.'
          ),
          { kind: 'UPSTREAM_ERROR' }
        ));
        return;
      }
      if (lower.includes('rate limit') || lower.includes('overloaded')) {
        // 구분: rate limit = 분당 처리율(RPM/TPM) 초과(쿼터 소진 아님) / overloaded = Anthropic 서버 혼잡(529)
        // 둘 다 잠시 후 재시도하면 해결되므로 확장에는 동일하게 RATE_LIMITED로 응답(자동 재시도됨)
        const cause = lower.includes('overloaded') ? 'Anthropic 서버 혼잡(529)' : '순간 처리율 제한(분당 요청/토큰)';
        const detail = combined.trim().slice(0, 150);
        reject(Object.assign(
          new Error(`일시 제한 — ${cause}. 자동 재시도됩니다. [CLI: ${detail}]`),
          { kind: 'RATE_LIMITED', stdout } // stdout 동봉 — 부분 결과 salvage용
        ));
        return;
      }
      if (code !== 0) {
        reject(Object.assign(
          new Error(`Claude CLI 종료 코드 ${code}: ${(stderr || stdout).slice(0, 200)}`),
          { kind: 'UPSTREAM_ERROR', stdout }
        ));
        return;
      }
      resolve(stdout.trim());
    });
  });

  // 세마포어: 동시 MAX_CONCURRENT개까지 병렬 실행 (확장도 청크를 병렬 호출)
  return acquireSlot().then(() => task().finally(releaseSlot));
}

/**
 * 균형 스캔 JSON 추출 — "첫 여는 괄호 ~ 마지막 닫는 괄호" 방식의 함정
 * (본문 프로즈에 중괄호/대괄호 혼입) 없이, 문자열·이스케이프를 인지하며
 * 괄호 짝이 맞는 첫 JSON 값 구간을 잘라낸다.
 */
function extractBalancedJson(text, openChar) {
  const closeChar = openChar === '{' ? '}' : ']';
  const start = text.indexOf(openChar);
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // 미완성(도중 끊김 등)
}

/** 파싱 실패 지점 주변을 로그로 남겨 원인 진단을 돕는다 */
function parseJsonWithDiagnostics(jsonText) {
  try {
    return JSON.parse(jsonText);
  } catch (e) {
    const m = String(e.message).match(/position (\d+)/);
    const pos = m ? parseInt(m[1], 10) : -1;
    const around = pos >= 0 ? jsonText.slice(Math.max(0, pos - 40), pos + 40) : jsonText.slice(0, 80);
    log(`JSON 파싱 실패 지점 주변: …${around}…`);
    throw Object.assign(new Error(`모델 출력이 JSON 규격 위반: ${e.message}`), { kind: 'UPSTREAM_ERROR' });
  }
}

/** claude 텍스트 출력 → 번역 배열 파싱 (코드펜스/부가 텍스트 방어) */
function parseClaudeOutput(stdout) {
  const cleaned = stdout.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const slice = extractBalancedJson(cleaned, '[');
  if (!slice) {
    throw Object.assign(new Error(`응답에서 JSON 배열을 찾지 못함: ${cleaned.slice(0, 120)}`), { kind: 'UPSTREAM_ERROR' });
  }
  const arr = parseJsonWithDiagnostics(slice);
  if (!Array.isArray(arr)) {
    throw Object.assign(new Error('응답이 배열이 아님'), { kind: 'UPSTREAM_ERROR' });
  }
  return arr;
}

/**
 * 부분 결과 salvage — CLI가 도중에 끊겨도(레이트리밋 등) 완성된
 * {"id":N,"text":"..."} 객체들을 건져낸다.
 * 설계서 §6 부분 응답 규칙: 응답이 요청 id의 부분집합이어도 유효,
 * 누락 id는 확장이 자동 재시도하므로 앞부분 번역을 버리지 않아도 된다.
 */
function salvagePartial(stdout) {
  if (!stdout) return [];
  const out = [];
  const re = /\{\s*"id"\s*:\s*(\d+)\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let m;
  while ((m = re.exec(stdout)) !== null) {
    try {
      out.push({ id: parseInt(m[1], 10), text: JSON.parse(`"${m[2]}"`) });
    } catch (e) { /* 개별 항목 파싱 실패는 건너뜀 */ }
  }
  return out;
}

/* ── /translate 처리 ───────────────────────────────────────── */
async function handleTranslate(req, res, body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (e) {
    return sendError(res, 400, 'BAD_REQUEST', '요청 본문이 JSON이 아닙니다');
  }

  const { video_id, source_lang, target_lang, chunk, segments } = payload || {};
  if (!target_lang || !Array.isArray(segments) || segments.length === 0) {
    return sendError(res, 400, 'BAD_REQUEST', 'target_lang과 segments는 필수입니다');
  }
  for (const s of segments) {
    if (s == null || s.id == null || typeof s.text !== 'string') {
      return sendError(res, 400, 'BAD_REQUEST', 'segments 항목은 {id, text}가 필수입니다');
    }
  }

  // 시스템 지침을 프롬프트 본문에 포함 (argv 단일 프롬프트 방식)
  const prompt =
    `You are a professional subtitle translator. Translate subtitle segments ` +
    `from ${source_lang || 'the auto-detected source language'} to ${target_lang}.\n` +
    `First, infer the content's domain (e.g., software development, finance, medicine, gaming) from the segments.\n` +
    `Terminology rules:\n` +
    `- Keep domain-specific technical terms, product/framework/library names, and widely-used ` +
    `industry jargon in their original English form. Examples for IT content: Spring, Bean, ` +
    `Dependency Injection, Controller, endpoint, deploy, container, Kubernetes, commit, branch.\n` +
    `- Translate the surrounding prose naturally into ${target_lang}; only the terms stay in English.\n` +
    `- Proper nouns and acronyms (API, JVM, SQL) stay as-is.\n` +
    `Output rules: Respond ONLY with a JSON array: [{"id": <number>, "text": "<translation>"}]. ` +
    `One object per requested id, same ids as the request, no extra ids, ` +
    `no markdown fences, no explanations. Keep translations natural and concise ` +
    `for on-screen subtitles, preserving tone.\n\n` +
    `Segments:\n${JSON.stringify(segments.map((s) => ({ id: s.id, text: s.text })))}`;

  const chunkInfo = chunk ? ` (청크 ${chunk.index + 1}/${chunk.total})` : '';
  log(`번역 요청: ${video_id || '?'} → ${target_lang}, ${segments.length}개 세그먼트${chunkInfo}`);

  let arr;
  try {
    const stdout = await runClaude(prompt);
    arr = parseClaudeOutput(stdout);
  } catch (e) {
    // CLI가 도중에 끊긴 경우: 완성된 항목만 건져 부분 응답으로 반환 (§6 부분 응답 규칙)
    // → 확장이 누락 id만 작게 재요청하므로, 이미 번역된 앞부분을 버리지 않는다.
    const salvaged = salvagePartial(e.stdout);
    if (salvaged.length > 0) {
      log(`오류 발생했으나 부분 결과 salvage: ${salvaged.length}개 (${e.message.slice(0, 80)})`);
      arr = salvaged;
    } else {
      log('오류:', e.message);
      if (e.kind === 'RATE_LIMITED') {
        return sendError(res, 429, 'RATE_LIMITED', e.message, 5000);
      }
      return sendError(res, 502, 'UPSTREAM_ERROR', e.message);
    }
  }

  // 요청 id만 통과 (부분 응답 허용 — 누락분은 확장이 재시도)
  const requested = new Set(segments.map((s) => String(s.id)));
  const out = arr
    .filter((x) => x && requested.has(String(x.id)) && typeof x.text === 'string')
    .map((x) => ({ id: x.id, text: x.text }));

  log(`번역 완료: ${out.length}/${segments.length}개 반환`);
  sendJson(res, 200, { video_id: video_id || '', target_lang, segments: out });
}

/* ── /summarize 처리 — 범용 JSON 실행기 ──────────────────────
 * 요청: { instruction, content } — 프롬프트 구성은 확장(bg/summary.js)이
 * 단일 소스로 관리하고, 서버는 실행 + JSON 객체 추출만 담당한다.
 * (단일/맵/리듀스 요약이 모두 이 엔드포인트를 공유) */
async function handleSummarize(req, res, body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (e) {
    return sendError(res, 400, 'BAD_REQUEST', '요청 본문이 JSON이 아닙니다');
  }

  const { instruction, content, model, effort } = payload || {};
  if (typeof instruction !== 'string' || !instruction.trim()
    || typeof content !== 'string' || !content.trim()) {
    return sendError(res, 400, 'BAD_REQUEST', 'instruction과 content는 필수입니다');
  }
  // 인자 오염 방지: 모델/effort는 안전한 토큰만 허용
  const safeModel = typeof model === 'string' && /^[\w.-]+$/.test(model) ? model : '';
  const safeEffort = typeof effort === 'string' && /^(low|medium|high|xhigh|max)$/.test(effort) ? effort : '';

  const start = Date.now();
  log(`요약 요청: instruction ${instruction.length}자 + content ${content.length}자` +
    `${safeModel ? ` · model=${safeModel}` : ''}${safeEffort ? ` · effort=${safeEffort}` : ''}`);

  let obj;
  try {
    const stdout = await runClaude(`${instruction}\n\n${content}`, { model: safeModel, effort: safeEffort });
    // JSON 객체 추출 (코드펜스 방어 + 균형 스캔)
    const cleaned = stdout.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const slice = extractBalancedJson(cleaned, '{');
    if (!slice) throw Object.assign(new Error('응답에서 JSON 객체를 찾지 못함'), { kind: 'UPSTREAM_ERROR' });
    obj = parseJsonWithDiagnostics(slice);
  } catch (e) {
    log('요약 오류:', e.message);
    if (e.kind === 'RATE_LIMITED') return sendError(res, 429, 'RATE_LIMITED', e.message, 5000);
    return sendError(res, 502, 'UPSTREAM_ERROR', e.message);
  }

  log(`요약 응답 반환 (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  sendJson(res, 200, obj);
}

/* ── HTTP 서버 ─────────────────────────────────────────────── */
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    return sendJson(res, 204, {});
  }
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, engine: `claude -p (model: ${CLAUDE_MODEL || 'CLI 기본'})` });
  }
  if (req.method === 'POST' && (req.url === '/translate' || req.url === '/summarize')) {
    const handler = req.url === '/translate' ? handleTranslate : handleSummarize;
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      handler(req, res, body).catch((e) => {
        log('처리 예외:', e);
        sendError(res, 502, 'UPSTREAM_ERROR', String(e.message || e));
      });
    });
    return;
  }
  sendError(res, 404, 'BAD_REQUEST', `지원하지 않는 경로: ${req.method} ${req.url}`);
});

/* ── 시작 시 CLI 확인 + 인증 자가 테스트 ───────────────────── */
try {
  const version = execFileSync(CLAUDE_BIN, ['--version'], { encoding: 'utf-8', timeout: 5000 }).trim();
  log(`Claude CLI: ${version}`);
  try {
    const bin = execFileSync(process.platform === 'win32' ? 'where' : 'which', [CLAUDE_BIN], { encoding: 'utf-8', timeout: 3000 }).trim();
    log(`CLI 경로: ${bin}`);
  } catch (e) { /* 무시 */ }

  // 인증 소스 진단 (우선순위: CLI 로그인(OAuth) 기준으로 안내)
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    log('인증: CLAUDE_CODE_OAUTH_TOKEN 사용 (claude setup-token 발급 토큰)');
  } else if (process.env.ANTHROPIC_API_KEY) {
    log('참고: ANTHROPIC_API_KEY가 이 셸에 설정되어 있어 CLI 로그인 대신 이 키가 사용될 수 있습니다. CLI 로그인을 쓰려면 unset 하세요.');
  } else {
    log('인증: CLI 로그인(OAuth) 사용 예정');
  }
  if (process.env.CLAUDE_CONFIG_DIR) {
    log(`CLAUDE_CONFIG_DIR: ${process.env.CLAUDE_CONFIG_DIR} — 터미널과 다르면 로그인 정보를 못 찾을 수 있습니다.`);
  }
} catch (e) {
  log(`경고: claude CLI를 찾을 수 없습니다 (${CLAUDE_BIN}). PATH를 확인하세요.`);
}

/** 인증 자가 테스트 — 서버가 띄우는 프로세스 컨텍스트에서 실제 호출해 확인 */
function selfTest() {
  log('인증 자가 테스트 중… (claude 1회 호출)');
  runClaude('Reply with exactly: OK')
    .then((out) => log(`자가 테스트 통과 — 응답: "${out.slice(0, 30)}" → 번역 요청을 처리할 준비가 되었습니다.`))
    .catch((e) => {
      log('─'.repeat(60));
      log(`자가 테스트 실패: ${e.message}`);
      log('이 터미널에서 직접 확인: claude -p "hi"');
      log('점검 순서: 1) 같은 셸에서 위 명령이 되는지  2) echo $ANTHROPIC_API_KEY  3) which claude');
      log('─'.repeat(60));
    });
}

// HOST=0.0.0.0 으로 실행하면 LAN의 다른 기기에서도 접근 가능
// (확장 설정의 '서버 주소'에 <이 기기 IP>:포트 입력)
const HOST = process.env.HOST || '127.0.0.1';

server.listen(PORT, HOST, () => {
  log(`translate-server 시작 — http://${HOST}:${PORT}/translate (엔진: claude -p, 모델: ${CLAUDE_MODEL || 'CLI 기본'})`);
  if (HOST !== '127.0.0.1') log('LAN 모드 — 같은 네트워크의 다른 기기에서 <이 기기 IP>:' + PORT + ' 로 접근 가능');
  selfTest();
});
