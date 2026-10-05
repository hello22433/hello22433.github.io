// 배포 점검용. 어떤 연동이 켜져 있는지만 알려 주고 비밀값은 노출하지 않는다.
import { json } from '../lib/http.js';
import { storeReady } from '../lib/store.js';
import { paymentsReady } from '../lib/payments.js';

export function GET() {
  return json({
    ok: true,
    store: storeReady(),
    payments: paymentsReady(),
    notify: Boolean(process.env.RESEND_API_KEY && process.env.NOTIFY_EMAIL),
    admin: Boolean(process.env.ADMIN_TOKEN && process.env.ADMIN_TOKEN.length >= 16),
  });
}
