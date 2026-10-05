// 토스페이먼츠 결제위젯 연동. 키가 없으면 결제 기능은 꺼진 상태로 응답한다.
import { createHmac, timingSafeEqual } from 'node:crypto';

export function paymentsReady() {
  return Boolean(process.env.TOSS_CLIENT_KEY && process.env.TOSS_SECRET_KEY && process.env.REPORT_SECRET);
}

export function clientKeyPublic() {
  return process.env.TOSS_CLIENT_KEY || null;
}

export async function confirmPayment({ paymentKey, orderId, amount }) {
  const auth = Buffer.from(`${process.env.TOSS_SECRET_KEY}:`).toString('base64');
  const res = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', 'Idempotency-Key': orderId },
    body: JSON.stringify({ paymentKey, orderId, amount }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// 리포트 열람 토큰: 주문번호에 대한 HMAC. 링크만 있으면 다시 볼 수 있게 한다.
export function reportToken(orderId) {
  return createHmac('sha256', process.env.REPORT_SECRET || '').update(`report:${orderId}`).digest('base64url').slice(0, 32);
}

export function verifyToken(orderId, token) {
  if (!process.env.REPORT_SECRET || typeof token !== 'string') return false;
  const want = Buffer.from(reportToken(orderId));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}
