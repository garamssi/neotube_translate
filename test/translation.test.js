'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const server = require('../server/translate-server.js');

function loadExtension({ settings, fetchImpl }) {
  const store = { settings };
  const sent = [];
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, Intl, Date, Promise,
    log: () => {}, warn: () => {}, DBG: { count: () => {} },
    fetch: fetchImpl,
    chrome: {
      runtime: { getPlatformInfo: () => {} },
      tabs: { sendMessage: async (tabId, msg) => { sent.push(msg); } },
      storage: { local: {
        get: async (k) => (k == null ? { ...store } : (k in store ? { [k]: structuredClone(store[k]) } : {})),
        set: async (obj) => { Object.assign(store, structuredClone(obj)); },
        remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; }
      } }
    }
  });
  for (const f of ['constants.js', 'bg/translation.js', 'bg/summary.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf-8'), ctx, { filename: f });
  }
  const api = vm.runInContext('({ YTX, parseNumberedLines, runTranslationJob, cancelTabJobs, runSummaryJob })', ctx);
  return { ...api, store, sent };
}

const openaiReply = (content) => ({
  ok: true, status: 200, headers: { get: () => null },
  json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] })
});

const userLines = (init) => JSON.parse(init.body).messages[1].content.split('\n').slice(1);

test('parser: 확장과 서버 사본이 같은 결과를 낸다', () => {
  const ext = loadExtension({ settings: {}, fetchImpl: async () => { throw new Error('unused'); } });
  const cases = [
    ['1|가\n2|나|다\n3|라', 3, [[1, '가'], [2, '나|다'], [3, '라']]],
    ['```\n1|가\n3|라\n```', 3, [[1, '가'], [3, '라']]],
    ['1|가\n2|나\n2|나2\n9|범위밖\n3|', 3, [[1, '가']]],
    ['가\n나', 2, []],
    ['1. 가', 1, []],
    ['죄송합니다', 2, []],
    ['', 1, []]
  ];
  for (const [text, count, expected] of cases) {
    assert.equal(JSON.stringify([...ext.parseNumberedLines(text, count)]), JSON.stringify(expected), text);
    assert.deepEqual([...server.parseNumberedLines(text, count)], expected, text);
  }
});

test('설정 정규화: 목록에 없는 모델은 기본값으로', () => {
  const { YTX } = loadExtension({ settings: {}, fetchImpl: async () => { throw new Error('unused'); } });
  const s = YTX.normalizeSettings({ geminiModel: 'no-such-model', openaiModel: 'no-such-model', summaryClaudeModel: 'x' });
  assert.equal(s.geminiModel, YTX.GEMINI.DEFAULT_MODEL);
  assert.equal(s.openaiModel, YTX.OPENAI.DEFAULT_MODEL);
  assert.equal(s.summaryClaudeModel, 'auto');
  assert.equal(YTX.normalizeSettings({ openaiModel: 'gpt-6.1-sol' }).openaiModel, 'gpt-6.1-sol');
});

test('작업: 중복 원문 1회 전송 · 누락 줄만 재시도 · 캐시 저장', async () => {
  const requests = [];
  const ext = loadExtension({
    settings: { route: 'openai', openaiApiKey: 'k', targetLang: 'ko' },
    fetchImpl: async (url, init) => {
      const lines = userLines(init);
      requests.push(lines);
      if (requests.length === 1) return openaiReply('1|안녕\n3|고마워');
      return openaiReply(lines.map((l) => `${l.split('|')[0]}|맞아`).join('\n'));
    }
  });
  const caption = {
    video_id: 'v1', source_lang: 'en',
    segments: [
      { id: 0, text: 'Hello' }, { id: 1, text: 'Right.' }, { id: 2, text: 'Thanks\na lot' },
      { id: 3, text: 'Right.' }, { id: 4, text: 'Hello' }
    ]
  };
  await ext.runTranslationJob(7, caption, '제목');

  assert.deepEqual(requests, [['1|Hello', '2|Right.', '3|Thanks a lot'], ['1|Right.']]);
  const key = ext.YTX.cacheKey('v1', 'ko', 'openai', 'gpt-6-luna');
  assert.deepEqual(ext.store[key].map, { 0: '안녕', 1: '맞아', 2: '고마워', 3: '맞아', 4: '안녕' });
  assert.equal(ext.store[key].complete, true);
  const done = ext.sent.find((m) => m.type === 'TRANS_COMPLETE');
  assert.equal(Object.keys(done.translations).length, 5);
  assert.equal(done.failedChunks.length, 0);
});

