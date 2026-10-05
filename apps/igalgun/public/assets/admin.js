// 운영 관리: 접수 건수, 지역별 관심도, CSV 내보내기.
import { $, $$, esc, fmt } from './common.js';

let token = '';
try { token = sessionStorage.getItem('igg:admin') || ''; } catch { /* 저장 불가 */ }
$('#tok').value = token;
$('#month').value = new Date().toISOString().slice(0, 7);

const msg = (t) => { const m = $('#adminMsg'); m.hidden = false; m.className = 'formmsg err'; m.textContent = t; };
const auth = () => ({ Authorization: `Bearer ${token}` });

async function load() {
  const res = await fetch(`/api/admin/stats?month=${encodeURIComponent($('#month').value)}`, { headers: auth() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { msg(body.error || '불러오지 못했습니다'); return; }
  try { sessionStorage.setItem('igg:admin', token); } catch { /* 무시 */ }
  $('#adminMsg').hidden = true;
  $('#dash').hidden = false;
  const c = body.counts;
  $('#counts').innerHTML = [['상담 신청', c.leads], ['파트너 문의', c.partners], ['구독자', c.subscribers], ['결제', c.orders]]
    .map(([l, v]) => `<div><b>${fmt(v)}</b><span>${l}</span></div>`).join('');
  const cols = [['view', '조회'], ['compare', '비교 담기'], ['lead_open', '상담 열기'], ['report_open', '리포트'], ['lead', '상담 신청(누적)'], ['subscribe', '구독(누적)']];
  $('#statsTbl').innerHTML = `<thead><tr><th>지역</th>${cols.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>${
    body.rows.filter((r) => cols.some(([k]) => r[k])).map((r) => `<tr><td>${esc(r.sido)} ${esc(r.name)}</td>${cols.map(([k]) => `<td class="num">${fmt(r[k])}</td>`).join('')}</tr>`).join('')
    || `<tr><td colspan="${cols.length + 1}" class="empty">${esc(body.month)}에 기록된 활동이 없습니다.</td></tr>`}</tbody>`;
  const h = await (await fetch('/api/health')).json();
  $('#health').textContent = [['저장소', h.store], ['결제', h.payments], ['메일 알림', h.notify]].map(([l, v]) => `${l} ${v ? '켜짐' : '꺼짐'}`).join(' · ');
}

$('#login').addEventListener('submit', (e) => { e.preventDefault(); token = $('#tok').value.trim(); load(); });
$('#month').addEventListener('change', load);
$$('[data-export]').forEach((b) => b.addEventListener('click', async () => {
  const res = await fetch(`/api/admin/export?type=${b.dataset.export}`, { headers: auth() });
  if (!res.ok) { msg('내보내지 못했습니다'); return; }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `igalgun-${b.dataset.export}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}));
if (token) load();
