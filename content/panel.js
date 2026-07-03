/**
 * content/panel.js — 스크립트 패널 뷰 (설계서 §5 + 목업 사양)
 *
 * 책임: 패널 DOM 생성, 상태 → 화면 렌더링(상태 5종), 인라인 설정 화면.
 * 재생 동기화(seekTo/scrollToActive)와 오버레이(syncOverlay 등)는
 * 이후 파일에서 정의되며 런타임에 호출된다.
 */
'use strict';

const PANEL_ID = 'ytx-script-panel';
let panelEl = null;

const ICON_PANEL = `<svg width="20" height="20" viewBox="0 0 24 24" class="ytx-header-icon"><rect x="3" y="5" width="18" height="14" rx="3"></rect><path d="M7 13h6"></path><path d="M16.5 13H17"></path><path d="M7 16h2.5"></path><path d="M12.5 16H17"></path></svg>`;
const ICON_GEAR = `<svg width="16" height="16" viewBox="0 0 24 24"><path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"></path></svg>`;
const ICON_CHEVRON = `<svg width="16" height="16" viewBox="0 0 24 24" class="ytx-chevron"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z" fill="currentColor"></path></svg>`;

/* ═══════════════════════════════════════════════════════════
 * 패널 DOM 생성 (M2)
 * ═══════════════════════════════════════════════════════════ */
function buildPanel() {
  const el = document.createElement('div');
  el.id = PANEL_ID;
  el.className = 'ytx-panel';
  el.dataset.ytxTheme = isDarkTheme() ? 'dark' : 'light';
  el.innerHTML = `
    <div class="ytx-header">
      ${ICON_PANEL}
      <div class="ytx-title">AI 번역 스크립트</div>
      <div class="ytx-lang-chip" data-ytx="lang-chip">EN → KO</div>
      <div class="ytx-header-spacer"></div>
      <button class="ytx-icon-btn" data-ytx="gear" title="설정">${ICON_GEAR}</button>
      <button class="ytx-icon-btn" data-ytx="collapse" title="접기/펼치기">${ICON_CHEVRON}</button>
    </div>
    <div class="ytx-toolbar">
      <button class="ytx-chip-btn ytx-chip-cta" data-ytx="translate-now" title="이 영상 번역 시작" hidden>번역</button>
      <div class="ytx-seg-group">
        <button class="ytx-seg-btn" data-ytx="mode-rows">목록</button>
        <button class="ytx-seg-btn" data-ytx="mode-para">문단</button>
        <button class="ytx-seg-btn" data-ytx="mode-summary">요약</button>
      </div>
      <button class="ytx-chip-btn" data-ytx="bilingual">원문 병기</button>
      <button class="ytx-chip-btn" data-ytx="follow">자동 스크롤</button>
      <button class="ytx-chip-btn" data-ytx="overlay" title="영상에 번역 자막 표시">영상 자막</button>
    </div>
    <div class="ytx-body" data-ytx="body"></div>
    <button class="ytx-resume-btn" data-ytx="resume" hidden>현재 위치로</button>
    <div class="ytx-footer">
      <div class="ytx-status-dot" data-ytx="status-dot"></div>
      <div data-ytx="status-text">대기 중</div>
    </div>
  `;
  bindPanelEvents(el);
  return el;
}

function bindPanelEvents(el) {
  el.querySelector('[data-ytx="collapse"]').addEventListener('click', () => {
    state.collapsed = !state.collapsed;
    renderPanelState();
  });
  el.querySelector('[data-ytx="gear"]').addEventListener('click', () => toggleSettings());
  el.querySelector('[data-ytx="mode-rows"]').addEventListener('click', () => {
    state.mode = 'rows';
    renderPanelState();
    scrollToActive(true);
  });
  el.querySelector('[data-ytx="mode-para"]').addEventListener('click', () => {
    state.mode = 'para';
    renderPanelState();
    scrollToActive(true);
  });
  el.querySelector('[data-ytx="mode-summary"]').addEventListener('click', () => {
    state.mode = 'summary';
    // 이 수준의 요약이 이미 있으면 done, 없으면 버튼 대기
    state.summaryPhase = state.summaryByLevel[state.summaryLevel]
      ? 'done' : (state.summaryPhase === 'loading' ? 'loading' : 'idle');
    renderPanelState();
  });
  el.querySelector('[data-ytx="bilingual"]').addEventListener('click', () => {
    state.bilingual = !state.bilingual;
    renderPanelState();
  });
  el.querySelector('[data-ytx="follow"]').addEventListener('click', () => {
    state.follow = !state.follow;
    state.followSuspended = false;
    renderPanelState();
    if (state.follow) scrollToActive(true);
  });
  el.querySelector('[data-ytx="overlay"]').addEventListener('click', () => {
    state.overlayOn = !state.overlayOn;
    saveSettings({ overlayOn: state.overlayOn }); // §6.6 상태 저장
    syncOverlay();
    renderPanelState();
  });
  el.querySelector('[data-ytx="translate-now"]').addEventListener('click', () => {
    requestTranslation();
    renderPanelState();
  });
  el.querySelector('[data-ytx="resume"]').addEventListener('click', () => {
    state.followSuspended = false;
    updateResumeButton();
    scrollToActive(true);
  });

  // 수동 스크롤 감지 → 자동 스크롤 일시 해제 (설계서 §5)
  // wheel/터치만 감지해 프로그램적 scrollTo와 구분한다.
  const body = el.querySelector('[data-ytx="body"]');
  const suspendFollow = () => {
    if (!state.follow || state.followSuspended) return;
    state.followSuspended = true;
    updateResumeButton();
  };
  body.addEventListener('wheel', suspendFollow, { passive: true });
  body.addEventListener('touchmove', suspendFollow, { passive: true });
}

/* ═══════════════════════════════════════════════════════════
 * 상태 → 화면 렌더링
 * ═══════════════════════════════════════════════════════════ */
