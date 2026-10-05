// 모든 페이지 공통: 데이터 로드, 지역 검색, 폼 제출, 관심도 이벤트, 알림.
let dataPromise;
export function loadData() {
  dataPromise ||= fetch('/data/regions.json').then((r) => {
    if (!r.ok) throw new Error('데이터를 불러오지 못했습니다');
    return r.json();
  });
  return dataPromise;
}

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const fmt = (n) => (n == null ? '–' : Number(n).toLocaleString('ko-KR'));
export const pct = (v, d = 1) => `${v > 0 ? '+' : ''}${Number(v).toFixed(d)}%`;
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(`igg:${k}`)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`igg:${k}`, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } },
};

let toastTimer;
export function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  // 열린 dialog(최상위 레이어) 위에 보이도록 popover로 띄운다
  if (t.showPopover) { try { t.hidePopover(); } catch { /* 닫혀 있음 */ } t.showPopover(); }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; try { t.hidePopover?.(); } catch { /* 무시 */ } }, 2600);
}

// 지역별 관심도 집계. 실패해도 화면에는 영향 없음.
export function track(type, code) {
  if (!code) return;
  try {
    const body = JSON.stringify({ type, code });
    if (navigator.sendBeacon) navigator.sendBeacon('/api/event', new Blob([body], { type: 'application/json' }));
    else fetch('/api/event', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
  } catch { /* 무시 */ }
}

/* ---------- 메뉴 ---------- */
const menuBtn = $('#menuBtn');
menuBtn?.addEventListener('click', () => {
  const nav = $('#mainnav');
  const open = nav.classList.toggle('open');
  menuBtn.setAttribute('aria-expanded', String(open));
});

/* ---------- 지역 검색 ---------- */
const dlg = $('#searchDlg');
const input = $('#searchInput');
const list = $('#searchList');
let hits = [];
let cursor = 0;
const norm = (s) => s.replace(/\s/g, '').replace(/(특별자치도|특별자치시|광역시|특별시|도)$/, '');

async function renderSearch() {
  const { regions } = await loadData();
  const q = norm(input.value.trim());
  hits = (q ? regions.filter((r) => norm(r.name).includes(q) || norm(r.sido + r.name).includes(q) || norm(r.name.replace(/[군시구]$/, '')) === q) : regions.filter((r) => r.basic_income)).slice(0, 12);
  cursor = 0;
  list.innerHTML = hits.length
    ? hits.map((r, i) => `<li><a role="option" href="/region/${r.code}" data-code="${r.code}" aria-selected="${i === 0}">${esc(r.name)} <small>${esc(r.sido)}</small>${r.basic_income ? '<span class="tag bi">기본소득</span>' : ''}</a></li>`).join('')
    : '<li class="empty">인구감소지역 89곳 중 일치하는 곳이 없습니다.</li>';
  if (!q) list.insertAdjacentHTML('afterbegin', '<li class="hint" style="border:0">기본소득 지역부터 보여 드려요</li>');
}
function openSearch() {
  if (!dlg) return;
  dlg.showModal();
  input.value = '';
  renderSearch();
  input.focus();
}
$('#openSearch')?.addEventListener('click', openSearch);
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !dlg.open) { e.preventDefault(); openSearch(); }
});
input?.addEventListener('input', renderSearch);
input?.addEventListener('keydown', (e) => {
  const links = $$('a[role=option]', list);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
    links.forEach((a, i) => a.setAttribute('aria-selected', String(i === cursor)));
    links[cursor]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && links[cursor]) {
    e.preventDefault();
    links[cursor].click();
  }
});
list?.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-code]');
  if (!a) return;
  if (window.igg?.openRegion) { e.preventDefault(); dlg.close(); window.igg.openRegion(a.dataset.code); }
});
dlg?.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

/* ---------- 펼치기 버튼, 이벤트 ---------- */
document.addEventListener('click', (e) => {
  const opener = e.target.closest('[data-open]');
  if (opener) {
    const box = document.getElementById(opener.dataset.open);
    if (box) {
      box.hidden = !box.hidden;
      if (!box.hidden) { box.querySelector('input:not([type=hidden]):not([tabindex="-1"]),select,textarea')?.focus(); box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    }
  }
  const ev = e.target.closest('[data-event]');
  if (ev) track(ev.dataset.event, ev.dataset.code);
  const closer = e.target.closest('[data-close]');
  if (closer) closer.closest('dialog')?.close();
});

/* ---------- 폼 제출 (상담, 구독, 파트너) ---------- */
export function formPayload(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.name === 'regions') out.regions = el.value ? el.value.split(',').filter(Boolean) : [];
    else if (el.multiple) out[el.name] = [...el.selectedOptions].map((o) => o.value);
    else out[el.name] = el.value;
  }
  return out;
}

const DONE = {
  lead: '신청을 받았습니다. 영업일 기준 2일 안에 남겨 주신 연락처로 회신드립니다.',
  subscribe: '구독했습니다. 관심 지역 정책이 바뀌면 메일로 알려 드립니다.',
  partner: '문의를 받았습니다. 영업일 기준 2일 안에 담당자께 연락드립니다.',
};

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-endpoint]');
  if (!form) return;
  e.preventDefault();
  const msg = form.querySelector('.formmsg');
  const btn = form.querySelector('[type=submit]');
  const show = (text, ok) => { msg.hidden = false; msg.className = `formmsg ${ok ? 'ok' : 'err'}`; msg.textContent = text; };
  for (const el of form.querySelectorAll('[required]')) {
    if ((el.type === 'checkbox' && !el.checked) || (el.type !== 'checkbox' && !el.value.trim())) {
      show(el.type === 'checkbox' ? '필수 동의 항목을 확인해 주세요.' : `${el.labels?.[0]?.textContent.replace(/\(.*\)/, '').trim() || '필수 항목'}을(를) 입력해 주세요.`, false);
      el.focus();
      return;
    }
  }
  const payload = formPayload(form);
  if (window.igg?.profile) payload.profile ||= window.igg.profile();
  btn.disabled = true;
  try {
    const res = await fetch(form.dataset.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.error || '전송하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
    show(DONE[form.dataset.kind] || '전송했습니다.', true);
    form.querySelectorAll('input:not([type=hidden]):not([type=checkbox]),textarea').forEach((el) => { el.value = ''; });
    toast('접수되었습니다');
  } catch (err) {
    show(err.message === 'Failed to fetch' ? '네트워크 연결을 확인해 주세요.' : err.message, false);
  } finally {
    btn.disabled = false;
  }
});

/* 지역 페이지 방문 집계 */
const article = $('article#region[data-code]');
if (article && document.body.dataset.page === 'region') track('view', article.dataset.code);
