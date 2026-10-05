// 로그 수집·집계·인사이트 테스트
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.IGG_MEMORY_STORE = '1';
process.env.ADMIN_TOKEN = 'test-admin-token-123456';
process.env.IGG_ALLOW_HEADLESS = '1';
const { resetMemoryStore, exec } = await import('../lib/store.js');
const collect = await import('../api/collect.js');
const analytics = await import('../api/admin/analytics.js');
const events = await import('../api/admin/events.js');
const { parseBatch } = await import('../lib/collect.js');
const { sanitize, variantFor } = await import('../public/assets/events.js');
const { opsFor, kstDay } = await import('../lib/aggregate.js');
const { readMetrics } = await import('../lib/metrics.js');
const { buildInsights, zTest, sampleNeeded } = await import('../lib/insights.js');

const AUTH = { authorization: 'Bearer test-admin-token-123456' };
const batch = (events, extra = {}) => ({ vid: 'visitor0001', sid: 'session0001', dev: 'm', src: 'naver', exp: { hero_cta: 'quiz' }, events, ...extra });
const send = (body, headers = {}) => collect.POST(new Request('http://t/api/collect', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'x-forwarded-for': '1.2.3.4', ...headers }, body: JSON.stringify(body) }));

beforeEach(() => resetMemoryStore());

test('스키마: 정의되지 않은 이벤트·속성은 버리고 개인정보 칸은 남지 않음', () => {
  assert.equal(sanitize('hack', {}), null);
  assert.deepEqual(sanitize('lead_submit', { code: '51770', contact: '010-1111-2222', purpose: '귀농' }), { code: '51770', purpose: '귀농' });
  assert.deepEqual(sanitize('region_open', { code: 'abc', source: 'list' }), { source: 'list' });
});

test('배치 검증: 잘못된 ID, 오래된 시각, 모르는 실험 변형 제거', () => {
  const now = Date.now();
  assert.equal(parseBatch({ vid: 'x', sid: 'session0001', events: [] }), null);
  const b = parseBatch(batch([{ e: 'page_view', t: now, p: { path: '/' } }, { e: 'page_view', t: now - 3 * 86400000, p: {} }], { exp: { hero_cta: 'evil', lead_cta: 'question' } }), now);
  assert.equal(b.events.length, 1);
  assert.deepEqual(b.env.exp, { lead_cta: 'question' });
});

test('실험 배정은 방문자마다 고정', () => {
  assert.equal(variantFor('hero_cta', 'abcdefgh12'), variantFor('hero_cta', 'abcdefgh12'));
  const vs = new Set(Array.from({ length: 200 }, (_, i) => variantFor('hero_cta', `visitor${i}xx`)));
  assert.deepEqual([...vs].sort(), ['browse', 'quiz']);
});

test('수집 → 집계 → 기간 지표: 퍼널 고유 방문자와 지역 카운트', async () => {
  const t = Date.now();
  assert.equal((await send(batch([
    { e: 'page_view', t, p: { path: '/' } },
    { e: 'region_open', t, p: { code: '51770', source: 'list', rank: 2 } },
    { e: 'region_open', t, p: { code: '51770', source: 'map' } },
    { e: 'compare_add', t, p: { code: '51770' } },
    { e: 'lead_open', t, p: { code: '51770' } },
    { e: 'lead_submit', t, p: { code: '51770', when: '1년 이내', third: true } },
    { e: 'search', t, p: { q: '강릉', results: 0 } },
  ]))).status, 204);
  await send(batch([{ e: 'page_view', t, p: { path: '/' } }], { vid: 'visitor0002', sid: 'session0002', dev: 'd', src: 'direct' }));
  const body = await (await analytics.GET(new Request('http://t/api?days=1', { headers: AUTH }))).json();
  const m = body.metrics;
  assert.equal(m.visitors, 2);
  assert.equal(m.uv.engaged, 1);
  assert.equal(m.uv.convert, 1);
  assert.equal(m.regions.region_open['51770'], 2);
  assert.equal(m.dims.search_miss['강릉'], 1);
  assert.equal(m.devices.m.convert, 1);
  assert.equal(m.sources.naver.lead_submit, 1);
  assert.equal(m.experiments.hero_cta.quiz.page_view, 2);
  const raw = await (await events.GET(new Request(`http://t/api?day=${kstDay()}`, { headers: AUTH }))).text();
  assert.equal(raw.trim().split('\n').length, 8);
  assert.ok(!raw.includes('contact'));
});

test('관리자 지표는 토큰이 필요', async () => {
  assert.equal((await analytics.GET(new Request('http://t/api?days=7'))).status, 401);
});

test('통계 함수: z-검정과 필요 표본', () => {
  const t = zTest(60, 500, 30, 500);
  assert.ok(t.p < 0.01 && t.z > 0);
  assert.ok(zTest(50, 500, 48, 500).p > 0.5);
  const n = sampleNeeded(0.1, 0.2);
  assert.ok(n > 3000 && n < 4500, `n=${n}`);
});

test('인사이트: 가상 트래픽에 심어 둔 약점을 모두 찾음', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'igg-'));
  const file = path.join(dir, 'sim.ndjson');
  execFileSync(process.execPath, ['scripts/simulate.mjs', '--visitors', '3000', '--days', '7', '--out', file], { cwd: path.dirname(path.dirname(new URL(import.meta.url).pathname)) });
  const regions = JSON.parse(readFileSync(new URL('../public/data/regions.json', import.meta.url))).regions;
  const days = new Set();
  const ops = [];
  for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
    const r = JSON.parse(line);
    const d = kstDay(r.t);
    days.add(d);
    ops.push(...opsFor({ vid: r.vid, sid: r.sid, dev: r.dev, src: r.src, exp: r.exp }, { e: r.e, p: sanitize(r.e, r.p), path: r.path }, d));
  }
  await exec(ops, 5000);
  const m = await readMetrics((c) => exec(c, 5000), [...days].sort());
  const ins = buildInsights(m, { regions });
  const ids = ins.findings.map((f) => f.id);
  for (const want of ['quiz_drop', 'mobile_gap', 'vital_LCP_m', 'js_errors', 'search_miss', 'b2g_targets', 'exp_lead_cta']) assert.ok(ids.includes(want), `${want} 없음: ${ids.join(',')}`);
  assert.match(ins.findings.find((f) => f.id === 'quiz_drop').title, /3번/);
  assert.match(ins.findings.find((f) => f.id === 'exp_lead_cta').title, /question 승/);
  assert.equal(ins.findings[0].severity, 'high');
});