function renderPanelState() {
  if (!panelEl) return;

  panelEl.classList.toggle('ytx-collapsed', state.collapsed);
  panelEl.classList.toggle('ytx-settings-open', state.settingsOpen || state.cacheOpen); // 툴바/푸터 숨김 공용
  panelEl.querySelector('[data-ytx="gear"]').classList.toggle('ytx-on', state.settingsOpen || state.cacheOpen);
  panelEl.querySelector('[data-ytx="mode-rows"]').classList.toggle('ytx-on', state.mode === 'rows');
  panelEl.querySelector('[data-ytx="mode-para"]').classList.toggle('ytx-on', state.mode === 'para');
  panelEl.querySelector('[data-ytx="mode-summary"]').classList.toggle('ytx-on', state.mode === 'summary');

  const biBtn = panelEl.querySelector('[data-ytx="bilingual"]');
  biBtn.classList.toggle('ytx-on', state.bilingual && state.mode === 'rows');
  biBtn.disabled = state.mode !== 'rows'; // 목록 모드에서만 의미 있음

  const followBtn = panelEl.querySelector('[data-ytx="follow"]');
  followBtn.classList.toggle('ytx-on', state.follow);
  followBtn.disabled = state.mode === 'summary'; // 요약 뷰는 스크롤 추종 없음

  panelEl.querySelector('[data-ytx="overlay"]').classList.toggle('ytx-on', state.overlayOn);
  // 수동 모드: 번역 대기 상태 + 스크립트 탭에서만 툴바 '번역' 버튼 노출
  // (요약 탭에서는 CTA가 '이 영상 요약하기'로 교체됨)
  panelEl.querySelector('[data-ytx="translate-now"]').hidden =
    state.transPhase !== 'ready' || state.mode === 'summary';

  renderBody();
  renderFooter();
  updateResumeButton();

  if (state.caption) {
    const lang = (state.caption.source_lang || '??').toUpperCase();
    panelEl.querySelector('[data-ytx="lang-chip"]').textContent =
      `${lang} → ${state.targetLang.toUpperCase()}`;
  }
}

/**
 * 본문 렌더 — 상태 5종 (설계서 §5, §7)
 * ⓐ 취득중  ⓑ 번역중(점진)  ⓒ 완료  ⓓ 오류  ⓔ 자막없음
 */
function renderBody() {
  const body = panelEl.querySelector('[data-ytx="body"]');

  if (state.cacheOpen) {
    renderCacheView(body); // 캐시 관리 전용 뷰 (설정에서 진입)
    return;
  }
  if (state.settingsOpen) {
    renderSettings(body);
    return;
  }
  if (!state.caption && state.noCaption) {
    renderNoCaptionView(body);
    return;
  }
  if (!state.caption) {
    renderFetchingView(body);
    return;
  }
  if (state.mode === 'summary') {
    renderSummaryView(body); // 요약 탭 — 번역 상태와 무관
    return;
  }
  if (state.transPhase === 'error' && Object.keys(state.translations).length === 0) {
    renderErrorView(body);
    return;
  }
  renderScriptView(body);
}

/* ── ⓔ 자막 없음 ── */
function renderNoCaptionView(body) {
  body.innerHTML = `
    <div class="ytx-empty">
      <div class="ytx-empty-title">이 영상에는 자막이 없습니다</div>
      <div class="ytx-empty-desc">자막(CC)이 제공되는 영상에서 동작합니다.<br>자막이 있다면 플레이어의 자막 버튼을 켜 보세요.</div>
    </div>`;
}

/* ── ⓐ 자막 취득 중 (스피너 + 스켈레톤) ── */
function renderFetchingView(body) {
  const skeletonWidths = ['88%', '72%', '93%', '61%', '84%', '70%', '90%', '66%'];
  body.innerHTML = `
    <div class="ytx-fetching">
      <div class="ytx-progress-row" style="padding: 10px 8px 12px 8px;">
        <div class="ytx-spinner"></div>
        <div class="ytx-progress-label" style="color: var(--ytx-text2);">자막 데이터 취득 중…</div>
      </div>
      ${skeletonWidths.map((w) => `
        <div class="ytx-sk-row">
          <div class="ytx-skeleton"></div>
          <div class="ytx-skeleton" style="width:${w}"></div>
        </div>`).join('')}
    </div>`;
}

/* ── ⓓ 오류 (번역 결과가 전혀 없을 때 — 부분 실패는 목록에 유지) ── */
function renderErrorView(body) {
  const err = state.lastError || { code: 'UNKNOWN', message: '알 수 없는 오류' };
  body.innerHTML = `
    <div class="ytx-empty">
      <div class="ytx-error-badge">!</div>
      <div class="ytx-empty-title">${escapeHtml(errorTitle(err.code))}</div>
      <div class="ytx-empty-desc ytx-mono">${escapeHtml(err.message)}</div>
      <div class="ytx-error-actions">
        <button class="ytx-primary-btn" data-ytx="retry">재시도</button>
        <button class="ytx-ghost-btn" data-ytx="open-settings">설정 열기</button>
      </div>
    </div>`;
  body.querySelector('[data-ytx="retry"]')?.addEventListener('click', retryTranslation);
  body.querySelector('[data-ytx="open-settings"]')?.addEventListener('click', () => toggleSettings());
}

