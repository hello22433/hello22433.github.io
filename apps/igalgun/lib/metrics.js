// 기간 지표 조회. 저장소 명령 실행기(run)를 받아 날짜별 집계를 합친다.
import { KEY_EVENTS, EVENTS } from '../public/assets/events.js';

const DIMS = ['ev', 'path', 'ref', 'dev', 'quiz_step', 'quiz_skip', 'quiz_profile', 'ui', 'search', 'search_miss', 'open_src', 'open_rank',
  'rev', 'pay_fail', 'lead_purpose', 'lead_when', 'lead_third', 'plan_click', 'form_err', 'scroll', 'err'];
const REGION_EVENTS = ['region_open', 'compare_add', 'lead_open', 'lead_submit', 'report_open', 'source_click', 'correction_click', 'subscribe_submit'];
const UV_EVENTS = [...new Set(['any', ...KEY_EVENTS, ...Object.keys(EVENTS)])];
const VITALS = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'];
const DEVS = ['m', 't', 'd'];

export function dayRange(from, to) {
  const out = [];
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = new Date(`${from}T00:00:00Z`); d <= end && out.length < 400; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

const toHash = (flat) => {
  const o = {};
  for (let i = 0; i < (flat || []).length; i += 2) o[flat[i]] = Number(flat[i + 1]);
  return o;
};
const merge = (a, b) => { for (const [k, v] of Object.entries(b)) a[k] = (a[k] || 0) + v; return a; };
export function quantile(arr, q) {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
}

export async function readMetrics(run, days) {
  // 1단계: 날짜별 해시·셋·성능 표본
  const cmds = [];
  for (const d of days) {
    for (const dim of DIMS) cmds.push(['HGETALL', `a:${d}:${dim}`]);
    for (const e of REGION_EVENTS) cmds.push(['HGETALL', `a:${d}:r:${e}`]);
    cmds.push(['SMEMBERS', `idx:${d}:src`], ['SMEMBERS', `idx:${d}:exp`]);
    for (const v of VITALS) for (const dev of DEVS) cmds.push(['LRANGE', `v:${d}:${v}:${dev}`, '0', '999']);
  }
  const res = await run(cmds);
  let i = 0;
  const dims = Object.fromEntries(DIMS.map((k) => [k, {}]));
  const regions = Object.fromEntries(REGION_EVENTS.map((k) => [k, {}]));
  const srcs = new Set();
  const exps = new Set();
  const vitals = Object.fromEntries(VITALS.map((v) => [v, { m: [], t: [], d: [] }]));
  const evByDay = {};
  for (const d of days) {
    for (const dim of DIMS) { const h = toHash(res[i++]); merge(dims[dim], h); if (dim === 'ev') evByDay[d] = h; }
    for (const e of REGION_EVENTS) merge(regions[e], toHash(res[i++]));
    (res[i++] || []).forEach((s) => srcs.add(s));
    (res[i++] || []).forEach((s) => exps.add(s));
    for (const v of VITALS) for (const dev of DEVS) vitals[v][dev].push(...(res[i++] || []).map(Number));
  }

  // 2단계: 기간 전체 고유 방문자(날짜별 HLL 합집합)
  const pf = [];
  const keysFor = (suffix) => days.map((d) => `u:${d}:${suffix}`);
  for (const e of UV_EVENTS) pf.push([`uv:${e}`, ['PFCOUNT', ...keysFor(e)]]);
  pf.push(['sessions', ['PFCOUNT', ...days.map((d) => `s:${d}`)]]);
  for (const dev of DEVS) for (const e of KEY_EVENTS) pf.push([`dev:${dev}:${e}`, ['PFCOUNT', ...keysFor(`dev:${dev}:${e}`)]]);
  for (const s of srcs) for (const e of KEY_EVENTS) pf.push([`src:${s}:${e}`, ['PFCOUNT', ...keysFor(`src:${s}:${e}`)]]);
  for (const xv of exps) {
    const [x, v] = xv.split(':');
    for (const e of KEY_EVENTS) pf.push([`x:${x}:${v}:${e}`, ['PFCOUNT', ...keysFor(`x:${x}:${v}:${e}`)]]);
  }
  for (const d of days) {
    pf.push([`day:${d}:any`, ['PFCOUNT', `u:${d}:any`]]);
    pf.push([`day:${d}:convert`, ['PFCOUNT', `u:${d}:convert`]]);
    pf.push([`day:${d}:engaged`, ['PFCOUNT', `u:${d}:engaged`]]);
  }
  const counts = await run(pf.map(([, c]) => c));
  const n = Object.fromEntries(pf.map(([k], j) => [k, Number(counts[j] || 0)]));

  const uv = Object.fromEntries(UV_EVENTS.map((e) => [e, n[`uv:${e}`]]));
  const split = (prefix, keys) => Object.fromEntries(keys.map((k) => [k, Object.fromEntries(KEY_EVENTS.map((e) => [e, n[`${prefix}:${k}:${e}`] || 0]))]));
  const experiments = {};
  for (const xv of exps) {
    const [x, v] = xv.split(':');
    (experiments[x] ||= {})[v] = Object.fromEntries(KEY_EVENTS.map((e) => [e, n[`x:${x}:${v}:${e}`] || 0]));
  }
  const vitalSummary = {};
  for (const v of VITALS) {
    vitalSummary[v] = {};
    for (const dev of DEVS) {
      const arr = vitals[v][dev];
      if (arr.length) vitalSummary[v][dev] = { n: arr.length, p75: quantile(arr, 0.75), p50: quantile(arr, 0.5) };
    }
  }
  return {
    range: { from: days[0], to: days[days.length - 1], days: days.length },
    visitors: uv.any,
    sessions: n.sessions,
    events: dims.ev,
    uv,
    dims,
    regions,
    devices: split('dev', DEVS),
    sources: split('src', [...srcs]),
    experiments,
    vitals: vitalSummary,
    daily: days.map((d) => ({ d, visitors: n[`day:${d}:any`], engaged: n[`day:${d}:engaged`], convert: n[`day:${d}:convert`], pv: evByDay[d]?.page_view || 0 })),
  };
}
