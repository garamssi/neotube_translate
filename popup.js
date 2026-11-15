'use strict';

const app = document.getElementById('app');
const body = document.getElementById('body');
const enabledBtn = document.getElementById('enabled');
const enabledLabel = document.getElementById('enabled-label');

let settings = { ...YTX.DEFAULT_SETTINGS };
let view = 'settings';
let ownWrites = 0;
let debugTimer = null;
let cacheQuery = '';
let cacheTypeFilter = 'all';

const $ = (name) => body.querySelector(`[data-ytx="${name}"]`);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function save(patch) {
  if (Object.keys(patch).every((k) => settings[k] === patch[k])) return;
  settings = { ...settings, ...patch };
  ownWrites++;
  try {
    await chrome.storage.local.set({ [YTX.STORAGE.SETTINGS]: settings });
  } catch (e) {
    ownWrites--;
    console.warn(YTX.LOG, '설정 저장 실패', e);
  }
}

function renderEnabled() {
  enabledBtn.classList.toggle('ytx-on', settings.enabled);
  enabledBtn.setAttribute('aria-checked', String(!!settings.enabled));
  enabledLabel.textContent = settings.enabled ? '사용 중' : '꺼짐';
}

function render() {
  if (debugTimer) { clearInterval(debugTimer); debugTimer = null; }
  renderEnabled();
  if (view === 'cache') renderCacheView();
  else if (view === 'debug') renderDebugView();
  else renderSettings();
}

function show(next) {
  view = next;
  body.scrollTop = 0;
  render();
}

function helpIconHtml(text) {
  return `<span class="ytx-help-wrap"><button type="button" class="ytx-help" title="도움말">?</button><span class="ytx-help-tip">${escapeHtml(text).replace(/\n/g, '<br>')}</span></span>`;
}

const options = (list, current) => list
  .map(([value, label]) => `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`)
  .join('');

