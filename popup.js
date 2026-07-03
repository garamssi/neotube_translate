/**
 * popup.js — 액션 팝업 (전체 on/off + 현재 경로 요약)
 *
 * 기본값·마이그레이션은 constants.js(YTX)를 공유 — 중복 정의 없음.
 * 표시 값은 chrome.storage의 실제 설정을 읽으며, 열려 있는 동안
 * 설정이 바뀌면 storage.onChanged로 실시간 갱신된다.
 */
'use strict';

const toggleEl = document.getElementById('enabled');
const routeEl = document.getElementById('route');

async function getSettings() {
  const stored = await chrome.storage.local.get(YTX.STORAGE.SETTINGS);
  return YTX.normalizeSettings(stored[YTX.STORAGE.SETTINGS]);
}

function render(s) {
  toggleEl.classList.toggle('on', s.enabled);
  const routeText = s.route === 'gemini'
    ? `Gemini API (<b>${s.geminiModel}</b>)`
    : `Claude CLI · <b>${s.serverAddress}</b>`;
  routeEl.innerHTML =
    `번역 경로: ${routeText}<br>대상 언어: <b>${(s.targetLang || 'ko').toUpperCase()}</b>` +
    `<br>번역 시작: <b>${s.autoTranslate ? '자동' : '수동 (번역 버튼)'}</b>`;
}

toggleEl.addEventListener('click', async () => {
  const s = await getSettings();
  s.enabled = !s.enabled;
  await chrome.storage.local.set({ [YTX.STORAGE.SETTINGS]: s });
  render(s);
});

// 팝업이 열려 있는 동안 설정 변경 실시간 반영
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[YTX.STORAGE.SETTINGS]) return;
  render(YTX.normalizeSettings(changes[YTX.STORAGE.SETTINGS].newValue));
});

getSettings().then(render);
