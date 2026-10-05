// 결제 전 주문 생성. 금액은 서버가 정하고, 승인 단계에서 다시 대조한다.
import { store } from '../../lib/store.js';
import { preflight, handle, json, fail, readBody, clientKey } from '../../lib/http.js';
import { regionCodes, oneOf } from '../../lib/validate.js';
import { paymentsReady, clientKeyPublic } from '../../lib/payments.js';
import { priceFor, REPORT_NAME } from '../../lib/report.js';

export const POST = handle(async (request) => {
  if (!paymentsReady()) return fail(503, '결제는 준비 중입니다. 출시 알림을 신청해 주세요.', { code: 'payments_unconfigured' });
  const body = await readBody(request);
  if (!(await store.allow(`pay:${clientKey(request)}`, 20, 3600))) return fail(429, '요청이 너무 잦습니다.');
  const regions = regionCodes(body.regions, { min: 1, max: 3 });
  const order = {
    orderId: `igg_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
    regions,
    profile: oneOf(body.profile, ['remote', 'family', 'farm', 'retire'], '상황') || 'remote',
    amount: priceFor(regions.length),
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  await store.set(`order:${order.orderId}`, order, 60 * 60 * 24);
  return json({
    ok: true,
    orderId: order.orderId,
    amount: order.amount,
    orderName: `${REPORT_NAME} (${order.regions.length}곳)`,
    clientKey: clientKeyPublic(),
    customerKey: `anon_${crypto.randomUUID()}`,
  });
});

export const OPTIONS = preflight;