function renderSettings() {
  const d = settings;
  const isLocal = d.route === 'localhost';
  const isOpenai = d.route === 'openai';
  const models = (list) => list.map((m) => [m.value, m.label]);

  body.innerHTML = `
    <div class="ytx-settings">
      <div class="ytx-field">
        <div class="ytx-field-label">번역 경로</div>
        <div class="ytx-route-group">
          <button class="ytx-route-btn${isLocal ? ' ytx-on' : ''}" data-ytx="route-local">Claude CLI</button>
          <button class="ytx-route-btn${!isLocal && !isOpenai ? ' ytx-on' : ''}" data-ytx="route-gemini">Gemini API</button>
          <button class="ytx-route-btn${isOpenai ? ' ytx-on' : ''}" data-ytx="route-openai">OpenAI API</button>
        </div>
      </div>

      ${isOpenai ? `
      <div class="ytx-field">
        <div class="ytx-field-label">OpenAI API 키 ${helpIconHtml('키는 이 브라우저의 chrome.storage에만 저장되며\n외부로 전송되지 않습니다.\nOpenAI API는 무료 티어가 없어 결제 등록된 키가 필요합니다.')}</div>
        <input type="password" class="ytx-input" placeholder="sk-…" data-ytx="set-oakey" value="${escapeHtml(d.openaiApiKey)}">
      </div>
      <div class="ytx-field">
        <div class="ytx-field-label">OpenAI 모델</div>
        <select class="ytx-select" data-ytx="set-oamodel">${options(models(YTX.OPENAI.MODELS), d.openaiModel)}</select>
      </div>` : isLocal ? `
      <div class="ytx-field">
        <div class="ytx-field-label">서버 주소 ${helpIconHtml('로컬에서 실행 중인 Claude CLI 브리지 서버 주소.\nlocalhost:8787 또는 192.168.0.10:8787 같은\nhost:port 형식을 입력하세요.')}</div>
        <input type="text" class="ytx-input ytx-mono" data-ytx="set-addr" value="${escapeHtml(d.serverAddress)}" placeholder="localhost:8787" spellcheck="false">
        <div class="ytx-field-hint ytx-mono" data-ytx="addr-hint">POST ${escapeHtml(YTX.buildServerBase(d.serverAddress))}/translate</div>
      </div>` : `
      <div class="ytx-field">
        <div class="ytx-field-label">Gemini API 키 ${helpIconHtml('키는 이 브라우저의 chrome.storage에만 저장되며\n외부로 전송되지 않습니다.')}</div>
        <input type="password" class="ytx-input" placeholder="AIza…" data-ytx="set-key" value="${escapeHtml(d.geminiApiKey)}">
      </div>
      <div class="ytx-field">
        <div class="ytx-field-label">Gemini 모델</div>
        <select class="ytx-select" data-ytx="set-model">${options(models(YTX.GEMINI.MODELS), d.geminiModel)}</select>
      </div>
      <div class="ytx-field">
        <div class="ytx-field-label">요금제 티어 ${helpIconHtml('무료 티어는 분당/일일 요청 한도가 매우 낮아\n호출 간격을 자동으로 띄웁니다(429 예방).\n결제 계정 연결(Tier 1+) 시 유료를 선택하면 빨라집니다.')}</div>
        <select class="ytx-select" data-ytx="set-tier">${options([['free', '무료 (호출 간격 자동 조절)'], ['paid', '유료 Tier 1+ (빠름)']], d.geminiTier === 'paid' ? 'paid' : 'free')}</select>
      </div>
      <div class="ytx-field">
        <div class="ytx-field-label">요약 방식 ${helpIconHtml('영상 분석: Gemini가 영상 전체를 직접 봅니다. 화면에만 나오는 내용도 반영되지만 느립니다.\n자막 기반: 자막 텍스트만 보냅니다. 빠르지만 자막에 없는 내용은 빠집니다.\n소요 시간은 디버그 로그의 "요약 완료" 줄에 기록됩니다.')}</div>
        <select class="ytx-select" data-ytx="set-sumsrc">${options([['video', '영상 분석 (화면 내용 포함)'], ['transcript', '자막 기반 (빠름)']], d.geminiSummarySource === 'transcript' ? 'transcript' : 'video')}</select>
      </div>`}

      <div class="ytx-field">
        <div class="ytx-field-label">대상 언어</div>
        <select class="ytx-select" data-ytx="set-lang">${options(YTX.TARGET_LANGS, d.targetLang)}</select>
      </div>

      <div class="ytx-field">
        <div class="ytx-field-label">번역 시작</div>
        <div class="ytx-field-row">
          <div class="ytx-field-row-label">영상 열면 자동 번역</div>
          <button class="ytx-toggle${d.autoTranslate ? ' ytx-on' : ''}" data-ytx="set-autotrans" role="switch" aria-checked="${!!d.autoTranslate}" aria-label="영상 열면 자동 번역"><div class="ytx-toggle-knob"></div></button>
        </div>
        <div class="ytx-field-hint">끄면 자막만 취득해 두고, 패널의 "이 영상 번역하기" 버튼을 눌렀을 때만 번역합니다.</div>
      </div>

      <div class="ytx-field">
        <div class="ytx-field-label">기본 표시 <span class="ytx-label-note">(페이지를 새로 열 때 적용)</span></div>
        <div class="ytx-field-row">
          <div class="ytx-field-row-label">표시 모드 기본값</div>
          <select class="ytx-select ytx-select-sm" data-ytx="set-defmode">${options([['rows', '타임라인 목록'], ['para', '연속 문단']], d.defMode)}</select>
        </div>
        <div class="ytx-field-row">
          <div class="ytx-field-row-label">자동 스크롤 기본 켜기</div>
          <button class="ytx-toggle${d.defFollow ? ' ytx-on' : ''}" data-ytx="set-deffollow" role="switch" aria-checked="${!!d.defFollow}" aria-label="자동 스크롤 기본 켜기"><div class="ytx-toggle-knob"></div></button>
        </div>
      </div>

      <div class="ytx-field">
        <div class="ytx-field-label">영상 자막 오버레이</div>
        <div class="ytx-field-row">
          <div class="ytx-field-row-label">영상에 번역 자막 표시</div>
          <button class="ytx-toggle${d.overlayOn ? ' ytx-on' : ''}" data-ytx="set-overlayon" role="switch" aria-checked="${!!d.overlayOn}" aria-label="영상에 번역 자막 표시"><div class="ytx-toggle-knob"></div></button>
        </div>
        ${d.overlayOn ? `
        <div class="ytx-field-row">
          <div class="ytx-field-row-label">표시 방식</div>
          <select class="ytx-select ytx-select-sm" data-ytx="set-overlaymode">${options([['replace', '교체 (번역만)'], ['dual', '원문 병기']], d.overlayMode)}</select>
        </div>
        <div class="ytx-field-row">
          <div class="ytx-field-row-label">폰트 크기</div>
          <select class="ytx-select ytx-select-sm" data-ytx="set-overlayfont">${options([['sm', '소'], ['md', '중'], ['lg', '대']], d.overlayFontSize)}</select>
        </div>` : ''}
      </div>

      <div class="ytx-field">
        <div class="ytx-field-label">번역·요약 캐시 <span class="ytx-label-note">(재방문 시 즉시 표시용)</span></div>
        <div class="ytx-field-row">
          <div class="ytx-field-row-label" style="color: var(--ytx-text2);" data-ytx="cache-summary">불러오는 중…</div>
          <button class="ytx-outline-btn" data-ytx="cache-open">캐시 관리</button>
        </div>
      </div>

      <div class="ytx-field ytx-field-divide">
        <div class="ytx-field-label">문제 해결</div>
        <div class="ytx-field-row">
          <div class="ytx-field-row-label">요청·오류 이벤트 기록<div class="ytx-field-row-sub">이 브라우저에만 저장</div></div>
          <button class="ytx-outline-btn" data-ytx="debug-open">디버그 로그</button>
        </div>
      </div>
    </div>`;

  bindSettingsEvents();
  fillCacheSummary();
}

