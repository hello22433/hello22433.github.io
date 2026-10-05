// 운영 대시보드: 행동 로그 지표, 자동 개선 과제, 지역 영업 우선순위, 실험, 품질, 내보내기.
import { $, $$, esc, fmt, API, toast } from './common.js';

let token = '';
try { token = sessionStorage.getItem('igg:admin') || ''; } catch { /* 저장 불가 */ }
$('#tok').value = token;
let days = 7;
let data = null;

const msg = (t) => { const m = $('#adminMsg'); m.hidden = false; m.className = 'formmsg err'; m.textContent = t; };
const auth = () => ({ Authorization: `Bearer ${token}` });
const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '–' : `${(x * 100).toFixed(d)}%`);
const rate = (a, b) => (b > 0 ? a / b : null);
const sortDesc = (h) => Object.entries(h || {}).sort((a, b) => b[1] - a[1]);
const SEV = { high: ['긴급', 'bad'], mid: ['중요', 'warn'], low: ['개선', 'ok'], info: ['참고', 'info'] };
const PROFILE = { remote: '청년·원격근무', family: '신혼·아이 계획', farm: '귀농·귀촌', retire: '은퇴 후 전원생활' };
const SRC = { list: '목록', map: '지도', search: '검색', related: '가까운 지역', link: '공유 링크', page: '지역 페이지', internal: '사이트 안 이동', landing: '외부 유입(첫 페이지)' };
const DEV = { m: '모바일', t: '태블릿', d: '데스크톱' };

if (!API) msg('이 배포에는 API가 연결되어 있지 않습니다. Vercel 배포 주소의 /admin 에서 여세요.');

function hbars(el, entries, label = (k) => k) {
  const max = Math.max(1, ...entries.map(([, v]) => v));
  el.innerHTML = entries.length
    ? entries.map(([k, v, note]) => `<div><span>${esc(label(k))}</span><i><s style="width:${(v / max) * 100}%"></s></i><span class="num">${fmt(v)}${note ? ` <small>${esc(note)}</small>` : ''}</span></div>`).join('')
    : '<p class="empty">아직 기록이 없습니다.</p>';
}
function table(el, head, rows) {
  el.innerHTML = `<thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.length ? rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? 'num' : ''}">${c}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${head.length}" class="empty">아직 기록이 없습니다.</td></tr>`}</tbody>`;
}
function findingCard(f) {
  const [label, cls] = SEV[f.severity] || SEV.info;
  return `<article class="finding ${cls}"><div class="fhead"><span class="sev ${cls}">${label}</span><span class="tag">${esc(f.area)}</span><h3>${esc(f.title)}</h3></div>
    <p class="ev">${esc(f.evidence)}</p><p class="act"><b>할 일</b> ${esc(f.action)}</p></article>`;
}

function dailyChart(rows) {
  const svg = $('#dailyChart');
  const W = 560, H = 200, pl = 34, pr = 26, pt = 12, pb = 24;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  if (!rows.length) { svg.innerHTML = ''; return; }
  const mx = Math.max(4, ...rows.map((r) => r.visitors));
  const X = (i) => pl + (rows.length === 1 ? (W - pl - pr) / 2 : (i * (W - pl - pr)) / (rows.length - 1));
  const Y = (v) => pt + (1 - v / mx) * (H - pt - pb);
  const line = (k) => rows.map((r, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(r[k]).toFixed(1)}`).join('');
  const ticks = [0, Math.round(mx / 2), mx];
  let s = ticks.map((t) => `<line class="gd" x1="${pl}" x2="${W - pr}" y1="${Y(t)}" y2="${Y(t)}"/><text x="${pl - 6}" y="${Y(t) + 3}" text-anchor="end">${t}</text>`).join('');
  s += `<path d="${line('visitors')}" fill="none" stroke="var(--rice)" stroke-width="2"/><path d="${line('convert')}" fill="none" stroke="var(--clay)" stroke-width="2"/>`;
  rows.forEach((r, i) => { s += `<circle cx="${X(i)}" cy="${Y(r.visitors)}" r="3" fill="var(--rice)"><title>${r.d} 방문자 ${r.visitors}, 전환 ${r.convert}</title></circle>`; });
  const step = Math.ceil(rows.length / 6);
  rows.forEach((r, i) => { if (i % step === 0 || i === rows.length - 1) s += `<text x="${X(i)}" y="${H - 6}" text-anchor="middle">${r.d.slice(5)}</text>`; });
  svg.innerHTML = s;
}

