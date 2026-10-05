// 이벤트 → 저장소 명령 변환. 서버 수집기와 오프라인 분석기가 같은 함수를 쓴다.
// 키 규칙 (d = YYYY-MM-DD, KST)
//   a:{d}:{dim}            해시. 차원별 카운트 (ev, path, ref, src, dev, quiz_step, ...)
//   a:{d}:r:{event}        해시. 지역 코드별 카운트
//   u:{d}:{metric}         HyperLogLog. 고유 방문자 (퍼널, 기기·유입·실험 분할)
//   s:{d}                  HyperLogLog. 세션
//   v:{d}:{vital}          리스트. 웹 성능 값 표본(최대 1,000개)
//   idx:{d}:{kind}         셋. 그날 나타난 실험 변형·유입경로 목록
//   raw:{d}                리스트. 원본 이벤트(최대 50,000건, 90일)
import { ENGAGED, INTENT, CONVERT, KEY_EVENTS } from '../public/assets/events.js';

export const TTL_AGG = 60 * 60 * 24 * 400;
export const TTL_RAW = 60 * 60 * 24 * 90;

export function kstDay(ms = Date.now()) {
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export function stages(e) {
  const out = [e];
  if (ENGAGED.has(e)) out.push('engaged');
  if (INTENT.has(e)) out.push('intent');
  if (CONVERT.has(e)) out.push('convert');
  return out;
}

export function normQuery(q) {
  return String(q || '').replace(/\s+/g, '').slice(0, 20);
}

// env: { vid, sid, dev, src, exp: {name: variant} }  ev: { e, p, path, t }
export function opsFor(env, ev, day) {
  const d = day;
  const ops = [];
  const touched = new Set();
  const H = (key, field, by = 1) => { ops.push(['HINCRBY', key, String(field), String(by)]); touched.add(key); };
  const U = (key, member) => { ops.push(['PFADD', key, member]); touched.add(key); };
  const S = (key, member) => { ops.push(['SADD', key, member]); touched.add(key); };
  const p = ev.p || {};

  H(`a:${d}:ev`, ev.e);
  U(`s:${d}`, env.sid);
  U(`u:${d}:any`, env.vid);
  for (const st of stages(ev.e)) {
    U(`u:${d}:${st}`, env.vid);
    if (KEY_EVENTS.includes(st)) {
      U(`u:${d}:dev:${env.dev}:${st}`, env.vid);
      U(`u:${d}:src:${env.src}:${st}`, env.vid);
      for (const [x, v] of Object.entries(env.exp || {})) U(`u:${d}:x:${x}:${v}:${st}`, env.vid);
    }
  }
  S(`idx:${d}:src`, env.src);
  for (const [x, v] of Object.entries(env.exp || {})) S(`idx:${d}:exp`, `${x}:${v}`);

  switch (ev.e) {
    case 'page_view':
      H(`a:${d}:path`, p.path || ev.path || '/');
      H(`a:${d}:dev`, env.dev);
      if (p.ref) H(`a:${d}:ref`, p.ref);
      break;
    case 'quiz_step': H(`a:${d}:quiz_step`, p.step); break;
    case 'quiz_skip': H(`a:${d}:quiz_skip`, p.step ?? 0); break;
    case 'quiz_complete': H(`a:${d}:quiz_profile`, p.profile || '?'); break;
    case 'profile_change': H(`a:${d}:ui`, `profile:${p.profile}`); break;
    case 'weight_change': H(`a:${d}:ui`, `weight:${p.factor}`); break;
    case 'filter_change': if (p.on !== false) H(`a:${d}:ui`, `filter:${p.filter}${p.value ? `=${p.value}` : ''}`); break;
    case 'sort_change': H(`a:${d}:ui`, `sort:${p.sort}`); break;
    case 'list_more': H(`a:${d}:ui`, 'list_more'); break;
    case 'search': {
      const q = normQuery(p.q);
      if (q) { H(`a:${d}:search`, q); if (!p.results) H(`a:${d}:search_miss`, q); }
      break;
    }
    case 'region_open': H(`a:${d}:open_src`, p.source || '?'); if (p.rank) H(`a:${d}:open_rank`, p.rank <= 5 ? '1-5' : p.rank <= 20 ? '6-20' : '21+'); break;
    case 'payment_success': H(`a:${d}:rev`, 'krw', Math.round(p.amount || 0)); H(`a:${d}:rev`, 'orders'); break;
    case 'payment_fail': H(`a:${d}:pay_fail`, p.code || '?'); break;
    case 'lead_submit': H(`a:${d}:lead_purpose`, p.purpose || '미입력'); H(`a:${d}:lead_when`, p.when || '미입력'); if (p.third) H(`a:${d}:lead_third`, 'yes'); break;
    case 'partner_plan_click': H(`a:${d}:plan_click`, p.plan); break;
    case 'form_error': H(`a:${d}:form_err`, `${p.form}:${p.field}`); break;
    case 'scroll_depth': H(`a:${d}:scroll`, `${ev.path || '/'}|${p.pct}`); break;
    case 'js_error': H(`a:${d}:err`, (p.msg || '?').slice(0, 80)); break;
    case 'vital':
      if (['LCP', 'CLS', 'INP', 'FCP', 'TTFB'].includes(p.name)) {
        ops.push(['LPUSH', `v:${d}:${p.name}:${env.dev}`, String(p.value)], ['LTRIM', `v:${d}:${p.name}:${env.dev}`, '0', '999']);
        touched.add(`v:${d}:${p.name}:${env.dev}`);
      }
      break;
    default: break;
  }
  if (p.code) H(`a:${d}:r:${ev.e}`, p.code);
  for (const k of touched) ops.push(['EXPIRE', k, String(TTL_AGG)]);
  return ops;
}

export function rawOps(day, records) {
  if (!records.length) return [];
  return [
    ['LPUSH', `raw:${day}`, ...records.map((r) => JSON.stringify(r))],
    ['LTRIM', `raw:${day}`, '0', '49999'],
    ['EXPIRE', `raw:${day}`, String(TTL_RAW)],
  ];
}