/* ── ⓑ/ⓒ 스크립트 (번역 중 점진 / 완료 / 수동 대기) — 목록·문단 모드 ── */
function renderScriptView(body) {
  let progressHtml = '';
  if (state.transPhase === 'translating') progressHtml = buildProgressHeaderHtml();
  else if (state.transPhase === 'ready') progressHtml = buildManualCtaHtml(); // 수동 모드

  if (state.mode === 'rows') {
    const rowsHtml = state.caption.segments.map((seg) => buildRowHtml(seg)).join('');
    body.innerHTML = `${progressHtml}<div class="ytx-rows">${rowsHtml}</div>`;
    body.querySelectorAll('.ytx-row').forEach((row) => {
      row.addEventListener('click', () => seekTo(parseInt(row.dataset.seg, 10)));
    });
  } else {
    const spansHtml = state.caption.segments.map((seg) => buildSpanHtml(seg)).join(' ');
    body.innerHTML = `${progressHtml}<div class="ytx-para"><p>${spansHtml}</p></div>`;
    body.querySelectorAll('.ytx-span').forEach((span) => {
      span.addEventListener('click', () => seekTo(parseInt(span.dataset.seg, 10)));
    });
  }

  // 수동 모드 CTA 버튼 바인딩
  body.querySelector('[data-ytx="start-translate"]')?.addEventListener('click', () => {
    requestTranslation();
    renderPanelState();
  });

  updateActiveHighlight(true);
}

/* ═══════════════════════════════════════════════════════════
 * 요약 뷰 (수동 전용 — 번역과 독립, 원문+제목 기반)
 * ═══════════════════════════════════════════════════════════ */
let summaryTicker = null; // 로딩 경과 시간 표시 타이머

function renderSummaryView(body) {
  if (summaryTicker) { clearInterval(summaryTicker); summaryTicker = null; }

  const data = state.summaryByLevel[state.summaryLevel];
  const levelOptions = YTX.SUMMARY_LEVELS
    .map((l) => `<option value="${l.value}"${l.value === state.summaryLevel ? ' selected' : ''}>${l.label}</option>`)
    .join('');
  const modelOptions = YTX.CLAUDE_SUMMARY_MODELS
    .map((m) => `<option value="${m.value}"${m.value === state.summaryClaudeModel ? ' selected' : ''}>${m.label}</option>`)
    .join('');

  // 상단 컨트롤 바: 수준 + 모델(Claude 경로) + (재생성)
  const headerHtml = `
    <div class="ytx-progress">
      <div class="ytx-progress-row">
        <div class="ytx-progress-label">요약</div>
        <select class="ytx-select ytx-select-sm" data-ytx="summary-level">${levelOptions}</select>
        ${state.route === 'localhost'
          ? `<select class="ytx-select ytx-select-sm" data-ytx="summary-model" title="요약 모델 (요약에만 적용)">${modelOptions}</select>`
          : ''}
        <div class="ytx-header-spacer"></div>
        ${data ? '<button class="ytx-ghost-btn ytx-cta-btn" data-ytx="summary-again">다시 요약</button>' : ''}
      </div>
    </div>`;

  let contentHtml;
  if (state.summaryPhase === 'loading' && !data) {
    const p = state.summaryProgress;
    const progressDesc = p && p.total > 1
      ? `긴 영상 — 분할 요약 진행 중 (${Math.min(p.done + 1, p.total)}/${p.total} 단계)<br>부분 요약 후 통합합니다. 정확성을 위해 전 구간을 처리합니다.`
      : `스크립트 ${state.caption.segments.length}개 세그먼트를 분석하고 있습니다.`;
    contentHtml = `
      <div class="ytx-empty">
        <div class="ytx-spinner" style="width:20px;height:20px;"></div>
        <div class="ytx-empty-title">요약 생성 중… <span data-ytx="sum-elapsed"></span></div>
        <div class="ytx-empty-desc">${progressDesc}</div>
      </div>`;
  } else if (state.summaryPhase === 'error' && !data) {
    const err = state.summaryError || { code: 'UNKNOWN', message: '알 수 없는 오류' };
    contentHtml = `
      <div class="ytx-empty">
        <div class="ytx-error-badge">!</div>
        <div class="ytx-empty-title">${escapeHtml(errorTitle(err.code))}</div>
        <div class="ytx-empty-desc ytx-mono">${escapeHtml(err.message)}</div>
        <div class="ytx-error-actions">
          <button class="ytx-primary-btn" data-ytx="summary-retry">재시도</button>
        </div>
      </div>`;
  } else if (!data) {
    // 수동 CTA — 요약 탭에서는 '이 영상 요약하기'로 교체
    contentHtml = `
      <div class="ytx-empty">
        <div class="ytx-empty-title">이 영상을 요약할까요?</div>
        <div class="ytx-empty-desc">스크립트 원문과 제목으로 ${escapeHtml(levelLabel(state.summaryLevel))} 요약을 생성합니다.<br>번역과 별개로 동작하며, 결과는 캐시됩니다.</div>
        <div class="ytx-error-actions">
          <button class="ytx-primary-btn" data-ytx="summary-start">이 영상 요약하기</button>
        </div>
      </div>`;
  } else {
    const tldrHtml = data.tldr.map((t) => `<li>${escapeHtml(t)}</li>`).join('');
    const sectionsHtml = data.sections.map((sec) => `
      <div class="ytx-sum-section" data-start="${sec.start}">
        <div class="ytx-sum-sec-head">
          <span class="ytx-sum-time">${fmtTime(sec.start)}</span>
          <span class="ytx-sum-title">${escapeHtml(sec.title)}</span>
        </div>
        ${sec.summary ? `<div class="ytx-sum-text">${escapeHtml(sec.summary)}</div>` : ''}
      </div>`).join('');
    contentHtml = `
      <div class="ytx-summary">
        <div class="ytx-sum-block">
          <div class="ytx-sum-label">핵심 요약</div>
          <ul class="ytx-sum-tldr">${tldrHtml}</ul>
        </div>
        ${data.sections.length ? `
        <div class="ytx-sum-block">
          <div class="ytx-sum-label">타임라인 (클릭 시 해당 구간으로 이동)</div>
          ${sectionsHtml}
        </div>` : ''}
      </div>`;
  }

  body.innerHTML = headerHtml + contentHtml;

  // ── 로딩 경과 시간 표시 (1초 간격) ──
  const elapsedEl = body.querySelector('[data-ytx="sum-elapsed"]');
  if (elapsedEl && state.summaryStartedAt) {
    const tick = () => {
      elapsedEl.textContent = `(${Math.floor((Date.now() - state.summaryStartedAt) / 1000)}초)`;
    };
    tick();
    summaryTicker = setInterval(tick, 1000);
  }

  // ── 이벤트 바인딩 ──
  body.querySelector('[data-ytx="summary-level"]').addEventListener('change', (e) => {
    state.summaryLevel = e.target.value;
    saveSettings({ summaryLevel: state.summaryLevel });
    state.summaryPhase = state.summaryByLevel[state.summaryLevel] ? 'done' : 'idle';
    renderPanelState();
  });
  body.querySelector('[data-ytx="summary-model"]')?.addEventListener('change', (e) => {
    state.summaryClaudeModel = e.target.value;
    saveSettings({ summaryClaudeModel: state.summaryClaudeModel });
    // 모델이 바뀌면 세션 내 결과는 무효 (bg 캐시는 모델별 키라 안전)
    state.summaryByLevel = {};
    state.summaryPhase = 'idle';
    renderPanelState();
  });
  const startSummary = () => { requestSummary(); renderPanelState(); };
  body.querySelector('[data-ytx="summary-start"]')?.addEventListener('click', startSummary);
  body.querySelector('[data-ytx="summary-retry"]')?.addEventListener('click', startSummary);
  body.querySelector('[data-ytx="summary-again"]')?.addEventListener('click', () => {
    delete state.summaryByLevel[state.summaryLevel];
    requestSummary(true); // 캐시 무시 재생성
    renderPanelState();
  });
  body.querySelectorAll('.ytx-sum-section').forEach((el) => {
    el.addEventListener('click', () => seekToTime(parseFloat(el.dataset.start) || 0));
  });
}

