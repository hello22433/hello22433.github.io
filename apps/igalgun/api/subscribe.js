// 관심 지역 정책 변경 알림 구독.
import { store } from '../lib/store.js';
import { preflight, handle, json, fail, readBody, clientKey } from '../lib/http.js';
import { email, regionCodes, mustConsent, isBot, oneOf } from '../lib/validate.js';

export const POST = handle(async (request) => {
  const body = await readBody(request);
  if (isBot(body)) return json({ ok: true });
  if (!(await store.allow(`sub:${clientKey(request)}`, 10, 3600))) {
    return fail(429, '요청이 너무 잦습니다. 잠시 뒤 다시 시도해 주세요.');
  }
  const sub = {
    at: new Date().toISOString(),
    email: email(body.email),
    regions: regionCodes(body.regions, { min: 0, max: 10 }),
    topic: oneOf(body.topic, ['policy', 'report_launch', 'newsletter'], '구독 종류') || 'policy',
    consent: mustConsent(body.consent, '알림 수신을 위한 이메일 수집'),
  };
  await store.push('subscribers', sub);
  return json({ ok: true }, 201);
});

export const OPTIONS = preflight;
