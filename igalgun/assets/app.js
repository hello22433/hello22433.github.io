// 메인 화면: 진단 → 순위·지도 → 상세 서랍 → 비교함.
import { loadData, $, $$, fmt, pct, esc, store, toast, track, variant, url, applyExperiments, markOffline } from './common.js';
import { FACTORS, PROFILES, scoreAll, supportTotal, won, josa } from './score.js';

const { regions: R, map: MAP } = await loadData();
const byCode = new Map(R.map((r) => [r.code, r]));
const PAGE = 20;

const defaults = () => ({ profile: 'remote', w: { ...PROFILES[0].w }, sido: '', bi: false, ktx: false, seoul: false, sort: 'score', cmp: [], quizDone: false });
let state = { ...defaults(), ...(store.get('state') || {}) };
state.cmp = (state.cmp || []).filter((c) => byCode.has(c));
let shown = PAGE;
let scored = new Map();

window.igg = { openRegion, profile: () => state.profile };

function save() { store.set('state', state); }

/* ---------- 점수 ---------- */
function compute() {
  const out = scoreAll(R, state.profile, state.w);
  scored = new Map(out.map((s) => [s.code, s]));
}
const S = (r) => scored.get(r.code);
function visible(r) {
  if (state.sido && r.sido !== state.sido) return false;
  if (state.bi && !r.basic_income) return false;
  if (state.ktx && r.ktx_km > 20) return false;
  if (state.seoul && r.seoul_km > 150) return false;
  return true;
}
const prof = () => PROFILES.find((p) => p.id === state.profile) || PROFILES[0];
const SORTS = {
  score: (a, b) => S(b).score - S(a).score || b.pop - a.pop,
  chg12m: (a, b) => b.chg12m - a.chg12m,
  money: (a, b) => (supportTotal(b, prof().sup) || 0) - (supportTotal(a, prof().sup) || 0),
  med: (a, b) => b.clinic_per10k - a.clinic_per10k,
  ktx: (a, b) => a.ktx_km - b.ktx_km,
};
const ranked = () => R.filter(visible).sort(SORTS[state.sort] || SORTS.score);

function whyText(r) {
  const s = S(r);
  const parts = FACTORS.filter((F) => (state.w[F.k] || 0) > 0)
    .map((F) => ({ F, v: s.f[F.k], c: s.f[F.k] * state.w[F.k] }))
    .sort((a, b) => b.c - a.c)
    .slice(0, 2)
    .map(({ F, v }) => `<span>${F.label} <b>상위 ${Math.max(1, Math.round((1 - v) * 100))}%</b></span>`);
  return parts.join('');
}

/* ---------- 프로필·필터 ---------- */
const profEl = $('#profiles');
profEl.innerHTML = PROFILES.map((p) => `<button class="chip" type="button" id="p-${p.id}" data-p="${p.id}">${p.name} <small>${p.sub}</small></button>`).join('');
profEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-p]');
  if (!b) return;
  state.profile = b.dataset.p;
  state.w = { ...prof().w };
  track('profile_change', { profile: state.profile });
  update(true);
});
$('#sliders').innerHTML = FACTORS.map((F) => `<div class="sl"><label for="w-${F.k}">${F.label} <b id="wv-${F.k}"></b></label><input type="range" id="w-${F.k}" min="0" max="5" step="1" data-k="${F.k}" aria-describedby="wh-${F.k}"><span class="sr" id="wh-${F.k}">${F.hint}</span></div>`).join('');
$('#sliders').addEventListener('input', (e) => {
  const k = e.target.dataset.k;
  if (!k) return;
  state.w[k] = Number(e.target.value);
  update(true);
});
$('#sliders').addEventListener('change', (e) => { if (e.target.dataset.k) track('weight_change', { factor: e.target.dataset.k, value: Number(e.target.value) }); });
const sidos = [...new Set(R.map((r) => r.sido))];
$('#f-sido').insertAdjacentHTML('beforeend', sidos.map((s) => `<option value="${s}">${s}</option>`).join(''));
$('#f-sido').addEventListener('change', (e) => { state.sido = e.target.value; track('filter_change', { filter: 'sido', on: Boolean(state.sido), value: state.sido }); update(true); });
$('#f-sort').addEventListener('change', (e) => { state.sort = e.target.value; track('sort_change', { sort: state.sort }); update(true); });
for (const k of ['bi', 'ktx', 'seoul']) {
  $(`#f-${k}`).addEventListener('click', () => { state[k] = !state[k]; track('filter_change', { filter: k, on: state[k] }); update(true); });
}
$('#resetAll').addEventListener('click', () => { const keep = state.cmp; state = { ...defaults(), cmp: keep, quizDone: true }; update(true); toast('조건을 초기화했습니다'); });
$('#moreBtn').addEventListener('click', () => { shown += PAGE; track('list_more', { shown }); renderList(); });

