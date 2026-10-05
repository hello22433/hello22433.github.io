// 주간 인사이트 메일. vercel.json의 crons가 매주 월요일 호출한다.
// Vercel은 CRON_SECRET이 있으면 Authorization: Bearer <CRON_SECRET>을 붙여 부른다.
import { handle, json, fail } from '../../lib/http.js';
import { analyticsFor, rangeFrom } from '../../lib/analytics.js';
import { insightsMarkdown } from '../../lib/insights.js';
import { notify } from '../../lib/notify.js';

export const GET = handle(async (request) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) return fail(401, 'unauthorized');
  const out = await analyticsFor(rangeFrom(new URLSearchParams('days=7')));
  const sent = await notify(`주간 인사이트 ${out.insights.range.from}~${out.insights.range.to}`, insightsMarkdown(out.insights));
  return json({ ok: true, sent, findings: out.insights.findings.length });
});
