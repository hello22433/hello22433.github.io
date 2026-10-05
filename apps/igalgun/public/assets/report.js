// 맞춤 이주 리포트: 지역 선택 → 무료 미리보기 → 토스페이먼츠 결제 → 전체 리포트.
import { loadData, $, $$, fmt, pct, esc, store, toast } from './common.js';
import { PROFILES, won } from './score.js';

const { regions: R } = await loadData();
const byCode = new Map(R.map((r) => [r.code, r]));
const byLabel = new Map(R.map((r) => [`${r.sido} ${r.name}`, r]));
const q = new URLSearchParams(location.search);
const saved = store.get('state') || {};

let profile = q.get('profile') || saved.profile || 'remote';
let chosen = (q.get('regions') || '').split(',').filter((c) => byCode.has(c));
if (!chosen.length) chosen = (saved.cmp || []).filter((c) => byCode.has(c));
chosen = chosen.slice(0, 3);
let paymentsReady = false;
let widgets = null;
let order = null;

/* ---------- 입력 ---------- */
$('#repProfiles').innerHTML = PROFILES.map((p) => `<button class="chip" type="button" data-p="${p.id}">${p.name}</button>`).join('');
$('#repProfiles').addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (b) { profile = b.dataset.p; syncInputs(); } });
$('#repList').innerHTML = R.map((r) => `<option value="${esc(r.sido)} ${esc(r.name)}"></option>`).join('');
function addRegion(label) {
  const r = byLabel.get(label.trim()) || R.find((x) => x.name === label.trim() || x.name.replace(/[군시구]$/, '') === label.trim());
  if (!r) { toast('인구감소지역 89곳 중에서 골라 주세요'); return; }
  if (chosen.includes(r.code)) return;
  if (chosen.length >= 3) { toast('3곳까지 고를 수 있습니다'); return; }
  chosen.push(r.code);
  $('#repSearch').value = '';
  syncInputs();
}
$('#repSearch').addEventListener('change', (e) => { if (byLabel.has(e.target.value)) addRegion(e.target.value); });
$('#repSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addRegion(e.target.value); } });
$('#repChosen').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { chosen = chosen.filter((c) => c !== b.dataset.rm); syncInputs(); } });
function syncInputs() {
  $$('#repProfiles [data-p]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.p === profile)));
  $('#repChosen').innerHTML = chosen.length
    ? chosen.map((c) => `<span class="chip" aria-pressed="true">${esc(byCode.get(c).sido)} ${esc(byCode.get(c).name)} <button class="btn ghost sm" style="min-height:0;padding:0 4px;color:inherit" type="button" data-rm="${c}" aria-label="빼기">×</button></span>`).join('')
    : '<span class="muted" style="font-size:13px">아직 고른 지역이 없습니다.</span>';
  $('#previewBtn').disabled = !chosen.length;
  $('#previewBtn').textContent = chosen.length ? `${chosen.length}곳 무료 미리보기` : '지역을 먼저 고르세요';
}

/* ---------- 렌더링 ---------- */
function regionCol(x, locked) {
  const f = x.facts;
  const support = locked
    ? `<p class="num" style="font-size:22px">${won(x.support.total) || '–'}</p><p class="note">항목별 내역은 전체 리포트에서 볼 수 있습니다.</p>`
    : `<dl class="kv">${x.support.items.map((it) => `<dt>${esc(it.label)}</dt><dd>${won(it.value)}</dd>`).join('')}<dt><b>합계 (최대)</b></dt><dd><b>${won(x.support.total) || '–'}</b></dd></dl>`;
  const tl = locked
    ? `<div class="locked"><ol class="tl blur" aria-hidden="true">${'<li><b>이주 전</b><span>상담 예약과 지원사업 공고 확인</span></li>'.repeat(3)}</ol><div class="veil"><span class="tag">일정 ${x.timelineCount}단계 · 결제 후 공개</span></div></div>`
    : `<ol class="tl">${x.timeline.map((t) => `<li><b>${esc(t.when)}</b><span><strong>${esc(t.what)}</strong>${t.amount ? ` · 최대 ${won(t.amount)}` : ''}<br><span class="muted">${esc(t.detail)}</span>${t.link ? ` <a href="${esc(t.link)}" rel="noopener nofollow" target="_blank">근거</a>` : ''}</span></li>`).join('')}</ol>`;
  return `<div class="col">
    <div class="eyebrow">${esc(x.sido)} · ${esc(x.cls)}지원 · 89곳 중 ${x.rank}위</div>
    <h3>${esc(x.name)} <span class="num" style="font-size:15px;color:var(--rice)">${x.score}점</span></h3>
    <p style="margin-top:8px;font-size:14px"><b>강점</b> ${x.strengths.map(esc).join(', ') || '–'}</p>
    <p style="font-size:14px"><b>주의</b> ${x.risks.map(esc).join(', ') || '두드러진 약점 없음'}</p>
    <h4 style="margin:14px 0 6px;font-size:14px">정착 지원 (최대치)</h4>${support}
    <h4 style="margin:14px 0 6px;font-size:14px">기본 정보</h4>
    <dl class="kv"><dt>인구</dt><dd>${fmt(f.pop)}</dd><dt>1년 변화</dt><dd>${pct(f.chg12m, 2)}</dd><dt>20~39세</dt><dd>${f.young}%</dd><dt>KTX</dt><dd>${esc(f.ktx)}</dd><dt>병·의원/만 명</dt><dd>${f.clinic_per10k}</dd></dl>
    <h4 style="margin:14px 0 6px;font-size:14px">신청 일정</h4>${tl}
  </div>`;
}
function renderReport(rep, { locked = false, sample = false, orderId = null, receiptUrl = null } = {}) {
  const n = rep.regions.length;
  $('#repOut').innerHTML = `<article class="rep" aria-label="이주 리포트">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start">
      <div><div class="eyebrow">${sample ? '예시 · ' : ''}${esc(rep.profile)} · ${esc(rep.generatedAt)} 생성 · ${esc(rep.dataAsOf)}</div><h2>${esc(rep.title)}</h2></div>
      ${locked ? '<span class="tag">무료 미리보기</span>' : '<button class="btn sm noprint" type="button" id="printBtn">인쇄·PDF 저장</button>'}
    </div>
    <p class="verdict">${esc(rep.verdict)}</p>
    <section><div class="cols" style="--n:${n}">${rep.regions.map((x) => regionCol(x, locked)).join('')}</div></section>
    <section><h3 style="font-size:17px">군청 상담 때 물어볼 질문</h3>
      <ol style="padding-left:20px;margin:8px 0 0;display:grid;gap:4px">${rep.questions.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
      ${locked ? '<p class="note">나머지 질문은 전체 리포트에 있습니다.</p>' : ''}
    </section>
    <p class="note">${esc(rep.caveat)}${orderId ? ` · 주문번호 ${esc(orderId)}` : ''}${receiptUrl ? ` · <a href="${esc(receiptUrl)}" rel="noopener" target="_blank">영수증</a>` : ''}</p>
  </article>`;
  $('#printBtn')?.addEventListener('click', () => window.print());
  $('#repOut').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function stepOn(i) { ['#st1', '#st2', '#st3'].forEach((s, k) => $(s).classList.toggle('on', k <= i)); }
function showError(msg) { $('#repOut').innerHTML = `<p class="formmsg err">${esc(msg)}</p>`; }

async function api(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) { const e = new Error(body.error || '서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.'); e.code = body.code; throw e; }
  return body;
}

/* ---------- 미리보기와 결제 ---------- */
$('#previewBtn').addEventListener('click', async () => {
  if (!chosen.length) return;
  try {
    const body = await api(`/api/report?preview=1&regions=${chosen.join(',')}&profile=${profile}`);
    paymentsReady = body.paymentsReady;
    renderReport(body.report, { locked: true });
    stepOn(1);
    history.replaceState({}, '', `/report?regions=${chosen.join(',')}&profile=${profile}`);
    await setupPayment();
  } catch (e) { showError(e.message); }
});
$('#sampleBtn').addEventListener('click', async () => {
  try {
    const body = await api('/api/report?sample=1');
    renderReport(body.report, { sample: true });
  } catch (e) { showError(e.message); }
});

// 결제 SDK는 결제가 켜져 있을 때만 불러온다(페이지 로딩을 막지 않도록).
function loadToss() {
  if (window.TossPayments) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://js.tosspayments.com/v2/standard';
    s.onload = resolve;
    s.onerror = () => reject(new Error('결제 모듈을 불러오지 못했습니다. 새로고침해 주세요.'));
    document.head.appendChild(s);
    setTimeout(() => reject(new Error('결제 모듈 응답이 늦습니다. 새로고침해 주세요.')), 15000);
  });
}
async function setupPayment() {
  $('#payBox').hidden = true;
  $('#waitBox').hidden = true;
  if (!paymentsReady) { $('#waitBox').hidden = false; return; }
  try {
    await loadToss();
    order = await api('/api/payments/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ regions: chosen, profile }) });
    const toss = window.TossPayments(order.clientKey);
    widgets = toss.widgets({ customerKey: order.customerKey });
    await widgets.setAmount({ currency: 'KRW', value: order.amount });
    await Promise.all([
      widgets.renderPaymentMethods({ selector: '#payment-method', variantKey: 'DEFAULT' }),
      widgets.renderAgreement({ selector: '#agreement', variantKey: 'AGREEMENT' }),
    ]);
    $('#payBtn').textContent = `${order.amount.toLocaleString('ko-KR')}원 결제하기`;
    $('#payBox').hidden = false;
  } catch (e) {
    if (e.code === 'payments_unconfigured') $('#waitBox').hidden = false;
    else { $('#payBox').hidden = false; payMsg(e.message); }
  }
}
function payMsg(m) { const el = $('#payMsg'); el.hidden = false; el.className = 'formmsg err'; el.textContent = m; }
$('#payBtn').addEventListener('click', async () => {
  if (!widgets || !order) return;
  try {
    await widgets.requestPayment({
      orderId: order.orderId,
      orderName: order.orderName,
      successUrl: `${location.origin}/report?paid=1`,
      failUrl: `${location.origin}/report?fail=1`,
    });
  } catch (e) { payMsg(e.message || '결제를 시작하지 못했습니다'); }
});

/* ---------- 결제 후 돌아왔을 때 ---------- */
async function boot() {
  syncInputs();
  if (q.get('paid') && q.get('paymentKey')) {
    stepOn(2);
    $('#repOut').innerHTML = '<p class="empty">결제를 확인하는 중입니다…</p>';
    try {
      const done = await api('/api/payments/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paymentKey: q.get('paymentKey'), orderId: q.get('orderId'), amount: Number(q.get('amount')) }) });
      const url = `/report?order=${encodeURIComponent(done.orderId)}&token=${encodeURIComponent(done.token)}`;
      history.replaceState({}, '', url);
      store.set('lastReport', url);
      toast('결제가 완료되었습니다. 이 주소를 저장해 두면 다시 볼 수 있습니다.');
      return loadPaid(done.orderId, done.token);
    } catch (e) { return showError(`${e.message} 결제 금액이 빠져나갔다면 주문번호(${q.get('orderId')})와 함께 문의해 주세요.`); }
  }
  if (q.get('fail')) return showError(q.get('message') || '결제가 취소되었습니다.');
  if (q.get('order') && q.get('token')) return loadPaid(q.get('order'), q.get('token'));
  if (chosen.length && q.get('regions')) $('#previewBtn').click();
}
async function loadPaid(orderId, token) {
  try {
    const body = await api(`/api/report?order=${encodeURIComponent(orderId)}&token=${encodeURIComponent(token)}`);
    stepOn(2);
    renderReport(body.report, { orderId, receiptUrl: body.receiptUrl });
  } catch (e) { showError(e.message); }
}
boot();