function levelLabel(v) {
  return (YTX.SUMMARY_LEVELS.find((l) => l.value === v) || {}).label || v;
}

/** 수동 모드 CTA — 자막은 확보됐고 번역은 버튼 클릭 시 시작 */
function buildManualCtaHtml() {
  return `
    <div class="ytx-progress">
      <div class="ytx-progress-row">
        <div class="ytx-progress-label">자막 준비됨 · ${state.caption.segments.length}개 세그먼트</div>
        <div class="ytx-header-spacer"></div>
        <button class="ytx-primary-btn ytx-cta-btn" data-ytx="start-translate">이 영상 번역하기</button>
      </div>
    </div>`;
}

/** 목록 모드 행 — 번역중: 원문 먼저 + 번역 자리 스켈레톤 (목업 사양) */
function buildRowHtml(seg) {
  const tr = state.translations[String(seg.id)];
  const active = seg.id === state.activeSegId ? ' ytx-active' : '';
  let main;
  if (tr != null) {
    // 번역 생략(동일 언어) 시 원문 병기는 중복이므로 표시하지 않음
    main = `<div class="ytx-row-text">${escapeHtml(tr)}</div>` +
      (state.bilingual && !state.transSkipped ? `<div class="ytx-row-src">${escapeHtml(seg.text)}</div>` : '');
  } else if (state.transPhase === 'translating') {
    const w = 55 + ((seg.id * 17) % 35);
    main = `<div class="ytx-row-src" style="margin-top:0">${escapeHtml(seg.text)}</div>` +
      `<div class="ytx-skeleton ytx-row-sk" style="width:${w}%"></div>`;
  } else {
    main = `<div class="ytx-row-text ytx-pending">${escapeHtml(seg.text)}</div>`;
  }
  return `
    <div class="ytx-row${active}" data-seg="${seg.id}">
      <div class="ytx-row-time">${fmtTime(seg.start)}</div>
      <div class="ytx-row-main">${main}</div>
    </div>`;
}

/** 문단 모드 스팬 — 원문은 hover 툴팁(title), 미번역분은 원문 회색 */
function buildSpanHtml(seg) {
  const tr = state.translations[String(seg.id)];
  const active = seg.id === state.activeSegId ? ' ytx-active' : '';
  const pending = tr == null ? ' ytx-span-pending' : '';
  return `<span class="ytx-span${active}${pending}" data-seg="${seg.id}" title="${escapeHtml(seg.text)}">${escapeHtml(tr != null ? tr : seg.text)}</span>`;
}

/* ── 번역 진행 헤더 ── */
function buildProgressHeaderHtml() {
  const pct = state.totalSegments ? Math.round(state.doneSegments / state.totalSegments * 100) : 0;
  return `
    <div class="ytx-progress" data-ytx="progress">
      <div class="ytx-progress-row">
        <div class="ytx-spinner"></div>
        <div class="ytx-progress-label" data-ytx="progress-label">번역 중 · ${state.doneSegments} / ${state.totalSegments} 세그먼트</div>
        <div class="ytx-progress-route">${escapeHtml(state.routeLabel || '')}</div>
      </div>
      <div class="ytx-progress-track"><div class="ytx-progress-fill" data-ytx="progress-fill" style="width:${pct}%"></div></div>
    </div>`;
}

/** 진행 헤더만 갱신 (전체 재렌더 없이) */
function updateProgressHeader() {
  if (!panelEl) return;
  const label = panelEl.querySelector('[data-ytx="progress-label"]');
  const fill = panelEl.querySelector('[data-ytx="progress-fill"]');
  if (!label || !fill) return;
  const pct = state.totalSegments ? Math.round(state.doneSegments / state.totalSegments * 100) : 0;
  label.textContent = `번역 중 · ${state.doneSegments} / ${state.totalSegments} 세그먼트`;
  fill.style.width = `${pct}%`;
}

/**
 * 완료분 인플레이스 반영 — 전체 재렌더 없이 해당 행/스팬만 교체.
 * 스크롤 위치·하이라이트를 보존한다. (설계서 §4 '완료분부터 점진 표시')
 */