function bindSettingsEvents() {
  const on = (name, type, handler) => $(name)?.addEventListener(type, handler);
  const saveValue = (name, key, type = 'change') =>
    on(name, type, (e) => save({ [key]: e.target.value.trim() }));
  const saveToggle = (name, key, rerender) => on(name, 'click', async (e) => {
    const next = !settings[key];
    e.currentTarget.classList.toggle('ytx-on', next);
    e.currentTarget.setAttribute('aria-checked', String(next));
    await save({ [key]: next });
    if (rerender) renderSettings();
  });
  const saveRoute = (name, route) => on(name, 'click', async () => {
    await save({ route });
    renderSettings();
  });

  saveRoute('route-local', 'localhost');
  saveRoute('route-gemini', 'gemini');
  saveRoute('route-openai', 'openai');

  on('set-addr', 'input', (e) => {
    const addr = e.target.value.trim().replace(/[^\w.:\-/]/g, '') || YTX.DEFAULT_SETTINGS.serverAddress;
    $('addr-hint').textContent = `POST ${YTX.buildServerBase(addr)}/translate`;
    save({ serverAddress: addr });
  });
  saveValue('set-key', 'geminiApiKey', 'input');
  saveValue('set-oakey', 'openaiApiKey', 'input');
  saveValue('set-model', 'geminiModel');
  saveValue('set-tier', 'geminiTier');
  saveValue('set-sumsrc', 'geminiSummarySource');
  saveValue('set-oamodel', 'openaiModel');
  saveValue('set-lang', 'targetLang');
  saveValue('set-defmode', 'defMode');
  saveValue('set-overlaymode', 'overlayMode');
  saveValue('set-overlayfont', 'overlayFontSize');

  saveToggle('set-autotrans', 'autoTranslate');
  saveToggle('set-deffollow', 'defFollow');
  saveToggle('set-overlayon', 'overlayOn', true);

  on('cache-open', 'click', () => show('cache'));
  on('debug-open', 'click', () => show('debug'));

  body.querySelectorAll('.ytx-help').forEach((btn) => {
    btn.addEventListener('click', () => btn.parentElement.classList.toggle('ytx-open'));
  });
}

