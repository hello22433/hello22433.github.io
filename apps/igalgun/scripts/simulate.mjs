// 가상 트래픽 생성기. 분석 파이프라인과 인사이트 규칙을 검증하는 용도이며 실제 데이터가 아니다.
//   node scripts/simulate.mjs --visitors 3000 --days 14 --out sim.ndjson
//   node scripts/simulate.mjs --visitors 300 --post http://localhost:3000/api   (수집 API로 직접 전송)
// 일부러 약점을 심어 둔다: 모바일 탐색률 낮음, 진단 3번 문항 이탈, 관심지역 검색 실패, 모바일 LCP 느림,
// hero_cta=browse 변형이 탐색률이 더 높음.
import { readFileSync, writeFileSync } from 'node:fs';
import { EXPERIMENTS, variantFor } from '../public/assets/events.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const N = Number(args.visitors || 2000);
const DAYS = Number(args.days || 14);
const regions = JSON.parse(readFileSync(new URL('../public/data/regions.json', import.meta.url))).regions;

let seed = Number(args.seed || 42);
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
const id = () => Array.from({ length: 16 }, () => '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(rnd() * 36)]).join('');
// 인기 지역 가중치: 기본소득 지역과 인구 증가 지역이 더 많이 열린다
const weighted = regions.map((r) => [r, 1 + (r.basic_income ? 3 : 0) + Math.max(0, r.chg12m)]);
const totalW = weighted.reduce((a, [, w]) => a + w, 0);
const region = () => { let x = rnd() * totalW; for (const [r, w] of weighted) { x -= w; if (x <= 0) return r; } return regions[0]; };

const now = Date.now();
const batches = [];
for (let i = 0; i < N; i++) {
  const vid = id();
  const sid = id();
  const dev = chance(0.62) ? 'm' : chance(0.1) ? 't' : 'd';
  const src = pick(['direct', 'direct', 'naver', 'naver', 'naver', 'google', 'cafe.naver', 'instagram', 'band', 'youtube']);
  const exp = Object.fromEntries(Object.keys(EXPERIMENTS).map((x) => [x, variantFor(x, vid)]));
  let t = now - Math.floor(rnd() * DAYS) * 86_400_000 - Math.floor(rnd() * 80_000_000);
  const ev = [];
  const push = (e, p = {}, path = '/') => { t += 2000 + Math.floor(rnd() * 20000); ev.push({ e, p, path, t }); };
  const landing = chance(0.3) ? `/region/${region().code}` : '/';
  push('page_view', { path: landing, ref: src }, landing);
  push('exp_expose', { exp: 'hero_cta', variant: exp.hero_cta });
  push('vital', { name: 'LCP', value: dev === 'm' ? 2600 + rnd() * 2600 : 900 + rnd() * 1200 });
  push('vital', { name: 'CLS', value: rnd() * 0.08 });
  const engage = (dev === 'm' ? 0.28 : 0.55) + (exp.hero_cta === 'browse' ? 0.08 : 0);
  if (chance(0.45)) {
    push('quiz_start');
    const profile = pick(['remote', 'remote', 'family', 'farm', 'retire', 'retire']);
    if (chance(0.85)) { push('quiz_step', { step: 1 });
      if (chance(0.55)) { push('quiz_step', { step: 2 });
        if (chance(0.9)) { push('quiz_step', { step: 3 }); if (chance(0.95)) push('quiz_complete', { profile }); }
      } else if (chance(0.3)) push('quiz_skip', { step: 2 });
    }
  }
  if (chance(0.25)) push('filter_change', { filter: pick(['bi', 'bi', 'ktx', 'seoul']), on: true });
  if (chance(0.15)) { const q = pick(['정선', '남해', '옥천', '강릉', '속초', '강릉', '양평', '제천']); push('search', { q, results: ['강릉', '속초', '양평'].includes(q) ? 0 : 1 }); }
  if (chance(engage)) {
    const opened = [];
    const k = 1 + Math.floor(rnd() * 4);
    for (let j = 0; j < k; j++) {
      const r = region();
      opened.push(r);
      push('region_open', { code: r.code, source: pick(['list', 'list', 'list', 'map', 'search']), rank: 1 + Math.floor(rnd() * (chance(0.7) ? 5 : 40)) }, `/region/${r.code}`);
      push('scroll_depth', { pct: 25 }, `/region/${r.code}`);
      if (chance(0.6)) push('scroll_depth', { pct: 50 }, `/region/${r.code}`);
      if (chance(0.3)) push('scroll_depth', { pct: 75 }, `/region/${r.code}`);
      if (chance(0.05)) push('source_click', { code: r.code, kind: 'youth' }, `/region/${r.code}`);
    }
    if (chance(0.3)) {
      opened.slice(0, 3).forEach((r) => push('compare_add', { code: r.code }));
      if (opened.length > 1 && chance(0.6)) push('compare_open', { n: Math.min(3, opened.length) });
    }
    const lr = opened[0];
    push('exp_expose', { exp: 'lead_cta', variant: exp.lead_cta }, `/region/${lr.code}`);
    if (chance(0.12)) {
      push('lead_open', { code: lr.code }, `/region/${lr.code}`);
      if (chance(0.15)) push('form_error', { form: 'lead', field: 'contact' }, `/region/${lr.code}`);
      if (chance(exp.lead_cta === 'question' ? 0.42 : 0.3)) push('lead_submit', { code: lr.code, purpose: pick(['귀촌·전원생활', '귀농', '원격근무·이직', '은퇴']), when: pick(['3개월 이내', '1년 이내', '1년 이내', '1~3년', '정해지지 않음']), third: chance(0.55) }, `/region/${lr.code}`);
    }
    if (chance(0.08)) {
      push('report_open', { code: lr.code }, '/report');
      push('report_preview', { n: 1, profile: 'remote' }, '/report');
      if (chance(0.25)) push('subscribe_submit', { topic: 'report_launch' }, '/report');
    }
  }
  if (chance(0.01)) push('js_error', { msg: "TypeError: Cannot read properties of null @app.js:212" });
  batches.push({ vid, sid, dev, src, exp, events: ev });
}

if (args.post) {
  let sent = 0;
  for (const b of batches) {
    for (let i = 0; i < b.events.length; i += 40) {
      const res = await fetch(`${args.post}/collect`, { method: 'POST', body: JSON.stringify({ ...b, events: b.events.slice(i, i + 40).map((e) => ({ ...e, t: Date.now() })) }), headers: { 'Content-Type': 'text/plain', 'User-Agent': 'igalgun-simulator', 'x-forwarded-for': `10.1.${Math.floor(sent / 250) % 250}.${sent % 250}` } });
      if (res.status >= 400) throw new Error(`collect ${res.status}`);
      sent++;
    }
  }
  console.log(`posted ${batches.length} visitors in ${sent} batches`);
} else {
  const lines = batches.flatMap((b) => b.events.map((e) => JSON.stringify({ ...e, vid: b.vid, sid: b.sid, dev: b.dev, src: b.src, exp: b.exp })));
  writeFileSync(args.out || 'sim.ndjson', `${lines.join('\n')}\n`);
  console.log(`wrote ${lines.length} events from ${N} visitors → ${args.out || 'sim.ndjson'}`);
}
