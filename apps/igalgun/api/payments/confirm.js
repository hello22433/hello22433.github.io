// 토스페이먼츠 successUrl에서 호출. 주문 금액을 대조한 뒤 결제를 승인한다.
import { store } from '../../lib/store.js';
import { preflight, handle, json, fail, readBody } from '../../lib/http.js';
import { paymentsReady, confirmPayment, reportToken } from '../../lib/payments.js';
import { notify } from '../../lib/notify.js';

export const POST = handle(async (request) => {
  if (!paymentsReady()) return fail(503, '결제는 준비 중입니다.', { code: 'payments_unconfigured' });
  const { paymentKey, orderId, amount } = await readBody(request);
  if (typeof paymentKey !== 'string' || typeof orderId !== 'string' || !/^igg_[\w-]{4,60}$/.test(orderId)) {
    return fail(400, '결제 정보가 올바르지 않습니다');
  }
  const order = await store.get(`order:${orderId}`);
  if (!order) return fail(404, '주문을 찾을 수 없습니다. 처음부터 다시 시도해 주세요.');
  if (order.status === 'paid') return json({ ok: true, orderId, token: reportToken(orderId) });
  if (Number(amount) !== order.amount) return fail(400, '결제 금액이 주문과 다릅니다');

  const result = await confirmPayment({ paymentKey, orderId, amount: order.amount });
  if (!result.ok) {
    return fail(402, result.body.message || '결제 승인에 실패했습니다', { code: result.body.code || 'confirm_failed' });
  }
  const paid = {
    ...order,
    status: 'paid',
    paymentKey,
    method: result.body.method || null,
    approvedAt: result.body.approvedAt || new Date().toISOString(),
    receiptUrl: result.body.receipt?.url || null,
  };
  await store.set(`order:${orderId}`, paid, 60 * 60 * 24 * 400);
  await store.push('orders', { orderId, amount: paid.amount, regions: paid.regions, profile: paid.profile, approvedAt: paid.approvedAt, method: paid.method });
  await notify('리포트 결제', `${orderId} · ${paid.amount}원`);
  return json({ ok: true, orderId, token: reportToken(orderId), receiptUrl: paid.receiptUrl });
});

export const OPTIONS = preflight;