test('작업: 형식을 어긴 재시도 응답은 캐시에 넣지 않고 누락으로 보고한다', async () => {
  let calls = 0;
  const ext = loadExtension({
    settings: { route: 'openai', openaiApiKey: 'k', targetLang: 'ko' },
    fetchImpl: async () => openaiReply(++calls === 1 ? '1|가' : 'I merged line 2 into line 1.')
  });
  const caption = { video_id: 'v3', source_lang: 'en', segments: [{ id: 0, text: 'a' }, { id: 1, text: 'b' }] };
  await ext.runTranslationJob(1, caption, '');

  const entry = ext.store[ext.YTX.cacheKey('v3', 'ko', 'openai', 'gpt-6-luna')];
  assert.deepEqual(entry.map, { 0: '가' });
  assert.equal(entry.complete, false);
  const done = ext.sent.find((m) => m.type === 'TRANS_COMPLETE');
  assert.equal(done.failedChunks[0].code, 'MISSING');
});

test('작업: 출력 한도 이분할에서 성공한 절반은 살린다', async () => {
  const ext = loadExtension({
    settings: { route: 'openai', openaiApiKey: 'k', targetLang: 'ko' },
    fetchImpl: async (url, init) => {
      const lines = userLines(init);
      if (lines.length > 1 || lines[0].endsWith('bad')) {
        return { ok: true, status: 200, headers: { get: () => null },
          json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }) };
      }
      return openaiReply('1|좋음');
    }
  });
  const caption = { video_id: 'v4', source_lang: 'en', segments: [{ id: 0, text: 'good' }, { id: 1, text: 'bad' }] };
  await ext.runTranslationJob(1, caption, '');

  const entry = ext.store[ext.YTX.cacheKey('v4', 'ko', 'openai', 'gpt-6-luna')];
  assert.deepEqual(entry.map, { 0: '좋음' });
});

test('작업: 취소되면 요청을 중단하고 완료분은 캐시에 남는다', async () => {
  let calls = 0;
  let aborted = false;
  const ext = loadExtension({
    settings: { route: 'localhost', targetLang: 'ko' },
    fetchImpl: (url, init) => {
      calls++;
      const segs = JSON.parse(init.body).segments;
      if (calls === 1) {
        return Promise.resolve({
          ok: true, status: 200, headers: { get: () => null },
          json: async () => ({ segments: segs.map((s) => ({ id: s.id, text: `번역${s.id}` })) })
        });
      }
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
        if (calls === 2) setTimeout(() => ext.cancelTabJobs(9), 10);
      });
    }
  });
  const segments = Array.from({ length: 50 }, (_, i) => ({ id: i, text: `line ${i}` }));
  await ext.runTranslationJob(9, { video_id: 'v2', source_lang: 'en', segments }, '');

  assert.equal(aborted, true);
  const entry = ext.store[ext.YTX.cacheKey('v2', 'ko', 'localhost', 'cli')];
  assert.equal(Object.keys(entry.map).length, 20);
  assert.equal(entry.complete, false);
  assert.equal(ext.sent.some((m) => m.type === 'TRANS_COMPLETE'), false);
});

test('요약: Gemini 자막 기반은 영상 대신 자막을 보내고 대상 언어를 명시한다', async () => {
  const bodies = [];
  const summary = { tldr: ['요점'], sections: [{ start: 0, title: '도입', summary: '내용' }] };
  const ext = loadExtension({
    settings: { route: 'gemini', geminiApiKey: 'k', geminiTier: 'paid', geminiSummarySource: 'transcript', targetLang: 'ko' },
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(summary) }] } }] }) };
    }
  });
  await ext.runSummaryJob(1, {
    videoId: 'v5', title: 't', level: 'standard',
    segments: [{ id: 0, start: 0, end: 2, text: 'Hello there' }]
  });

  assert.equal(bodies.length, 1);
  const body = bodies[0];
  assert.equal(JSON.stringify(body).includes('fileData'), false);
  assert.match(body.contents[0].parts[0].text, /\[0:00\] Hello there/);
  assert.match(body.systemInstruction.parts[0].text, /Write every string value in Korean \(ko\)/);
  assert.ok(ext.store[ext.YTX.sumKey('v5', 'ko', 'gemini', 'gemini-3.8-flash/자막', 'standard')]);
  assert.equal(ext.sent.find((m) => m.type === 'SUMMARY_COMPLETE').data.tldr[0], '요점');
});