function syncControls() {
  PROFILES.forEach((p) => $(`#p-${p.id}`).setAttribute('aria-pressed', String(state.profile === p.id)));
  FACTORS.forEach((F) => { $(`#w-${F.k}`).value = state.w[F.k] ?? 0; $(`#wv-${F.k}`).textContent = state.w[F.k] ?? 0; });
  $('#f-sido').value = state.sido;
  $('#f-sort').value = state.sort;
  for (const k of ['bi', 'ktx', 'seoul']) $(`#f-${k}`).setAttribute('aria-pressed', String(state[k]));
}

/* ---------- 목록 ---------- */
function tags(r) {
  let t = '';
  if (r.basic_income) t += '<span class="tag bi">기본소득</span>';
  t += r.cls === '특별' ? '<span class="tag sp">특별지원</span>' : '<span class="tag">우대지원</span>';
  return t;
}
function renderList() {
  const rows = ranked();
  $('#count').textContent = `${rows.length}곳${state.sort === 'score' ? ' · 맞춤 점수순' : ''}`;
  const ol = $('#rank');
  if (!rows.length) {
    ol.innerHTML = '<li class="empty">조건에 맞는 지역이 없습니다. 조건을 하나 풀어 보세요.</li>';
    $('#moreBtn').hidden = true;
    return;
  }
  ol.innerHTML = rows.slice(0, shown).map((r, i) => {
    const s = S(r);
    const inCmp = state.cmp.includes(r.code);
    return `<li class="card" data-code="${r.code}">
      <span class="rk">${i + 1}</span>
      <div>
        <div class="nm"><a href="${url(`/region/${r.code}/`)}" data-code="${r.code}">${esc(r.name)}</a><small>${esc(r.sido)}</small>${tags(r)}</div>
        <div class="why">${whyText(r)}</div>
      </div>
      <div class="side">
        <span class="score" title="맞춤 점수"><span class="bar"><i style="width:${s.score}%"></i></span><span class="v">${s.score}</span></span>
        <button class="btn sm" type="button" data-cmp="${r.code}" aria-pressed="${inCmp}">${inCmp ? '비교 담김' : '비교 담기'}</button>
      </div>
      <div class="stats"><span>인구 <span class="num">${fmt(r.pop)}</span></span>
        <span>1년 <span class="num ${r.chg12m >= 0 ? 'up' : 'dn'}">${pct(r.chg12m)}</span></span>
        <span>20~39세 <span class="num">${r.young}%</span></span>
        <span>${esc(r.ktx_name)} <span class="num">${r.ktx_km}km</span></span>
        <span>병·의원 <span class="num">${r.clinic_per10k}</span>/만 명</span></div>
    </li>`;
  }).join('');
  $('#moreBtn').hidden = rows.length <= shown;
}
$('#rank').addEventListener('click', (e) => {
  const c = e.target.closest('[data-cmp]');
  if (c) { toggleCmp(c.dataset.cmp); return; }
  const a = e.target.closest('a[data-code]');
  const card = e.target.closest('.card');
  const rank = Number(card?.querySelector('.rk')?.textContent) || undefined;
  if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); openRegion(a.dataset.code, { source: 'list', rank }); return; }
  if (card && !e.target.closest('a,button')) openRegion(card.dataset.code, { source: 'list', rank });
});