function applyTranslations(ids) {
  if (!panelEl || !state.caption) return;
  const body = panelEl.querySelector('[data-ytx="body"]');
  // 목록/문단이 아닌 상태(취득중 등)였다면 전체 렌더로 전환
  if (!body.querySelector('.ytx-rows') && !body.querySelector('.ytx-para')) {
    renderBody();
    return;
  }
  const segById = new Map(state.caption.segments.map((s) => [String(s.id), s]));

  for (const id of ids) {
    const seg = segById.get(String(id));
    if (!seg) continue;
    const el = body.querySelector(`[data-seg="${CSS.escape(String(id))}"]`);
    if (!el) continue;

    if (el.classList.contains('ytx-row')) {
      const tr = state.translations[String(id)];
      el.querySelector('.ytx-row-main').innerHTML =
        `<div class="ytx-row-text">${escapeHtml(tr)}</div>` +
        (state.bilingual ? `<div class="ytx-row-src">${escapeHtml(seg.text)}</div>` : '');
    } else if (el.classList.contains('ytx-span')) {
      el.classList.remove('ytx-span-pending');
      el.textContent = state.translations[String(id)];
    }
  }

  // 현재 오버레이에 떠 있는 세그먼트의 번역이 도착했으면 즉시 교체
  if (overlaySegId >= 0 && ids.some((id) => String(id) === String(overlaySegId))) {
    refreshOverlayText();
  }
}

/* ── 푸터 · 재활성 버튼 ── */
function renderFooter() {
  if (!panelEl) return;
  const statusText = panelEl.querySelector('[data-ytx="status-text"]');
  const statusDot = panelEl.querySelector('[data-ytx="status-dot"]');

  if (!state.caption) {
    statusText.textContent = state.noCaption ? '자막 없음' : '유튜브 timedtext 응답 대기 중';
    statusDot.className = 'ytx-status-dot';
    return;
  }
  const src = (state.caption.source_lang || '?').toUpperCase();
  const tgt = state.targetLang.toUpperCase();

  switch (state.transPhase) {
    case 'ready': {
      const done = Object.keys(state.translations).length;
      statusText.textContent = done > 0
        ? `부분 캐시 적용 · ${done}/${state.caption.segments.length} · 나머지는 번역 버튼으로`
        : `번역 대기 (수동 모드) · ${state.caption.segments.length}개 세그먼트`;
      statusDot.className = done > 0 ? 'ytx-status-dot ytx-accent' : 'ytx-status-dot';
      break;
    }
    case 'translating':
      statusText.textContent = `번역 중 · ${state.doneSegments}/${state.totalSegments} · ${state.routeLabel}`;
      statusDot.className = 'ytx-status-dot ytx-accent';
      break;
    case 'done': {
      if (state.transSkipped) {
        statusText.textContent =
          `원문이 이미 ${tgt} · 번역 생략 · ${state.caption.segments.length}개 세그먼트`;
        statusDot.className = 'ytx-status-dot ytx-accent';
        break;
      }
      const fail = state.failedChunks.length ? ` · 실패 청크 ${state.failedChunks.length}개` : '';
      statusText.textContent =
        `번역 완료 · ${state.caption.segments.length}개 세그먼트 · ${state.routeLabel} · ${src} → ${tgt}${fail}`;
      statusDot.className = state.failedChunks.length
        ? 'ytx-status-dot ytx-danger' : 'ytx-status-dot ytx-accent';
      break;
    }
    case 'error':
      statusText.textContent = `오류 · ${state.lastError?.code || ''} · ${state.routeLabel || ''}`;
      statusDot.className = 'ytx-status-dot ytx-danger';
      break;
    default: {
      const viaLabel = { intercept: '인터셉트(B)', refetch: '재fetch(A)', proactive: '능동 취득' }[state.captionVia] || state.captionVia;
      statusText.textContent =
        `자막 취득 완료 · ${state.caption.segments.length}개 · ${viaLabel}`;
      statusDot.className = 'ytx-status-dot ytx-accent';
    }
  }
}

function updateResumeButton() {
  if (!panelEl) return;
  const btn = panelEl.querySelector('[data-ytx="resume"]');
  btn.hidden = !(state.follow && state.followSuspended);
}

function errorTitle(code) {
  switch (code) {
    case 'CONNECTION': return '번역 서버에 연결할 수 없습니다';
    case 'NO_API_KEY': return 'Gemini API 키가 필요합니다';
    case 'AUTH': return 'API 키 인증에 실패했습니다';
    case 'RATE_LIMITED': return '요청 한도를 초과했습니다';
    case 'QUOTA': return 'API 무료 사용량이 소진되었습니다';
    case 'TIMEOUT': return '응답 시간이 초과되었습니다';
    case 'UNSUPPORTED_LANG': return '지원하지 않는 언어입니다';
    default: return '번역 중 오류가 발생했습니다';
  }
}

function retryTranslation() {
  if (!state.caption) return;
  requestTranslation();
  renderPanelState();
}

/* ═══════════════════════════════════════════════════════════
 * 인라인 설정 화면 (M6 — 설계서 §5 결정 + 지시서 §6.6)
 * 각 컨트롤은 변경 즉시 저장·적용, '완료'는 닫기(+필요 시 재번역).
 * ═══════════════════════════════════════════════════════════ */
async function toggleSettings() {
  if (state.cacheOpen) { // 캐시 뷰에서 기어 클릭 → 전부 닫기
    state.cacheOpen = false;
    state.settingsOpen = false;
    renderPanelState();
    return;
  }
  if (state.settingsOpen) return closeSettings();
  const s = await loadSettingsRaw();
  state.settingsDraft = { ...s };
  state.settingsSnapshot = { route: s.route, targetLang: s.targetLang, geminiModel: s.geminiModel, geminiApiKey: s.geminiApiKey, serverAddress: s.serverAddress };
  state.settingsOpen = true;
  state.collapsed = false;
  renderPanelState();
}

