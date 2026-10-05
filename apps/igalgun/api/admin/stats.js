// 지역별 관심도와 접수 건수. 지자체 파트너 월간 리포트의 원천 데이터.
import { store } from '../../lib/store.js';
import { handle, json, requireAdmin } from '../../lib/http.js';
import { REGIONS } from '../../lib/validate.js';

export const GET = handle(async (request) => {
  requireAdmin(request);
  const month = new URL(request.url).searchParams.get('month') || new Date().toISOString().slice(0, 7);
  const kinds = ['view', 'compare', 'lead_open', 'report_open', 'share', 'lead', 'subscribe'];
  const all = {};
  for (const k of kinds) all[k] = await store.hgetall(['lead', 'subscribe'].includes(k) ? `stats:${k}` : `stats:${k}:${month}`);
  const rows = REGIONS.map((r) => ({ code: r.code, sido: r.sido, name: r.name, ...Object.fromEntries(kinds.map((k) => [k, all[k][r.code] || 0])) }))
    .sort((a, b) => b.view - a.view);
  const counts = {};
  for (const t of ['leads', 'partners', 'subscribers', 'orders']) counts[t] = await store.count(t);
  return json({ ok: true, month, counts, rows });
});