/* ---------- 지도 ---------- */
const NS = 'http://www.w3.org/2000/svg';
const svg = $('#map');
const proj = (lon, lat) => [(lon - MAP.proj.lon0) * MAP.proj.k * MAP.proj.sc, (MAP.proj.lat1 - lat) * MAP.proj.sc];
const el = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
MAP.paths.forEach((d) => svg.appendChild(el('path', { d, class: 'land' })));
const gPts = el('g', {});
const gLbl = el('g', {});
svg.append(gPts, gLbl);
const nodes = {};
[...R].sort((a, b) => b.pop - a.pop).forEach((r) => {
  const [x, y] = proj(r.lon, r.lat);
  const rad = 3 + Math.sqrt(r.pop) / 45;
  const c = el('circle', { cx: x, cy: y, r: rad.toFixed(1), class: 'pt' });
  const h = el('circle', { cx: x, cy: y, r: Math.max(rad, 9), class: 'hit', tabindex: '0', role: 'button', 'aria-label': `${r.sido} ${r.name}` });
  h.addEventListener('mouseenter', () => showTip(r, x, y));
  h.addEventListener('focus', () => showTip(r, x, y));
  h.addEventListener('mouseleave', hideTip);
  h.addEventListener('blur', hideTip);
  h.addEventListener('click', () => openRegion(r.code, { source: 'map' }));
  h.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRegion(r.code, { source: 'map' }); } });
  gPts.append(c, h);
  nodes[r.code] = { c, x, y, rad };
});
const SEQ = ['--seq1', '--seq2', '--seq3', '--seq4', '--seq5'];
function renderMap() {
  const top = ranked().slice(0, 5).map((r) => r.code);
  gLbl.replaceChildren();
  for (const r of R) {
    const n = nodes[r.code];
    n.c.style.fill = `var(${SEQ[Math.min(4, Math.floor(S(r).score / 20.0001))]})`;
    n.c.classList.toggle('dim', !visible(r));
    n.c.classList.toggle('sel', current === r.code);
  }
  for (const code of new Set([...top, current].filter(Boolean))) {
    const n = nodes[code];
    const t = el('text', { x: n.x + n.rad + 3, y: n.y + 4, class: 'lbl' });
    t.textContent = byCode.get(code).name;
    gLbl.appendChild(t);
  }
}
const tip = $('#tip');
function showTip(r, x, y) {
  const box = svg.getBoundingClientRect();
  const s = box.width / 520;
  tip.innerHTML = `<b>${esc(r.sido)} ${esc(r.name)}</b>맞춤 점수 <span class="num">${S(r).score}</span> · 인구 <span class="num">${fmt(r.pop)}</span><br>1년 <span class="num">${pct(r.chg12m)}</span> · KTX <span class="num">${r.ktx_km}km</span>${r.basic_income ? '<br>농어촌 기본소득 지역' : ''}`;
  tip.hidden = false;
  tip.style.left = `${Math.min(x * s + 16, box.width - 190)}px`;
  tip.style.top = `${y * s + 10}px`;
}
function hideTip() { tip.hidden = true; }

/* ---------- 모바일 목록/지도 전환 ---------- */
const finder = $('#finder');
for (const [id, view] of [['tabList', 'list'], ['tabMap', 'map']]) {
  $(`#${id}`).addEventListener('click', () => {
    finder.dataset.view = view;
    $('#tabList').setAttribute('aria-selected', String(view === 'list'));
    $('#tabMap').setAttribute('aria-selected', String(view === 'map'));
  });
}