function closeSettings() {
  const d = state.settingsDraft;
  const snap = state.settingsSnapshot;
  state.settingsOpen = false;
  state.settingsDraft = null;
  state.settingsSnapshot = null;
  renderPanelState();

  // 번역 경로/언어/모델/키/포트가 바뀌었으면 재번역 (캐시 적중 시 즉시 표시)
  if (d && snap && state.caption) {
    const changed = ['route', 'targetLang', 'geminiModel', 'geminiApiKey', 'serverAddress']
      .some((k) => d[k] !== snap[k]);
    if (changed) {
      state.targetLang = d.targetLang;
      retryTranslation();
    }
  }
}

/** ? 도움말 아이콘 — hover 또는 클릭 시 툴팁 표시 */
function helpIconHtml(text) {
  return `<span class="ytx-help-wrap"><button type="button" class="ytx-help" title="도움말">?</button><span class="ytx-help-tip">${escapeHtml(text).replace(/\n/g, '<br>')}</span></span>`;
}

function renderSettings(body) {
  const d = state.settingsDraft || { ...YTX.DEFAULT_SETTINGS };
  const isLocal = d.route === 'localhost';

  const modelOptions = YTX.GEMINI.MODELS
    .map((m) => `<option value="${m}"${m === d.geminiModel ? ' selected' : ''}>${m}</option>`)
    .join('');

  body.innerHTML = `
    <div class="ytx-settings">
      <div class="ytx-field">
        <div class="ytx-field-label">번역 경로</div>
        <div class="ytx-route-group">
          <button class="ytx-route-btn${isLocal ? ' ytx-on' : ''}" data-ytx="route-local">Claude CLI</button>
          <button class="ytx-route-btn${!isLocal ? ' ytx-on' : ''}" data-ytx="route-gemini">Gemini API</button>
        </div>
      </div>

      ${isLocal ? `
      <div class="ytx-field">
        <div class="ytx-field-label">서버 주소 ${helpIconHtml(`확장이 이 주소로 번역을 요청합니다.\nPOST ${YTX.buildServerBase(d.serverAddress)}/translate\n\nlocalhost:8787 또는 192.168.0.10:8787 같은\nhost:port 형식을 입력하세요.`)}</div>
        <input type="text" class="ytx-input" data-ytx="set-addr" value="${escapeHtml(d.serverAddress)}" placeholder="localhost:8787" spellcheck="false">
      </div>` : `
      <div class="ytx-field">
        <div class="ytx-field-label">Gemini API 키 ${helpIconHtml('키는 이 브라우저의 chrome.storage에만 저장되며\n외부로 전송되지 않습니다.')}</div>
        <input type="password" class="ytx-input" placeholder="AIza…" data-ytx="set-key" value="${escapeHtml(d.geminiApiKey)}">
      </div>
      <div class="ytx-field">
        <div class="ytx-field-label">Gemini 모델</div>
        <select class="ytx-select" data-ytx="set-model">${modelOptions}</select>
      </div>
      <div class="ytx-field">
        <div class="ytx-field-label">요금제 티어 ${helpIconHtml('무료 티어는 분당/일일 요청 한도가 매우 낮아\n호출 간격을 자동으로 띄웁니다(429 예방).\n결제 계정 연결(Tier 1+) 시 유료를 선택하면 빨라집니다.')}</div>
        <select class="ytx-select" data-ytx="set-tier">
          <option value="free"${d.geminiTier !== 'paid' ? ' selected' : ''}>무료 (호출 간격 자동 조절)</option>
          <option value="paid"${d.geminiTier === 'paid' ? ' selected' : ''}>유료 Tier 1+ (빠름)</option>
        </select>
      </div>`}

      <div class="ytx-field">
        <div class="ytx-field-label">대상 언어</div>
        <select class="ytx-select" data-ytx="set-lang">
          <option value="ko"${d.targetLang === 'ko' ? ' selected' : ''}>한국어</option>
          <option value="en"${d.targetLang === 'en' ? ' selected' : ''}>English</option>
          <option value="ja"${d.targetLang === 'ja' ? ' selected' : ''}>日本語</option>
        </select>
      </div>

      <div class="ytx-field">
        <div class="ytx-field-label">번역 시작</div>
        <div class="ytx-field-row">
          <div class="ytx-field-row-label">영상 열면 자동 번역</div>
          <button class="ytx-toggle${d.autoTranslate ? ' ytx-on' : ''}" data-ytx="set-autotrans"><div class="ytx-toggle-knob"></div></button>
        </div>
        <div class="ytx-field-hint">끄면 자막만 취득해 두고, 패널의 "이 영상 번역하기" 버튼을 눌렀을 때만 번역합니다.</div>
      </div>

      <div class="ytx-field">
        <div class="ytx-field-label">기본 표시</div>
        <div class="ytx-field-row">
          <div class="ytx-field-row-label">표시 모드 기본값</div>
          <select class="ytx-select ytx-select-sm" data-ytx="set-defmode">
            <option value="rows"${d.defMode === 'rows' ? ' selected' : ''}>타임라인 목록</option>
            <option value="para"${d.defMode === 'para' ? ' selected' : ''}>연속 문단</option>
          </select>
        </div>
        <div class="ytx-field-row">
          <div class="ytx-field-row-label">자동 스크롤 기본 켜기</div>
          <button class="ytx-toggle${d.defFollow ? ' ytx-on' : ''}" data-ytx="set-deffollow"><div class="ytx-toggle-knob"></div></button>
        </div>
      </div>

      <div class="ytx-field">
        <div class="ytx-field-label">영상 자막 오버레이</div>
        <div class="ytx-field-row">
          <div class="ytx-field-row-label">영상에 번역 자막 표시</div>
          <button class="ytx-toggle${d.overlayOn ? ' ytx-on' : ''}" data-ytx="set-overlayon"><div class="ytx-toggle-knob"></div></button>
        </div>
        <div class="ytx-field-row">
          <div class="ytx-field-row-label">표시 방식</div>
          <select class="ytx-select ytx-select-sm" data-ytx="set-overlaymode">
            <option value="replace"${d.overlayMode === 'replace' ? ' selected' : ''}>교체 (번역만)</option>
            <option value="dual"${d.overlayMode === 'dual' ? ' selected' : ''}>병기 (원문+번역)</option>
          </select>
        </div>
        <div class="ytx-field-row">
          <div class="ytx-field-row-label">폰트 크기</div>
          <select class="ytx-select ytx-select-sm" data-ytx="set-overlayfont">
            <option value="sm"${d.overlayFontSize === 'sm' ? ' selected' : ''}>소</option>
            <option value="md"${d.overlayFontSize === 'md' ? ' selected' : ''}>중</option>
            <option value="lg"${d.overlayFontSize === 'lg' ? ' selected' : ''}>대</option>
          </select>
        </div>
      </div>

      <div class="ytx-field">
        <div class="ytx-field-label">번역·요약 캐시 (재방문 시 즉시 표시용)</div>
        <div class="ytx-field-row">
          <div class="ytx-field-row-label" data-ytx="cache-summary">불러오는 중…</div>
          <button class="ytx-primary-btn ytx-cta-btn" data-ytx="cache-open">캐시 관리</button>
        </div>
      </div>

      <div class="ytx-settings-footer">
        <button class="ytx-primary-btn" data-ytx="settings-done">완료</button>
      </div>
    </div>`;

  bindSettingsEvents(body);
  fillCacheSummary(body); // 비동기: "N개 · X MB"
}

