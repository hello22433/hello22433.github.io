// 오프라인 분석기. 관리 화면에서 받은 원본 로그(NDJSON)로 같은 지표와 개선 과제 보고서를 만든다.
//   node scripts/analyze.mjs igalgun-events-2026-10-05.ndjson [더 많은 파일...] [--json]
import { readFileSync } from 'node:fs';

process.env.IGG_MEMORY_STORE = '1';
const { exec } = await import('../lib/store.js');
const { opsFor, kstDay } = await import('../lib/aggregate.js');
const { readMetrics, dayRange } = await import('../lib/metrics.js');
const { buildInsights, insightsMarkdown } = await import('../lib/insights.js');
const { sanitize } = await import('../public/assets/events.js');

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const asJson = process.argv.includes('--json');
if (!files.length) { console.error('사용법: node scripts/analyze.mjs events.ndjson [...] [--json]'); process.exit(1); }

const regions = JSON.parse(readFileSync(new URL('../public/data/regions.json', import.meta.url))).regions;
const days = new Set();
let ops = [];
let n = 0;
for (const f of files) {
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    const p = sanitize(r.e, r.p);
    if (!p) continue;
    const day = kstDay(r.t);
    days.add(day);
    ops.push(...opsFor({ vid: r.vid, sid: r.sid, dev: r.dev, src: r.src, exp: r.exp || {} }, { e: r.e, p, path: r.path, t: r.t }, day));
    n++;
    if (ops.length > 20000) { await exec(ops, 5000); ops = []; }
  }
}
await exec(ops, 5000);
const sorted = [...days].sort();
const metrics = await readMetrics((c) => exec(c, 5000), dayRange(sorted[0], sorted[sorted.length - 1]));
const insights = buildInsights(metrics, { regions });
if (asJson) console.log(JSON.stringify({ events: n, metrics, insights }, null, 2));
else console.log(`${insightsMarkdown(insights)}\n\n(이벤트 ${n.toLocaleString('ko-KR')}건 분석)`);