/* ---------- 상세 서랍 ---------- */
const drawer = $('#drawer');
let current = null;
let pushed = false;
const pageCache = new Map();
async function openRegion(code, { push = true, source = 'list', rank } = {}) {
  if (!byCode.has(code)) return;
  current = code;
  renderMap();
  $$('.card').forEach((c) => c.classList.toggle('sel', c.dataset.code === code));
  const r = byCode.get(code);
  $('#drawerLink').href = url(`/region/${code}/`);
  syncDrawerCompare();
  if (!drawer.open) drawer.showModal();
  drawer.scrollTop = 0;
  if (push && location.pathname !== url(`/region/${code}/`)) {
    history.pushState({ code }, '', url(`/region/${code}/`));
    pushed = true;
  }
  document.title = `${r.sido} ${r.name} 이주·정착 지원 · 이사갈군`;
  if (push) track('region_open', { code, source, rank });
  const body = $('#drawerBody');
  try {
    if (!pageCache.has(code)) {
      const res = await fetch(url(`/region/${code}/`));
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const art = doc.querySelector('article#region');
      if (!art) throw new Error('no article');
      art.querySelector('.crumbs')?.remove();
      pageCache.set(code, art.innerHTML);
    }
    if (current === code) body.innerHTML = pageCache.get(code);
    const s = S(r);
    body.querySelector('.rhead h1')?.insertAdjacentHTML('beforeend', ` <small>맞춤 점수 ${s.score}</small>`);
    body.querySelectorAll('.related a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openRegion(a.getAttribute('href').split('/').filter(Boolean).pop(), { source: 'related' }); }));
    applyExperiments(body);
    markOffline(body);
  } catch {
    body.innerHTML = `<p class="empty">상세 정보를 불러오지 못했습니다. <a href="${url(`/region/${code}/`)}">지역 페이지로 이동</a></p>`;
  }
}
function closeDrawer() {
  current = null;
  renderMap();
  $$('.card.sel').forEach((c) => c.classList.remove('sel'));
  document.title = '이사갈군 · 인구감소지역 89곳, 나에게 맞는 이주지 찾기';
  if (pushed && location.pathname.startsWith(url('/region/'))) { pushed = false; history.back(); }
  else if (location.pathname !== url('/')) history.replaceState({}, '', url('/'));
}
drawer.addEventListener('close', closeDrawer);
drawer.addEventListener('click', (e) => { if (e.target === drawer) drawer.close(); });
window.addEventListener('popstate', (e) => {
  const code = e.state?.code;
  if (code) openRegion(code, { push: false });
  else if (drawer.open) { pushed = false; drawer.close(); }
});
$('#drawerCompare').addEventListener('click', () => { if (current) toggleCmp(current); });
function syncDrawerCompare() {
  const on = state.cmp.includes(current);
  const b = $('#drawerCompare');
  b.textContent = on ? '비교 담김' : '비교에 담기';
  b.setAttribute('aria-pressed', String(on));
}

/* ---------- 비교함 ---------- */
function toggleCmp(code) {
  if (state.cmp.includes(code)) { state.cmp = state.cmp.filter((c) => c !== code); track('compare_remove', { code }); }
  else {
    if (state.cmp.length >= 3) { toast('비교함에는 3곳까지 담을 수 있습니다'); return; }
    state.cmp.push(code);
    track('compare_add', { code });
    toast(`${josa(byCode.get(code).name, '을', '를')} 비교함에 담았습니다`);
  }
  save();
  renderList();
  renderTray();
  syncDrawerCompare();
}
function renderTray() {
  const tray = $('#tray');
  tray.hidden = state.cmp.length === 0;
  $('#trayItems').innerHTML = state.cmp.map((c) => `<span class="it">${esc(byCode.get(c).name)}<button type="button" data-rm="${c}" aria-label="${esc(byCode.get(c).name)} 빼기">×</button></span>`).join('');
  $('#openCompare').disabled = state.cmp.length < 2;
  $('#openCompare').textContent = state.cmp.length < 2 ? '한 곳 더 담기' : `${state.cmp.length}곳 비교하기`;
}
$('#trayItems').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) toggleCmp(b.dataset.rm); });
$('#openCompare').addEventListener('click', () => { renderCompare(); track('compare_open', { n: state.cmp.length }); $('#compareDlg').showModal(); });
function renderCompare() {
  const rs = state.cmp.map((c) => byCode.get(c));
  const rows = [
    ['맞춤 점수', (r) => S(r).score, 1],
    ['인구 (2026.9)', (r) => r.pop, 0, fmt],
    ['1년 인구 변화', (r) => r.chg12m, 1, (v) => pct(v, 2)],
    ['10년 인구 변화', (r) => r.chg10, 1, (v) => pct(v)],
    ['20~39세 비율', (r) => r.young, 1, (v) => `${v}%`],
    ['65세 이상 비율', (r) => r.old, -1, (v) => `${v}%`],
    ['인구 1만 명당 병·의원', (r) => r.clinic_per10k, 1],
    ['소아과 전문의 기관', (r) => r.med.ped, 1],
    ['산부인과 전문의 기관', (r) => r.med.obgyn, 1],
    ['가까운 KTX역 (km)', (r) => r.ktx_km, -1],
    ['서울 직선거리 (km)', (r) => r.seoul_km, -1],
    ['농어촌 기본소득 (월)', (r) => r.bi_monthly || 0, 1, (v) => (v ? won(v) : '–')],
    ['조사된 지원 합계', (r) => supportTotal(r, prof().sup), 1, (v) => (v ? won(v) : '–')],
    ['출산지원 첫째 (지자체)', (r) => r.inc?.birth?.first ?? null, 1, (v) => won(v) || '–'],
  ];
  let h = `<div class="tblwrap"><table><thead><tr><th>지표</th>${rs.map((r) => `<th>${esc(r.sido)} ${esc(r.name)}</th>`).join('')}</tr></thead><tbody>`;
  for (const [label, get, dir, f] of rows) {
    const vs = rs.map(get);
    const nums = vs.filter((v) => v != null);
    const best = dir && nums.length > 1 && new Set(nums).size > 1 ? (dir > 0 ? Math.max(...nums) : Math.min(...nums)) : null;
    h += `<tr><td>${label}</td>${vs.map((v) => `<td class="num">${v == null ? '–' : `<span class="${v === best ? 'best' : ''}">${f ? f(v) : v}</span>`}</td>`).join('')}</tr>`;
  }
  $('#compareBody').innerHTML = `${h}</tbody></table></div><p class="note">초록색이 더 나은 값입니다. 지원 합계는 조사된 최대 금액과 기본소득 2년분을 더한 값입니다.</p>`;
  $('#compareReport').href = url(`/report/?regions=${state.cmp.join(',')}&profile=${state.profile}`);
}