/** 설정 화면의 캐시 요약 한 줄 */
async function fillCacheSummary(body) {
  const el = body.querySelector('[data-ytx="cache-summary"]');
  if (!el) return;
  const entries = await loadCacheEntries();
  const bytes = entries.reduce((s, e) => s + e.size, 0);
  el.textContent = entries.length
    ? `${entries.length}개 저장됨 · ${fmtBytes(bytes)}`
    : '저장된 캐시 없음';
}

/* ═══════════════════════════════════════════════════════════
 * 캐시 관리 전용 뷰 — 패널 본문 전체 사용 (설정에서 진입)
 * 검색 · 타입 필터(전체/번역/요약) · 개수/용량 표시 · 개별/전체 삭제
 * ═══════════════════════════════════════════════════════════ */
let cacheQuery = '';   // 세션 내 유지되는 검색어/필터
let cacheTypeFilter = 'all'; // 'all' | 'trans' | 'sum'

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

/** storage → 캐시 항목 배열 (크기 포함, 최신순) */
async function loadCacheEntries() {
  let all = {};
  try { all = await chrome.storage.local.get(null); } catch (e) { /* 무시 */ }

  return Object.entries(all)
    .filter(([k]) => k.startsWith(YTX.STORAGE.CACHE_PREFIX + '|') || k.startsWith(YTX.STORAGE.SUM_PREFIX + '|'))
    .map(([key, v]) => {
      const parts = key.split('|');
      const isSum = parts[0] === YTX.STORAGE.SUM_PREFIX;
      let size = 0;
      try { size = JSON.stringify(v).length; } catch (e) { /* 무시 */ }
      return {
        key, isSum, size,
        videoId: parts[1], lang: parts[2], route: parts[3],
        model: isSum ? parts[4] : '',
        level: isSum ? (parts[5] || parts[4]) : '', // 구키(모델 없는 형식) 호환
        title: v.title || parts[1],
        complete: isSum ? true : !!v.complete,
        cachedAt: v.cached_at || 0,
        count: isSum ? (v.data?.sections?.length || 0) : Object.keys(v.map || {}).length
      };
    })
    .sort((a, b) => b.cachedAt - a.cachedAt);
}

