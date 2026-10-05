// 관리 화면용 기간 지표와 개선 과제.
//   ?days=7|30|90  또는 ?from=YYYY-MM-DD&to=YYYY-MM-DD   &format=md 이면 마크다운 보고서
import { handle, json, requireAdmin } from '../../lib/http.js';
import { analyticsFor, rangeFrom } from '../../lib/analytics.js';
import { insightsMarkdown } from '../../lib/insights.js';

export const GET = handle(async (request) => {
  requireAdmin(request);
  const q = new URL(request.url).searchParams;
  const out = await analyticsFor(rangeFrom(q));
  if (q.get('format') === 'md') {
    return new Response(insightsMarkdown(out.insights), { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  return json({ ok: true, ...out });
});
