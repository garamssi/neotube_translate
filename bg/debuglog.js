/**
 * bg/debuglog.js — 디버그 로그 버스 (패널 '디버그 로그' 뷰의 데이터 소스)
 *
 * - 서비스 워커의 log()/warn()을 여기서 정의: 콘솔 출력 + 링버퍼 기록을 겸한다
 *   → 기존 호출부 수정 없이 모든 이벤트(취득 경로·청크 계획·429·재시도·캐시)가 수집됨
 * - 번역 파이프라인이 DBG.count()로 구조화 통계(요청/성공/실패/재시도/429)를 올린다
 * - 저장소는 chrome.storage.session: SW가 30초 유휴로 재시작돼도 로그 유지,
 *   브라우저 종료 시 자동 삭제(용량·프라이버시 부담 없음), storage.local 캐시와 분리
 * - 외부 전송 없음 — 로그는 이 브라우저 안에만 존재한다
 */
'use strict';

const DBG = {
  MAX_ENTRIES: 200,
  buf: [],   // { t(ms), lvl: 'log'|'warn', msg }
  stats: { attempts: 0, ok: 0, failed: 0, retries: 0, rateLimited: 0, lastError: '' },
  loaded: false,
  saveTimer: null,

  /** 인자 배열 → 한 줄 문자열 (객체는 JSON, 200자 절단) */
  fmt(args) {
    return args.map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    }).join(' ').slice(0, 300);
  },

  push(lvl, args) {
    this.buf.push({ t: Date.now(), lvl, msg: this.fmt(args) });
    if (this.buf.length > this.MAX_ENTRIES) this.buf.splice(0, this.buf.length - this.MAX_ENTRIES);
    this.scheduleSave();
  },

  /** 구조화 통계 — key: attempts|ok|failed|retries|rateLimited */
  count(key, errorInfo) {
    if (this.stats[key] != null) this.stats[key]++;
    if (errorInfo) this.stats.lastError = String(errorInfo).slice(0, 200);
    this.scheduleSave();
  },

  /** SW 재시작 대비 — 세션 저장 (debounce 800ms) */
  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        chrome.storage.session.set({ debuglog: { buf: this.buf, stats: this.stats } });
      } catch (e) { /* session storage 미지원/실패 — 메모리만으로 동작 */ }
    }, 800);
  },

  async restore() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const saved = (await chrome.storage.session.get('debuglog')).debuglog;
      if (saved && Array.isArray(saved.buf)) {
        // 재시작 이전 로그 뒤에 현재 세션 로그를 잇는다
        this.buf = saved.buf.concat(this.buf).slice(-this.MAX_ENTRIES);
        if (saved.stats) {
          for (const k of Object.keys(this.stats)) {
            if (typeof saved.stats[k] === 'number') this.stats[k] += saved.stats[k];
          }
          if (saved.stats.lastError && !this.stats.lastError) this.stats.lastError = saved.stats.lastError;
        }
      }
    } catch (e) { /* 무시 */ }
  },

  async snapshot() {
    await this.restore();
    return { entries: this.buf, stats: this.stats };
  },

  clear() {
    this.buf = [];
    this.stats = { attempts: 0, ok: 0, failed: 0, retries: 0, rateLimited: 0, lastError: '' };
    try { chrome.storage.session.remove('debuglog'); } catch (e) { /* 무시 */ }
  }
};

// SW 재시작 시 이전 세션 로그 복원 (비동기 — 최초 snapshot()에서도 보장됨)
DBG.restore();

/* 공용 로거 — 콘솔 + 디버그 버퍼 (bg 전 모듈이 사용) */
const log = (...a) => { console.log(YTX.LOG, ...a); DBG.push('log', a); };
const warn = (...a) => { console.warn(YTX.LOG, ...a); DBG.push('warn', a); };