function renderCacheView(body) {
  body.innerHTML = `
    <div class="ytx-progress">
      <div class="ytx-progress-row">
        <button class="ytx-icon-btn" data-ytx="cache-back" title="설정으로 돌아가기">←</button>
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

  const refreshList = () => {
    const itemsEl = body.querySelector('[data-ytx="cache-items"]');
    const statsEl = body.querySelector('[data-ytx="cache-stats"]');
    if (!itemsEl) return;

    const q = cacheQuery.trim().toLowerCase();
    const filtered = entries.filter((e) => {
      if (cacheTypeFilter === 'trans' && e.isSum) return false;
      if (cacheTypeFilter === 'sum' && !e.isSum) return false;
      if (q && !e.title.toLowerCase().includes(q)) return false;
      return true;
    });

    const totalBytes = entries.reduce((s, e) => s + e.size, 0);
    statsEl.textContent = `${filtered.length}/${entries.length}개 · ${fmtBytes(totalBytes)}`;

    if (filtered.length === 0) {
      itemsEl.innerHTML = '<div class="ytx-empty"><div class="ytx-empty-desc">' +
        (entries.length === 0 ? '저장된 캐시가 없습니다.' : '검색/필터 결과가 없습니다.') + '</div></div>';
      return;
    }

    itemsEl.innerHTML = filtered.map((e) => {
      const kind = e.isSum
        ? `요약(${levelLabel(e.level)}${e.model && e.model !== e.level ? '·' + e.model : ''})`
        : `번역 ${e.count}개${e.complete ? '' : ' · 부분'}`;
      return `
      <div class="ytx-cache-item">
        <div class="ytx-cache-info">
          <div class="ytx-cache-title" title="${escapeHtml(e.title)}">${escapeHtml(e.title)}</div>
          <div class="ytx-cache-meta">${kind} · → ${escapeHtml((e.lang || '?').toUpperCase())} · ${e.route === 'gemini' ? 'Gemini' : 'Claude'} · ${fmtBytes(e.size)} · ${fmtCacheDate(e.cachedAt)}</div>
        </div>
        <button class="ytx-icon-btn ytx-cache-del" data-key="${escapeHtml(e.key)}" title="이 캐시 삭제">✕</button>
      </div>`;
    }).join('');

    itemsEl.querySelectorAll('.ytx-cache-del').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await chrome.storage.local.remove(btn.dataset.key); } catch (e) { /* 무시 */ }
        entries = entries.filter((e) => e.key !== btn.dataset.key);
        refreshList();
      });
    });
  };

  // ── 이벤트 바인딩 (검색은 목록만 갱신 — 입력 포커스 유지) ──
  body.querySelector('[data-ytx="cache-back"]').addEventListener('click', () => {
    state.cacheOpen = false;
    state.settingsOpen = true;
    renderPanelState();
  });
  body.querySelector('[data-ytx="cache-search"]').addEventListener('input', (e) => {
    cacheQuery = e.target.value;
    refreshList();
  });
  const setFilter = (type) => {
    cacheTypeFilter = type;
    body.querySelector('[data-ytx="cf-all"]').classList.toggle('ytx-on', type === 'all');
    body.querySelector('[data-ytx="cf-trans"]').classList.toggle('ytx-on', type === 'trans');
    body.querySelector('[data-ytx="cf-sum"]').classList.toggle('ytx-on', type === 'sum');
    refreshList();
  };
  body.querySelector('[data-ytx="cf-all"]').addEventListener('click', () => setFilter('all'));
  body.querySelector('[data-ytx="cf-trans"]').addEventListener('click', () => setFilter('trans'));
  body.querySelector('[data-ytx="cf-sum"]').addEventListener('click', () => setFilter('sum'));
  body.querySelector('[data-ytx="cache-clear"]').addEventListener('click', async () => {
    try {
      const keys = entries.map((e) => e.key);
      if (keys.length) await chrome.storage.local.remove(keys);
    } catch (e) { /* 무시 */ }
    entries = [];
    refreshList();
  });

  loadCacheEntries().then((list) => {
    entries = list;
    refreshList();
  });
}

function bindSettingsEvents(body) {
  /* 변경 즉시 저장·적용 */
  const apply = (patch, rerender) => {
    Object.assign(state.settingsDraft, patch);
    saveSettings(patch);
    if (rerender) renderSettings(body);
  };

  body.querySelector('[data-ytx="route-local"]').addEventListener('click', () => {
    state.route = 'localhost';
    apply({ route: 'localhost' }, true);
  });
  body.querySelector('[data-ytx="route-gemini"]').addEventListener('click', () => {
    state.route = 'gemini';
    apply({ route: 'gemini' }, true);
  });

  body.querySelector('[data-ytx="set-addr"]')?.addEventListener('change', (e) => {
    const addr = e.target.value.trim().replace(/[^\w.:\-/]/g, '') || YTX.DEFAULT_SETTINGS.serverAddress;
    apply({ serverAddress: addr }, true);
  });

  // ? 도움말: 클릭 토글 (hover는 CSS로 처리)
  body.querySelectorAll('.ytx-help').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      btn.parentElement.classList.toggle('ytx-open');
    });
  });
  body.querySelector('[data-ytx="set-key"]')?.addEventListener('change', (e) => apply({ geminiApiKey: e.target.value.trim() }));
  body.querySelector('[data-ytx="set-model"]')?.addEventListener('change', (e) => apply({ geminiModel: e.target.value }));
  body.querySelector('[data-ytx="set-tier"]')?.addEventListener('change', (e) => apply({ geminiTier: e.target.value }));

  body.querySelector('[data-ytx="set-autotrans"]').addEventListener('click', (e) => {
    const next = !state.settingsDraft.autoTranslate;
    e.currentTarget.classList.toggle('ytx-on', next);
    state.autoTranslate = next;
    apply({ autoTranslate: next });
    // 수동 대기 중이던 영상에서 자동으로 켜면 즉시 번역 시작
    if (next && state.caption && state.transPhase === 'ready') {
      requestTranslation();
    }
  });

  body.querySelector('[data-ytx="cache-open"]').addEventListener('click', () => {
    state.settingsOpen = false;
    state.cacheOpen = true;
    renderPanelState();
  });

  body.querySelector('[data-ytx="set-lang"]').addEventListener('change', (e) => apply({ targetLang: e.target.value }));
  body.querySelector('[data-ytx="set-defmode"]').addEventListener('change', (e) => apply({ defMode: e.target.value }));
  body.querySelector('[data-ytx="set-deffollow"]').addEventListener('click', (e) => {
    const next = !state.settingsDraft.defFollow;
    e.currentTarget.classList.toggle('ytx-on', next);
    apply({ defFollow: next });
  });

  // 오버레이 설정은 즉시 화면에 반영 (§6.6)
  body.querySelector('[data-ytx="set-overlayon"]').addEventListener('click', (e) => {
    const next = !state.settingsDraft.overlayOn;
    e.currentTarget.classList.toggle('ytx-on', next);
    state.overlayOn = next;
    apply({ overlayOn: next });
    syncOverlay();
    panelEl.querySelector('[data-ytx="overlay"]').classList.toggle('ytx-on', next);
  });
  body.querySelector('[data-ytx="set-overlaymode"]').addEventListener('change', (e) => {
    state.overlayMode = e.target.value;
    apply({ overlayMode: e.target.value });
    refreshOverlayText();
  });
  body.querySelector('[data-ytx="set-overlayfont"]').addEventListener('change', (e) => {
    state.overlayFontSize = e.target.value;
    apply({ overlayFontSize: e.target.value });
    if (overlayEl) overlayEl.dataset.ytxFont = e.target.value;
  });

  body.querySelector('[data-ytx="settings-done"]').addEventListener('click', closeSettings);
}
