// 원본 이벤트 내려받기(NDJSON). 오프라인 분석: node scripts/analyze.mjs events.ndjson
import { exec } from '../../lib/store.js';
import { handle, fail, requireAdmin } from '../../lib/http.js';
import { kstDay } from '../../lib/aggregate.js';

export const GET = handle(async (request) => {
  requireAdmin(request);
  const day = new URL(request.url).searchParams.get('day') || kstDay();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return fail(400, '날짜 형식은 YYYY-MM-DD입니다');
  const [rows] = await exec([['LRANGE', `raw:${day}`, '0', '49999']]);
  return new Response((rows || []).reverse().join('\n') + '\n', {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="igalgun-events-${day}.ndjson"`,
      'Cache-Control': 'no-store',
    },
  });
});
