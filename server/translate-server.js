#!/usr/bin/env node
'use strict';

const http = require('http');
const { spawn, execFileSync } = require('child_process');

const PORT = parseInt(process.env.PORT || process.argv[2] || '8787', 10);
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'sonnet';
const CLAUDE_EFFORT = /^(low|medium|high|xhigh|max)$/.test(process.env.CLAUDE_EFFORT || '')
  ? process.env.CLAUDE_EFFORT : 'low';
const CLI_TIMEOUT_MS = 180000;

const log = (...a) => console.log(new Date().toISOString(), ...a);

function claudeInvocation() {
  const lower = CLAUDE_BIN.toLowerCase();
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) {
    return { cmd: process.execPath, prefix: [CLAUDE_BIN] };
  }
  return { cmd: CLAUDE_BIN, prefix: [] };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
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
    const aborted = () => Object.assign(new Error('요청 취소됨'), { kind: 'ABORTED' });
    if (opts.signal && opts.signal.aborted) return reject(aborted());

    const inv = claudeInvocation();
    const args = [...inv.prefix, '-p', prompt];
    const model = opts.model || CLAUDE_MODEL;
    if (model) args.push('--model', model);
    if (opts.effort) args.push('--effort', opts.effort);

    const child = spawn(inv.cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal: opts.signal });

    let stdout = '', stderr = '';
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('Claude CLI 타임아웃'), { kind: 'UPSTREAM_ERROR' }));
    }, CLI_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(killer);
      if (e.name === 'AbortError') return reject(aborted());
      reject(Object.assign(new Error(`Claude CLI 실행 실패: ${e.message}`), { kind: 'UPSTREAM_ERROR' }));
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      const combined = code === 0 ? stderr : stdout + stderr;
      const lower = combined.toLowerCase();
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
        const cause = lower.includes('overloaded') ? 'Anthropic 서버 혼잡(529)' : '순간 처리율 제한(분당 요청/토큰)';
        const detail = combined.trim().slice(0, 150);
        reject(Object.assign(
          new Error(`일시 제한 — ${cause}. 자동 재시도됩니다. [CLI: ${detail}]`),
          { kind: 'RATE_LIMITED', stdout }
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

  return acquireSlot().then(() => task().finally(releaseSlot));
}

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
  return null;
}

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

function langName(code) {
  try {
    return `${new Intl.DisplayNames(['en'], { type: 'language' }).of(code)} (${code})`;
  } catch (e) {
    return code;
  }
}

async function handleTranslate(req, res, body, signal) {
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

  const src = source_lang || 'the auto-detected source language';
  const tgt = langName(target_lang);
  const n = segments.length;
  const prompt =
    `You are a professional subtitle translator. Translate each numbered line from ${src} to ${tgt}.\n` +
    `Infer the content's domain (e.g., software development, finance, medicine, gaming) and keep domain-specific technical terms, product/framework/library names, proper nouns and acronyms (Spring, Dependency Injection, endpoint, API, SQL) in their original form; translate the surrounding prose naturally.\n` +
    `Input format: one segment per line as N|text.\n` +
    `Output format: exactly one line per input line as N|translation, with the same numbers in the same order.\n` +
    `Rules:\n` +
    `- Never merge, split, skip, reorder or add lines. When a sentence spans several lines, translate each line's own fragment on its own line.\n` +
    `- A single-line input still gets a single N|translation line.\n` +
    `- Output only the numbered lines: no explanations, notes, markdown or code fences, and no text in any language other than ${tgt} apart from the preserved terms.\n` +
    `- Keep translations natural and concise for on-screen subtitles, preserving tone.\n` +
    `Example input:\n` +
    `1|<first segment>\n` +
    `2|<second segment>\n` +
    `Example output:\n` +
    `1|<translation of the first segment>\n` +
    `2|<translation of the second segment>\n` +
    `\n` +
    `[${n} lines — output exactly ${n} lines]\n` +
    segments.map((s, i) => `${i + 1}|${String(s.text).replace(/\s+/g, ' ').trim()}`).join('\n');

  const chunkInfo = chunk ? ` (청크 ${chunk.index + 1}/${chunk.total})` : '';
  log(`번역 요청: ${video_id || '?'} → ${target_lang}, ${n}개 세그먼트${chunkInfo}`);

  let parsed;
  try {
    const stdout = await runClaude(prompt, { effort: CLAUDE_EFFORT, signal });
    parsed = parseNumberedLines(stdout, n);
    if (parsed.size === 0) {
      log('오류: 번역 줄을 찾지 못함');
      return sendError(res, 502, 'UPSTREAM_ERROR', `응답에서 번역 줄을 찾지 못함: ${stdout.slice(0, 120)}`);
    }
  } catch (e) {
    if (signal.aborted) return log(`번역 취소됨: ${video_id || '?'}${chunkInfo}`);
    parsed = parseNumberedLines(e.stdout, n);
    parsed.delete(Math.max(...parsed.keys()));
    if (parsed.size === 0) {
      log('오류:', e.message);
      if (e.kind === 'RATE_LIMITED') {
        return sendError(res, 429, 'RATE_LIMITED', e.message, 5000);
      }
      return sendError(res, 502, 'UPSTREAM_ERROR', e.message);
    }
    log(`오류 발생했으나 부분 결과 salvage: ${parsed.size}개 (${e.message.slice(0, 80)})`);
  }

  const out = [...parsed].map(([num, text]) => ({ id: segments[num - 1].id, text }));

  log(`번역 완료: ${out.length}/${n}개 반환`);
  sendJson(res, 200, { video_id: video_id || '', target_lang, segments: out });
}

