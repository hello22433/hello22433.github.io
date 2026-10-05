// 지역별 관심도 집계(조회, 비교함 담기, 상담 버튼 클릭). 개인 식별 정보는 받지 않는다.
// 이 숫자가 지자체 파트너에게 주는 월간 관심도 리포트의 원천이다.
import { store, storeReady } from '../lib/store.js';
import { handle, readBody, clientKey } from '../lib/http.js';
import { REGION_CODES } from '../lib/validate.js';

const TYPES = new Set(['view', 'compare', 'lead_open', 'report_open', 'share']);

export const POST = handle(async (request) => {
  if (!storeReady()) return new Response(null, { status: 204 });
  const body = await readBody(request, 2000);
  const type = String(body.type || '');
  const code = String(body.code || '');
  if (!TYPES.has(type) || !REGION_CODES.has(code)) return new Response(null, { status: 204 });
  if (!(await store.allow(`ev:${clientKey(request)}`, 300, 3600))) return new Response(null, { status: 204 });
  const month = new Date().toISOString().slice(0, 7);
  await store.hincr(`stats:${type}`, code);
  await store.hincr(`stats:${type}:${month}`, code);
  return new Response(null, { status: 204 });
});
