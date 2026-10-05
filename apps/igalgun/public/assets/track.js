// 행동 로그 수집기(브라우저). 개인 식별 정보 없이 익명 방문자·세션 ID로 이벤트를 모아 /collect로 보낸다.
// - Do Not Track / Global Privacy Control 또는 "통계 수집 거부"를 켜면 아무것도 보내지 않는다.
// - API가 설정되지 않은 배포(정적 호스팅)에서는 수집하지 않는다.
import { EVENTS, EXPERIMENTS, variantFor } from './events.js';

const CFG = window.IGG || { base: '', api: null };
const DEBUG = /[?&]debug_track=1/.test(location.search);
const SESSION_IDLE = 30 * 60 * 1000;

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 불가 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
};
const ss = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* 저장 불가 */ } },
};
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('');

export function optedOut() {
  return ls.get('igg:optout') === '1' || navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true;
}
export function setOptOut(on) { if (on) ls.set('igg:optout', '1'); else ls.del('igg:optout'); }

const enabled = Boolean(CFG.api) && !optedOut();

let vid = ls.get('igg:vid');
if (!vid || !/^[a-z0-9]{8,32}$/.test(vid)) { vid = rid(); ls.set('igg:vid', vid); }
let sid = ss.get('igg:sid');
const last = Number(ss.get('igg:last') || 0);
if (!sid || Date.now() - last > SESSION_IDLE) { sid = rid(); ss.set('igg:sid', sid); ss.set('igg:src', ''); }

function source() {
  let src = ss.get('igg:src');
  if (src) return src;
  const q = new URLSearchParams(location.search);
  src = q.get('utm_source');
  if (!src && document.referrer) {
    try {
      const host = new URL(document.referrer).hostname.replace(/^www\.|^m\./, '');
      if (host && host !== location.hostname) src = host.replace(/\.(com|co\.kr|kr|net|org)$/, '');
    } catch { /* 무시 */ }
  }
  src = (src || 'direct').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40) || 'direct';
  ss.set('igg:src', src);
  return src;
}
const dev = (() => {
  const w = Math.min(screen.width || innerWidth, innerWidth);
  const touch = matchMedia('(pointer: coarse)').matches;
  return touch && w < 760 ? 'm' : touch && w < 1100 ? 't' : 'd';
})();
const exp = Object.fromEntries(Object.keys(EXPERIMENTS).map((x) => [x, variantFor(x, vid)]));
const src = source();

let queue = [];
let timer = null;
const exposed = new Set();

function path() {
  const p = location.pathname.startsWith(CFG.base) ? location.pathname.slice(CFG.base.length) : location.pathname;
  return (p || '/').replace(/\/index\.html$/, '/').replace(/\/+$/, '') || '/';
}

export function track(e, props = {}) {
  if (!EVENTS[e]) { if (DEBUG) console.warn('[track] 알 수 없는 이벤트', e); return; }
  ss.set('igg:last', String(Date.now()));
  const ev = { e, t: Date.now(), p: props, path: path() };
  if (DEBUG) console.info('[track]', e, props);
  if (!enabled) return;
  queue.push(ev);
  if (queue.length >= 20) flush();
  else if (!timer) timer = setTimeout(flush, 5000);
}

export function variant(x) {
  const v = exp[x];
  if (v && !exposed.has(x)) { exposed.add(x); track('exp_expose', { exp: x, variant: v }); }
  return v;
}

export function flush(useBeacon = false) {
  clearTimeout(timer);
  timer = null;
  if (!enabled || !queue.length) return;
  const body = JSON.stringify({ vid, sid, dev, src, exp, events: queue.splice(0, 50) });
  const url = `${CFG.api}/collect`;
  const blob = new Blob([body], { type: 'text/plain' });
  if (useBeacon && navigator.sendBeacon && navigator.sendBeacon(url, blob)) return;
  fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive: true, mode: 'cors' }).catch(() => {});
  if (queue.length) flush(useBeacon);
}
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { reportVitals(); flush(true); } });
addEventListener('pagehide', () => flush(true));

/* ---------- 자동 수집: 페이지뷰, 스크롤 깊이, 성능, 오류 ---------- */
const q = new URLSearchParams(location.search);
track('page_view', {
  path: path(),
  ref: src,
  utm_source: q.get('utm_source') || undefined,
  utm_medium: q.get('utm_medium') || undefined,
  utm_campaign: q.get('utm_campaign') || undefined,
});

const marks = [25, 50, 75, 100];
const seen = new Set();
addEventListener('scroll', () => {
  const h = document.documentElement.scrollHeight - innerHeight;
  if (h <= 0) return;
  const pctNow = (scrollY / h) * 100;
  for (const m of marks) if (pctNow >= m - 2 && !seen.has(m)) { seen.add(m); track('scroll_depth', { pct: m }); }
}, { passive: true });

const vitals = {};
let vitalsSent = false;
try {
  new PerformanceObserver((l) => { const e = l.getEntries().at(-1); if (e) vitals.LCP = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) vitals.CLS = (vitals.CLS || 0) + e.value; }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId) vitals.INP = Math.max(vitals.INP || 0, e.duration); }).observe({ type: 'event', buffered: true, durationThreshold: 40 });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') vitals.FCP = e.startTime; }).observe({ type: 'paint', buffered: true });
  const nav = performance.getEntriesByType('navigation')[0];
  if (nav) vitals.TTFB = nav.responseStart;
} catch { /* 지원하지 않는 브라우저 */ }
function reportVitals() {
  if (vitalsSent) return;
  vitalsSent = true;
  for (const [name, value] of Object.entries(vitals)) if (Number.isFinite(value)) track('vital', { name, value: name === 'CLS' ? Math.round(value * 1000) / 1000 : Math.round(value) });
}

let errCount = 0;
addEventListener('error', (e) => { if (errCount++ < 5) track('js_error', { msg: `${e.message || 'error'} @${(e.filename || '').split('/').pop()}:${e.lineno || 0}` }); });
addEventListener('unhandledrejection', (e) => { if (errCount++ < 5) track('js_error', { msg: `promise: ${String(e.reason?.message || e.reason).slice(0, 60)}` }); });

export const trackingInfo = { enabled, vid, sid, dev, src, exp };