/* ---------- 진단(퀴즈) ---------- */
const quizWrap = $('#quizWrap');
const quiz = $('#quiz');
const steps = $$('fieldset', quiz);
let step = 0;
let maxStep = 0;
function showStep(i) {
  step = i;
  steps.forEach((f, k) => { f.hidden = k !== i; });
  $$('.progress i', quiz).forEach((b, k) => b.classList.toggle('on', k <= i));
  $('#quizBack').style.visibility = i ? 'visible' : 'hidden';
  $('#quizNext').textContent = i === steps.length - 1 ? '결과 보기' : '다음';
  if (i > maxStep) { maxStep = i; track('quiz_step', { step: i }); }
  steps[i].querySelector('input')?.focus();
}
function startQuiz() { quizWrap.hidden = false; maxStep = 0; track('quiz_start', {}); showStep(0); quizWrap.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
$('#startQuiz').addEventListener('click', startQuiz);
$('#quizBack').addEventListener('click', () => showStep(Math.max(0, step - 1)));
$('#quizSkip').addEventListener('click', () => { track('quiz_skip', { step }); quizWrap.hidden = true; state.quizDone = true; save(); $('#finder').scrollIntoView({ behavior: 'smooth' }); });
quiz.addEventListener('change', (e) => {
  if (e.target.name === 'prio') {
    const on = $$('input[name=prio]:checked', quiz);
    if (on.length > 2) { e.target.checked = false; toast('두 가지까지 고를 수 있습니다'); }
  } else if (e.target.type === 'radio' && step < steps.length - 1) {
    setTimeout(() => showStep(step + 1), 180);
  }
});
$('#quizNext').addEventListener('click', () => {
  if (step < steps.length - 1) { showStep(step + 1); return; }
  applyQuiz(new FormData(quiz));
});
function applyQuiz(fd) {
  const who = fd.get('who');
  const work = fd.get('work');
  const prio = fd.getAll('prio');
  const metro = fd.get('metro');
  let profile = 'remote';
  if (work === 'farm') profile = 'farm';
  else if (work === 'retire') profile = 'retire';
  else if (who === 'kids') profile = 'family';
  const w = { ...PROFILES.find((p) => p.id === profile).w };
  if (work === 'local') { w.vital += 1; w.peer += 1; }
  if (who === 'kids') w.kids = Math.max(w.kids, 3);
  if (who === 'parents') w.med += 2;
  for (const k of prio) w[k] = (w[k] || 0) + 2;
  if (metro === 'sometimes') w.move += 2;
  if (metro === 'rarely') w.move = Math.max(0, w.move - 2);
  for (const k of Object.keys(w)) w[k] = Math.min(5, w[k]);
  state = { ...state, profile, w, seoul: metro === 'often', quizDone: true, sort: 'score' };
  track('quiz_complete', { profile });
  quizWrap.hidden = true;
  update(true);
  $('#weights').open = true;
  $('#finder').scrollIntoView({ behavior: 'smooth' });
  const top = ranked()[0];
  if (top) toast(`가장 잘 맞는 곳: ${top.sido} ${top.name}`);
}

/* ---------- 연결 ---------- */
function update(resetPaging) {
  if (resetPaging) shown = PAGE;
  compute();
  syncControls();
  renderList();
  renderMap();
  renderTray();
  save();
}
update();
const initial = new URLSearchParams(location.search).get('r');
if (initial && byCode.has(initial)) openRegion(initial, { source: 'link' });
if (location.hash === '#quiz' || (!state.quizDone && !initial && !store.get('seenQuizHint'))) {
  store.set('seenQuizHint', true);
}
if (location.hash === '#quiz') startQuiz();

/* ---------- A/B 실험: 첫 화면 주 버튼 ---------- */
if (variant('hero_cta') === 'browse') {
  const quizBtn = $('#startQuiz');
  const browse = quizBtn.nextElementSibling;
  quizBtn.classList.remove('primary');
  browse.classList.add('primary');
  browse.textContent = '순위 바로 보기';
  quizBtn.textContent = '30초 진단';
  quizBtn.parentElement.insertBefore(browse, quizBtn);
}
