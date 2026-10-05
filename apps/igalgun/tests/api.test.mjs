// API 단위 테스트: node --test tests/
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.IGG_MEMORY_STORE = '1';
process.env.ADMIN_TOKEN = 'test-admin-token-123456';
const { resetMemoryStore } = await import('../lib/store.js');
const lead = await import('../api/lead.js');
const subscribe = await import('../api/subscribe.js');
const partner = await import('../api/partner.js');
const report = await import('../api/report.js');
const prepare = await import('../api/payments/prepare.js');
const confirm = await import('../api/payments/confirm.js');
const exportApi = await import('../api/admin/export.js');
const analytics = await import('../api/admin/analytics.js');
const health = await import('../api/health.js');

let ip = 0;
const post = (body, extra = {}) => new Request('http://t/api', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.0.0.${++ip % 250}`, ...extra },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const get = (qs, headers = {}) => new Request(`http://t/api?${qs}`, { headers });
const goodLead = { regions: ['51770'], contact: '010-1234-5678', purpose: '귀농', when: '1년 이내', household: '부부', consentCollect: true, consentThirdParty: true };

beforeEach(() => { resetMemoryStore(); delete process.env.TOSS_CLIENT_KEY; delete process.env.TOSS_SECRET_KEY; delete process.env.REPORT_SECRET; });

test('상담 신청: 정상 접수와 누적 건수', async () => {
  const res = await lead.POST(post(goodLead));
  assert.equal(res.status, 201);
  const body = await (await analytics.GET(get('days=7', { authorization: 'Bearer test-admin-token-123456' }))).json();
  assert.equal(body.truth.leads, 1);
});

test('상담 신청: 동의 없음·잘못된 연락처·없는 지역은 거절', async () => {
  assert.equal((await lead.POST(post({ ...goodLead, consentCollect: false }))).status, 400);
  assert.equal((await lead.POST(post({ ...goodLead, contact: '12345' }))).status, 400);
  assert.equal((await lead.POST(post({ ...goodLead, regions: ['99999'] }))).status, 400);
  assert.equal((await lead.POST(post({ ...goodLead, when: '내일' }))).status, 400);
  assert.equal((await lead.POST(post('{bad json'))).status, 400);
});

test('상담 신청: 봇 입력칸은 조용히 버림', async () => {
  const res = await lead.POST(post({ ...goodLead, website: 'spam' }));
  assert.equal(res.status, 200);
  const body = await (await exportApi.GET(get('type=leads&format=json', { authorization: 'Bearer test-admin-token-123456' }))).json();
  assert.equal(body.rows.length, 0);
});

test('상담 신청: 같은 IP는 시간당 5건까지', async () => {
  const h = { 'x-forwarded-for': '9.9.9.9' };
  for (let i = 0; i < 5; i++) assert.equal((await lead.POST(post(goodLead, h))).status, 201);
  assert.equal((await lead.POST(post(goodLead, h))).status, 429);
});

test('구독과 파트너 문의', async () => {
  assert.equal((await subscribe.POST(post({ email: 'a@b.co', regions: ['43730'], consent: true }))).status, 201);
  assert.equal((await subscribe.POST(post({ email: 'nope', regions: [], consent: true }))).status, 400);
  assert.equal((await partner.POST(post({ org: '옥천군청', name: '김담당', contact: 'team@okcheon.go.kr', plan: 'partner', consent: true }))).status, 201);
  assert.equal((await partner.POST(post({ org: '', name: '김', contact: 'x@y.kr', consent: true }))).status, 400);
});

test('관리자: 토큰 없으면 401, CSV는 수식 주입 방지', async () => {
  assert.equal((await exportApi.GET(get('type=leads'))).status, 401);
  await lead.POST(post({ ...goodLead, message: '=HYPERLINK("x")' }));
  const csv = await (await exportApi.GET(get('type=leads', { authorization: 'Bearer test-admin-token-123456' }))).text();
  assert.match(csv, /'=HYPERLINK/);
});

test('리포트: 예시는 전체, 미리보기는 잠금', async () => {
  const sample = await (await report.GET(get('sample=1'))).json();
  assert.equal(sample.report.regions.length, 3);
  assert.ok(sample.report.regions[0].timeline.length >= 3);
  const prev = await (await report.GET(get('preview=1&regions=51770,43730&profile=farm'))).json();
  assert.equal(prev.report.locked, true);
  assert.equal(prev.report.regions[0].timeline, undefined);
  assert.equal(prev.report.regions[0].support.items.length, 0);
  assert.equal((await report.GET(get('order=igg_x&token=bad'))).status, 403);
});

test('결제: 키가 없으면 503, 있으면 주문→승인→리포트', async () => {
  assert.equal((await prepare.POST(post({ regions: ['51770'] }))).status, 503);
  process.env.TOSS_CLIENT_KEY = 'test_gck_x';
  process.env.TOSS_SECRET_KEY = 'test_gsk_x';
  process.env.REPORT_SECRET = 'secret-for-tests';
  const p = await (await prepare.POST(post({ regions: ['51770', '43730'], profile: 'family' }))).json();
  assert.equal(p.amount, 19900);
  const fetchMock = mock.method(globalThis, 'fetch', async (url, opts) => {
    assert.equal(url, 'https://api.tosspayments.com/v1/payments/confirm');
    assert.equal(JSON.parse(opts.body).amount, 19900);
    return new Response(JSON.stringify({ method: '카드', approvedAt: '2026-10-05T10:00:00+09:00', receipt: { url: 'https://r' } }), { status: 200 });
  });
  assert.equal((await confirm.POST(post({ paymentKey: 'pk', orderId: p.orderId, amount: 100 }))).status, 400);
  const c = await (await confirm.POST(post({ paymentKey: 'pk', orderId: p.orderId, amount: 19900 }))).json();
  assert.ok(c.token);
  fetchMock.mock.restore();
  const full = await (await report.GET(get(`order=${p.orderId}&token=${c.token}`))).json();
  assert.equal(full.report.regions.length, 2);
  assert.equal(full.report.profile, '신혼·아이 계획');
});

test('헬스체크는 비밀값을 노출하지 않음', async () => {
  const body = await (await health.GET()).json();
  assert.deepEqual(Object.keys(body).sort(), ['admin', 'notify', 'ok', 'payments', 'store']);
});

test('CORS: 허용된 출처만 응답 헤더와 사전 요청 허용', async () => {
  const req = (origin) => new Request('http://t/api', { method: 'OPTIONS', headers: { origin } });
  assert.equal((await lead.OPTIONS(req('https://hello22433.github.io'))).status, 204);
  assert.equal((await lead.OPTIONS(req('https://evil.example'))).status, 403);
  const res = await lead.POST(post(goodLead, { origin: 'https://hello22433.github.io' }));
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://hello22433.github.io');
});
