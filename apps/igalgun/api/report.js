// 리포트 조회.
//   ?sample=1                       예시 리포트(전체 공개)
//   ?preview=1&regions=a,b&profile= 무료 미리보기(일정·지원 내역 잠금)
//   ?order=igg_...&token=...        결제한 리포트
import { store } from '../lib/store.js';
import { handle, json, fail } from '../lib/http.js';
import { regionCodes, oneOf } from '../lib/validate.js';
import { buildReport, PRICES } from '../lib/report.js';
import { verifyToken, paymentsReady } from '../lib/payments.js';

const SAMPLE = { regions: ['51770', '43730', '43150'], profile: 'remote' }; // 정선군, 옥천군, 제천시

export const GET = handle(async (request) => {
  const q = new URL(request.url).searchParams;
  const meta = { prices: PRICES, paymentsReady: paymentsReady() };
  if (q.get('sample')) return json({ ok: true, sample: true, report: buildReport(SAMPLE.regions, SAMPLE.profile), ...meta });
  if (q.get('preview')) {
    const codes = regionCodes((q.get('regions') || '').split(',').filter(Boolean), { min: 1, max: 3 });
    const profile = oneOf(q.get('profile') || 'remote', ['remote', 'family', 'farm', 'retire'], '상황');
    return json({ ok: true, report: buildReport(codes, profile, { full: false }), ...meta });
  }
  const orderId = q.get('order') || '';
  if (!verifyToken(orderId, q.get('token'))) return fail(403, '리포트 링크가 올바르지 않습니다');
  const order = await store.get(`order:${orderId}`);
  if (!order || order.status !== 'paid') return fail(404, '결제가 확인되지 않은 주문입니다');
  return json({ ok: true, report: buildReport(order.regions, order.profile), orderId, receiptUrl: order.receiptUrl, ...meta });
});