function render() {
  const { metrics: m, insights: ins, truth } = data;
  const k = ins.kpis;
  $('#kpis').innerHTML = [
    ['방문자', fmt(k.visitors)], ['세션', fmt(k.sessions)], ['탐색률', pct(k.engagedRate)], ['전환율', pct(k.convertRate)],
    ['상담 신청 (누적)', fmt(truth.leads)], ['파트너 문의 (누적)', fmt(truth.partners)], ['구독자 (누적)', fmt(truth.subscribers)], ['매출 (기간)', `${fmt(k.revenue)}원`],
  ].map(([l, v]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');
  dailyChart(ins.daily || []);
  hbars($('#funnel'), ins.funnel.map((s) => [s.label, s.uv, s.fromPrev != null && s.key !== 'page_view' ? `이전 대비 ${pct(s.fromPrev, 0)}` : '']));
  const actionable = ins.findings.filter((f) => f.severity !== 'info');
  $('#topFindings').innerHTML = (actionable.length ? actionable : ins.findings).slice(0, 3).map(findingCard).join('') || '<p class="empty">아직 뽑을 과제가 없습니다.</p>';
  $('#findings').innerHTML = ins.findings.map(findingCard).join('') || '<p class="empty">아직 뽑을 과제가 없습니다.</p>';

  const qs = m.dims.quiz_step || {};
  hbars($('#quizBars'), [['1. 누구와', m.uv.quiz_start || 0], ['2. 일 방식', qs[1] || 0], ['3. 우선순위', qs[2] || 0], ['4. 수도권 왕래', qs[3] || 0], ['완료', m.events.quiz_complete || 0]]);
  hbars($('#profileBars'), sortDesc(m.dims.quiz_profile), (x) => PROFILE[x] || x);
  const UI = { 'filter:bi': '조건: 기본소득 지역', 'filter:ktx': '조건: KTX 20km', 'filter:seoul': '조건: 서울 150km', list_more: '목록 더 보기' };
  hbars($('#uiBars'), sortDesc(m.dims.ui).slice(0, 12), (x) => UI[x] || x.replace(/^filter:sido=/, '권역: ').replace(/^sort:/, '정렬: ').replace(/^weight:/, '가중치: ').replace(/^profile:/, '상황: '));
  hbars($('#openBars'), sortDesc(m.dims.open_src), (x) => SRC[x] || x);
  hbars($('#rankBars'), ['1-5', '6-20', '21+'].map((r) => [`${r}위`, m.dims.open_rank?.[r] || 0]));
  const miss = m.dims.search_miss || {};
  table($('#searchTbl'), ['검색어', '횟수', '결과 없음'], sortDesc(m.dims.search).slice(0, 15).map(([q, c]) => [esc(q), fmt(c), miss[q] ? `<span class="dn">${fmt(miss[q])}</span>` : '0']));
  const scroll = {};
  for (const [key, c] of Object.entries(m.dims.scroll || {})) { const [p, d] = key.split('|'); (scroll[p] ||= {})[d] = c; }
  table($('#scrollTbl'), ['페이지', '25%', '50%', '75%', '100%'], Object.entries(scroll).sort((a, b) => (b[1][25] || 0) - (a[1][25] || 0)).slice(0, 10)
    .map(([p, s]) => [esc(p), ...[25, 50, 75, 100].map((d) => `${fmt(s[d] || 0)} <small class="muted">${d > 25 ? pct(rate(s[d] || 0, s[25] || 0), 0) : ''}</small>`)]));

  table($('#salesTbl'), ['지역', '점수', '조회', '비교', '상담 열기', '상담 신청', '구독'], ins.salesTargets.map((t) => [esc(t.name), fmt(Math.round(t.score)), fmt(t.views), fmt(t.compare), fmt(t.leadOpen), fmt(t.leads), fmt(t.subs)]));
  const R = m.regions;
  const codes = [...new Set(Object.values(R).flatMap((h) => Object.keys(h)))];
  const names = Object.fromEntries(ins.salesTargets.map((t) => [t.code, t.name]));
  table($('#regionTbl'), ['지역', '조회', '비교', '상담 열기', '상담 신청', '출처 클릭', '정정 요청', '상담 전환'], codes.map((c) => ({ c, v: R.region_open?.[c] || 0 })).sort((a, b) => b.v - a.v).slice(0, 89)
    .map(({ c, v }) => [esc(names[c] || c), fmt(v), fmt(R.compare_add?.[c] || 0), fmt(R.lead_open?.[c] || 0), fmt(R.lead_submit?.[c] || 0), fmt(R.source_click?.[c] || 0), fmt(R.correction_click?.[c] || 0), pct(rate(R.lead_submit?.[c] || 0, v))]));

  const rowFor = (label, s) => [esc(label), fmt(s.page_view), pct(rate(s.engaged, s.page_view)), pct(rate(s.compare_add, s.page_view)), pct(rate(s.convert, s.page_view)), fmt(s.lead_submit)];
  table($('#srcTbl'), ['유입', '방문자', '탐색률', '비교율', '전환율', '상담'], Object.entries(m.sources).sort((a, b) => b[1].page_view - a[1].page_view).map(([k2, s]) => rowFor(k2, s)));
  table($('#devTbl'), ['기기', '방문자', '탐색률', '비교율', '전환율', '상담'], Object.entries(m.devices).filter(([, s]) => s.page_view).map(([k2, s]) => rowFor(DEV[k2] || k2, s)));

  const expFindings = Object.fromEntries(ins.findings.filter((f) => f.id.startsWith('exp_')).map((f) => [f.id.slice(4), f]));
  const EXPLABEL = { hero_cta: '첫 화면 주 버튼', lead_cta: '상담 버튼 문구' };
  $('#expBox').innerHTML = Object.entries(m.experiments).map(([x, vs]) => {
    const rows = Object.entries(vs).map(([v, s]) => `<tr><td>${esc(v)}</td><td class="num">${fmt(s.page_view)}</td><td class="num">${pct(rate(s.engaged, s.page_view))}</td><td class="num">${pct(rate(s.compare_add, s.page_view))}</td><td class="num">${pct(rate(s.lead_submit, s.page_view), 2)}</td><td class="num">${pct(rate(s.convert, s.page_view), 2)}</td></tr>`).join('');
    return `<div class="box" style="margin-bottom:16px"><h2>${esc(EXPLABEL[x] || x)}</h2><div class="tblwrap"><table><thead><tr><th>변형</th><th>방문자</th><th>탐색률</th><th>비교율</th><th>상담 신청률</th><th>전환율</th></tr></thead><tbody>${rows}</tbody></table></div>${expFindings[x] ? findingCard(expFindings[x]) : ''}</div>`;
  }).join('') || '<p class="empty">실험 노출 기록이 아직 없습니다.</p>';

  const LIM = { LCP: 2500, INP: 200, CLS: 0.1, FCP: 1800, TTFB: 800 };
  const vrows = [];
  for (const [v, byDev] of Object.entries(m.vitals)) for (const [d, s] of Object.entries(byDev)) {
    const val = v === 'CLS' ? s.p75.toFixed(3) : `${Math.round(s.p75)}ms`;
    vrows.push([`${v} · ${DEV[d]}`, fmt(s.n), `<span class="${s.p75 > LIM[v] ? 'dn' : 'up'}">${val}</span>`]);
  }
  table($('#vitalTbl'), ['지표', '표본', 'p75'], vrows);
  table($('#errTbl'), ['오류', '횟수'], sortDesc(m.dims.err).slice(0, 10).map(([e2, c]) => [esc(e2), fmt(c)]));
  table($('#formErrTbl'), ['폼:칸', '횟수'], sortDesc(m.dims.form_err).slice(0, 10).map(([e2, c]) => [esc(e2), fmt(c)]));
}

async function load() {
  if (!API) return;
  const res = await fetch(`${API}/admin/analytics?days=${days}`, { headers: auth() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { msg(body.error || '불러오지 못했습니다'); return; }
  try { sessionStorage.setItem('igg:admin', token); } catch { /* 무시 */ }
  $('#adminMsg').hidden = true;
  $('#login').hidden = true;
  $('#dash').hidden = false;
  data = body;
  render();
  fetch(`${API}/health`).then((r) => r.json()).then((h) => {
    $('#health').textContent = [['저장소', h.store], ['결제', h.payments], ['메일', h.notify]].map(([l, v]) => `${l} ${v ? '켜짐' : '꺼짐'}`).join(' · ');
  }).catch(() => {});
}

$('#login').addEventListener('submit', (e) => { e.preventDefault(); token = $('#tok').value.trim(); load(); });
$$('[data-days]').forEach((b) => b.addEventListener('click', () => {
  days = Number(b.dataset.days);
  $$('[data-days]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  load();
}));
$$('[role=tab]').forEach((t) => t.addEventListener('click', () => {
  $$('[role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
  $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== t.dataset.tab; });
}));
$('#copyMd').addEventListener('click', async () => {
  const res = await fetch(`${API}/admin/analytics?days=${days}&format=md`, { headers: auth() });
  const text = await res.text();
  try { await navigator.clipboard.writeText(text); toast('보고서를 복사했습니다'); } catch { toast('복사하지 못했습니다'); }
});
async function download(path, name) {
  const res = await fetch(`${API}${path}`, { headers: auth() });
  if (!res.ok) { toast('내려받지 못했습니다'); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$$('[data-export]').forEach((b) => b.addEventListener('click', () => download(`/admin/export?type=${b.dataset.export}`, `igalgun-${b.dataset.export}.csv`)));
$('#rawDay').value = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
$('#rawBtn').addEventListener('click', () => download(`/admin/events?day=${encodeURIComponent($('#rawDay').value)}`, `igalgun-events-${$('#rawDay').value}.ndjson`));
if (token) load();
