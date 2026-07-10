/**
 * popup.js — 액션 팝업 (디자인 리뉴얼: 확장 팝업 목업 사양)
 *
 * 성격: 빠른 확인·전환용. enabled 토글 + 현재 설정 요약(읽기 전용).
 * - 기본값·마이그레이션은 constants.js(YTX) 공유 — 중복 정의 없음.
 * - enabled 토글 → chrome.storage 저장. content script가 storage.onChanged를
 *   구독하고 있어 열린 유튜브 탭 전체에 즉시 전파된다 (별도 메시지 불필요).
 * - 기어 → 활성 탭이 유튜브면 인패널 설정 화면을 열고, 아니면 유튜브를 연다.
 *   (옵션 페이지 없음 — 상세 설정은 인패널이 단일 소스)
 */
'use strict';

const els = {
  dot: document.getElementById('status-dot'),
  sub: document.getElementById('enable-sub'),
  toggle: document.getElementById('enabled'),
  routeName: document.getElementById('route-name'),
  routeBadge: document.getElementById('route-badge'),
  lang: document.getElementById('lang'),
  autostart: document.getElementById('autostart'),
  gear: document.getElementById('gear')
};

async function getSettings() {
  const stored = await chrome.storage.local.get(YTX.STORAGE.SETTINGS);
  return YTX.normalizeSettings(stored[YTX.STORAGE.SETTINGS]);
}

function render(s) {
  // 전체 사용
  els.dot.classList.toggle('on', s.enabled);
  els.toggle.classList.toggle('on', s.enabled);
  els.toggle.setAttribute('aria-checked', String(!!s.enabled));
  els.sub.textContent = s.enabled ? '켜짐 · 자막 취득 활성' : '꺼짐 · 자막 취득 안 함';

  // 번역 경로 + 모델 배지
  let name;
  let badge;
  if (s.route === 'gemini') {
    name = 'Gemini API';
    badge = s.geminiModel;
  } else if (s.route === 'openai') {
    name = 'OpenAI API';
    badge = s.openaiModel;
  } else {
    name = 'Claude CLI';
    badge = s.serverAddress;
  }
  els.routeName.textContent = name;
  els.routeBadge.textContent = badge || '';
  els.routeBadge.hidden = !badge;

  // 대상 언어 (코드 → 표시명)
  const lang = (YTX.TARGET_LANGS || []).find(([v]) => v === s.targetLang);
  els.lang.textContent = lang ? lang[1] : (s.targetLang || '—').toUpperCase();

  // 번역 시작
  els.autostart.textContent = s.autoTranslate ? '자동' : '수동 (번역 버튼)';
}

els.toggle.addEventListener('click', async () => {
  const s = await getSettings();
  s.enabled = !s.enabled;
  await chrome.storage.local.set({ [YTX.STORAGE.SETTINGS]: s });
  render(s); // storage.onChanged로도 갱신되지만 즉각 반응을 위해 선반영
});

els.gear.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // host_permissions(*.youtube.com) 덕에 유튜브 탭은 url 접근 가능
    if (tab && tab.url && /(^https?:\/\/)([^/]*\.)?youtube\.com\//.test(tab.url)) {
      await chrome.tabs.sendMessage(tab.id, { type: YTX.MSG.OPEN_SETTINGS }).catch(() => {});
      window.close();
      return;
    }
    await chrome.tabs.create({ url: 'https://www.youtube.com' });
    window.close();
  } catch (e) { /* 무시 */ }
});

// 팝업이 열려 있는 동안 설정 변경 실시간 반영
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[YTX.STORAGE.SETTINGS]) return;
  render(YTX.normalizeSettings(changes[YTX.STORAGE.SETTINGS].newValue));
});

getSettings().then(render);