async function fillCacheSummary() {
  const entries = await loadCacheEntries();
  const el = $('cache-summary');
  if (!el) return;
  const bytes = entries.reduce((sum, e) => sum + e.size, 0);
  el.textContent = entries.length
    ? `${entries.length}개 저장됨 · ${fmtBytes(bytes)}`
    : '저장된 캐시 없음';
}

function fmtCacheDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtBytes(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

function levelLabel(v) {
  return (YTX.SUMMARY_LEVELS.find((l) => l.value === v) || {}).label || v;
}

async function loadCacheEntries() {
  let all = {};
  try {
    all = await chrome.storage.local.get(null);
  } catch (e) {
    console.warn(YTX.LOG, '캐시 조회 실패', e);
  }

  return Object.entries(all)
    .filter(([k]) => k.startsWith(YTX.STORAGE.CACHE_PREFIX + '|') || k.startsWith(YTX.STORAGE.SUM_PREFIX + '|'))
    .map(([key, v]) => {
      const parts = key.split('|');
      const isSum = parts[0] === YTX.STORAGE.SUM_PREFIX;
      return {
        key, isSum,
        size: JSON.stringify(v).length,
        lang: parts[2], route: parts[3],
        model: parts[4] || '',
        level: isSum ? (parts[5] || parts[4]) : '',
        title: v.title || parts[1],
        complete: isSum ? true : !!v.complete,
        cachedAt: v.cached_at || 0,
        count: isSum ? 0 : Object.keys(v.map || {}).length
      };
    })
    .sort((a, b) => b.cachedAt - a.cachedAt);
}

function renderCacheView() {
  body.innerHTML = `
    <div class="ytx-progress">
      <div class="ytx-progress-row">
        <button class="ytx-icon-btn" data-ytx="cache-back" title="설정으로 돌아가기" aria-label="설정으로 돌아가기">←</button>
        <div class="ytx-progress-label" style="font-weight:700;">캐시 관리</div>
        <div class="ytx-progress-route" data-ytx="cache-stats"></div>
        <button class="ytx-ghost-btn ytx-cta-btn" data-ytx="cache-clear">전체 삭제</button>
      </div>
      <div class="ytx-progress-row" style="margin-top:8px;">
        <input type="text" class="ytx-input ytx-cache-search" placeholder="제목 검색…" data-ytx="cache-search" value="${escapeHtml(cacheQuery)}" spellcheck="false">
        <button class="ytx-chip-btn${cacheTypeFilter === 'all' ? ' ytx-on' : ''}" data-ytx="cf-all">전체</button>
        <button class="ytx-chip-btn${cacheTypeFilter === 'trans' ? ' ytx-on' : ''}" data-ytx="cf-trans">번역</button>
        <button class="ytx-chip-btn${cacheTypeFilter === 'sum' ? ' ytx-on' : ''}" data-ytx="cf-sum">요약</button>
      </div>
    </div>
    <div class="ytx-cache-items" data-ytx="cache-items">
      <div class="ytx-empty"><div class="ytx-empty-desc">불러오는 중…</div></div>
    </div>`;

  let entries = [];

  const removeKeys = async (keys) => {
    try {
      await chrome.storage.local.remove(keys);
    } catch (e) {
      console.warn(YTX.LOG, '캐시 삭제 실패', e);
      return;
    }
    entries = entries.filter((e) => !keys.includes(e.key));
    refreshList();
  };

  const refreshList = () => {
    const itemsEl = $('cache-items');
    if (!itemsEl) return;

    const q = cacheQuery.trim().toLowerCase();
    const filtered = entries.filter((e) => {
      if (cacheTypeFilter === 'trans' && e.isSum) return false;
      if (cacheTypeFilter === 'sum' && !e.isSum) return false;
      return !q || e.title.toLowerCase().includes(q);
    });

    const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
    $('cache-stats').textContent = `${filtered.length}/${entries.length}개 · ${fmtBytes(totalBytes)}`;

    if (filtered.length === 0) {
      itemsEl.innerHTML = '<div class="ytx-empty"><div class="ytx-empty-desc">' +
        (entries.length === 0 ? '저장된 캐시가 없습니다.' : '검색/필터 결과가 없습니다.') + '</div></div>';
      return;
    }

    itemsEl.innerHTML = filtered.map((e) => {
      const kind = e.isSum
        ? `요약(${escapeHtml(levelLabel(e.level))}${e.model && e.model !== e.level ? '·' + escapeHtml(e.model) : ''})`
        : `번역 ${e.count}개${e.complete ? '' : ' · 부분'}`;
      const routeName = e.route === 'gemini' ? 'Gemini' : e.route === 'openai' ? 'OpenAI' : 'Claude';
      const engine = routeName + (!e.isSum && e.model && e.model !== 'cli' ? `·${escapeHtml(e.model)}` : '');
      return `
      <div class="ytx-cache-item">
        <div class="ytx-cache-info">
          <div class="ytx-cache-title" title="${escapeHtml(e.title)}">${escapeHtml(e.title)}</div>
          <div class="ytx-cache-meta">${kind} · → ${escapeHtml((e.lang || '?').toUpperCase())} · ${engine} · ${fmtBytes(e.size)} · ${fmtCacheDate(e.cachedAt)}</div>
        </div>
        <button class="ytx-icon-btn ytx-cache-del" data-key="${escapeHtml(e.key)}" title="이 캐시 삭제" aria-label="이 캐시 삭제">✕</button>
      </div>`;
    }).join('');

    itemsEl.querySelectorAll('.ytx-cache-del').forEach((btn) => {
      btn.addEventListener('click', () => removeKeys([btn.dataset.key]));
    });
  };

  const setFilter = (type) => {
    cacheTypeFilter = type;
    for (const t of ['all', 'trans', 'sum']) $(`cf-${t}`).classList.toggle('ytx-on', t === type);
    refreshList();
  };

  $('cache-back').addEventListener('click', () => show('settings'));
  $('cache-search').addEventListener('input', (e) => {
    cacheQuery = e.target.value;
    refreshList();
  });
  $('cf-all').addEventListener('click', () => setFilter('all'));
  $('cf-trans').addEventListener('click', () => setFilter('trans'));
  $('cf-sum').addEventListener('click', () => setFilter('sum'));
  $('cache-clear').addEventListener('click', () => removeKeys(entries.map((e) => e.key)));

  loadCacheEntries().then((list) => {
    entries = list;
    refreshList();
  });
}

function fmtDebugTime(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function debugStatsText(s) {
  return `요청 ${s.attempts || 0} · 성공 ${s.ok || 0} · 실패 ${s.failed || 0} · 재시도 ${s.retries || 0} · 429 ${s.rateLimited || 0}`;
}

function debugLogAsText(data) {
  const s = data.stats || {};
  return [
    '=== YouTube AI Subtitle Translator 디버그 로그 ===',
    `내보낸 시각: ${new Date().toLocaleString()}`,
    `통계: ${debugStatsText(s)}`,
    s.lastError ? `마지막 오류: ${s.lastError}` : '마지막 오류: (없음)',
    '--- 이벤트 (오래된 → 최신) ---',
    ...(data.entries || []).map((e) => `[${fmtDebugTime(e.t)}]${e.lvl === 'warn' ? ' [경고]' : ''} ${e.msg}`)
  ].join('\n');
}

function renderDebugView() {
  body.innerHTML = `
    <div class="ytx-dbg-head">
      <div class="ytx-dbg-head-row">
        <button class="ytx-icon-btn" data-ytx="dbg-back" title="설정으로 돌아가기" aria-label="설정으로 돌아가기">
          <svg width="20" height="20" viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"></path></svg>
        </button>
        <div class="ytx-dbg-title">디버그 로그</div>
        <div class="ytx-header-spacer"></div>
        <div class="ytx-dbg-actions">
          <button class="ytx-outline-btn ytx-outline-sm" data-ytx="dbg-copy">로그 복사</button>
          <button class="ytx-outline-btn ytx-outline-sm" data-ytx="dbg-clear">지우기</button>
        </div>
      </div>
      <div class="ytx-dbg-stats" data-ytx="dbg-stats">${debugStatsText({})}</div>
      <div class="ytx-dbg-lasterr" data-ytx="dbg-lasterr" hidden></div>
    </div>
    <div class="ytx-dbg-items" data-ytx="dbg-items">
      <div class="ytx-empty"><div class="ytx-empty-desc">불러오는 중…</div></div>
    </div>`;

  let latest = { entries: [], stats: {} };
  let lastRenderedKey = '';

  const fetchAndRender = async () => {
    let resp = null;
    try {
      resp = await chrome.runtime.sendMessage({ type: YTX.MSG.DEBUG_GET });
    } catch (e) {
      return;
    }
    const itemsEl = $('dbg-items');
    if (!itemsEl || !resp || !resp.ok) return;
    latest = resp.data || latest;

    const s = latest.stats || {};
    $('dbg-stats').textContent = debugStatsText(s);
    const errEl = $('dbg-lasterr');
    errEl.hidden = !s.lastError;
    if (s.lastError) errEl.textContent = `마지막 오류: ${s.lastError}`;

    const entries = latest.entries || [];
    const key = `${entries.length}|${entries.length ? entries[entries.length - 1].t : 0}`;
    if (key === lastRenderedKey) return;
    lastRenderedKey = key;

    if (entries.length === 0) {
      itemsEl.innerHTML = '<div class="ytx-empty"><div class="ytx-empty-desc">기록된 이벤트가 없습니다.<br>번역이나 요약을 실행하면 여기에 쌓입니다.</div></div>';
      return;
    }
    itemsEl.innerHTML = entries.slice().reverse().map((e) => `
      <div class="ytx-dbg-line${e.lvl === 'warn' ? ' ytx-dbg-warn' : ''}">
        <div class="ytx-dbg-time">${fmtDebugTime(e.t)}</div>
        <div class="ytx-dbg-msg">${escapeHtml(e.msg)}</div>
      </div>`).join('');
  };

  $('dbg-back').addEventListener('click', () => show('settings'));

  $('dbg-copy').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    let ok = true;
    try {
      await navigator.clipboard.writeText(debugLogAsText(latest));
    } catch (err) {
      ok = false;
    }
    btn.textContent = ok ? '복사됨 ✓' : '복사 실패';
    setTimeout(() => { btn.textContent = '로그 복사'; }, 1500);
  });

  $('dbg-clear').addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ type: YTX.MSG.DEBUG_CLEAR });
    } catch (e) {
      console.warn(YTX.LOG, '로그 지우기 실패', e);
    }
    lastRenderedKey = '';
    fetchAndRender();
  });

  debugTimer = setInterval(fetchAndRender, 1500);
  fetchAndRender();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[YTX.STORAGE.SETTINGS]) return;
  if (ownWrites > 0) {
    ownWrites--;
    return;
  }
  settings = YTX.normalizeSettings(changes[YTX.STORAGE.SETTINGS].newValue);
  renderEnabled();
  if (view === 'settings' && !body.contains(document.activeElement)) renderSettings();
});

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => { app.dataset.ytxTheme = darkQuery.matches ? 'dark' : 'light'; };
darkQuery.addEventListener('change', applyTheme);
applyTheme();

chrome.storage.local.get(YTX.STORAGE.SETTINGS).then((stored) => {
  settings = YTX.normalizeSettings(stored[YTX.STORAGE.SETTINGS]);
  enabledBtn.addEventListener('click', async () => {
    await save({ enabled: !settings.enabled });
    renderEnabled();
  });
  render();
});