async function handleSummarize(req, res, body, signal) {
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
  const safeModel = typeof model === 'string' && /^[\w.-]+$/.test(model) ? model : '';
  const safeEffort = typeof effort === 'string' && /^(low|medium|high|xhigh|max)$/.test(effort) ? effort : '';

  const start = Date.now();
  log(`요약 요청: instruction ${instruction.length}자 + content ${content.length}자` +
    `${safeModel ? ` · model=${safeModel}` : ''}${safeEffort ? ` · effort=${safeEffort}` : ''}`);

  let obj;
  try {
    const stdout = await runClaude(`${instruction}\n\n${content}`, { model: safeModel, effort: safeEffort, signal });
    const cleaned = stdout.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const slice = extractBalancedJson(cleaned, '{');
    if (!slice) throw Object.assign(new Error('응답에서 JSON 객체를 찾지 못함'), { kind: 'UPSTREAM_ERROR' });
    obj = parseJsonWithDiagnostics(slice);
  } catch (e) {
    if (signal.aborted) return log('요약 취소됨');
    log('요약 오류:', e.message);
    if (e.kind === 'RATE_LIMITED') return sendError(res, 429, 'RATE_LIMITED', e.message, 5000);
    return sendError(res, 502, 'UPSTREAM_ERROR', e.message);
  }

  log(`요약 응답 반환 (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  sendJson(res, 200, obj);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    return sendJson(res, 204, {});
  }
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, engine: `claude -p (model: ${CLAUDE_MODEL || 'CLI 기본'})` });
  }
  if (req.method === 'POST' && (req.url === '/translate' || req.url === '/summarize')) {
    const handler = req.url === '/translate' ? handleTranslate : handleSummarize;
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      handler(req, res, body, ac.signal).catch((e) => {
        log('처리 예외:', e);
        sendError(res, 502, 'UPSTREAM_ERROR', String(e.message || e));
      });
    });
    return;
  }
  sendError(res, 404, 'BAD_REQUEST', `지원하지 않는 경로: ${req.method} ${req.url}`);
});

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

if (require.main === module) {
  try {
    const inv = claudeInvocation();
    const version = execFileSync(inv.cmd, [...inv.prefix, '--version'], { encoding: 'utf-8', timeout: 10000 }).trim();
    log(`Claude CLI: ${version}`);
    log(`CLI 실행: ${inv.cmd}${inv.prefix.length ? ' ' + inv.prefix.join(' ') : ''}`);

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

  const HOST = process.env.HOST || '127.0.0.1';

  server.listen(PORT, HOST, () => {
    log(`translate-server 시작 — http://${HOST}:${PORT}/translate (엔진: claude -p, 모델: ${CLAUDE_MODEL || 'CLI 기본'}, effort: ${CLAUDE_EFFORT})`);
    if (HOST !== '127.0.0.1') log('LAN 모드 — 같은 네트워크의 다른 기기에서 <이 기기 IP>:' + PORT + ' 로 접근 가능');
    selfTest();
  });
}

module.exports = { parseNumberedLines };
