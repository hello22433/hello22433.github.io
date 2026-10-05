// 지자체·기관 파트너 문의.
import { store } from '../lib/store.js';
import { handle, json, fail, readBody, clientKey } from '../lib/http.js';
import { text, contact, oneOf, mustConsent, isBot, regionCodes } from '../lib/validate.js';
import { notify } from '../lib/notify.js';

export const POST = handle(async (request) => {
  const body = await readBody(request);
  if (isBot(body)) return json({ ok: true });
  if (!(await store.allow(`partner:${clientKey(request)}`, 5, 3600))) {
    return fail(429, '문의가 너무 잦습니다. 한 시간 뒤 다시 시도해 주세요.');
  }
  const inquiry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    org: text(body.org, { max: 80, required: true, label: '기관명' }),
    dept: text(body.dept, { max: 80, label: '부서' }),
    name: text(body.name, { max: 40, required: true, label: '담당자 이름' }),
    contact: contact(body.contact),
    plan: oneOf(body.plan, ['basic', 'partner', 'campaign', 'unsure'], '관심 플랜') || 'unsure',
    regions: regionCodes(body.regions, { min: 0, max: 3 }),
    message: text(body.message, { max: 2000, label: '문의 내용' }),
    consent: mustConsent(body.consent, '문의 처리를 위한 개인정보 수집·이용'),
  };
  await store.push('partners', inquiry);
  await notify('새 파트너 문의', `${inquiry.org} ${inquiry.dept} · ${inquiry.plan}`);
  return json({ ok: true, id: inquiry.id }, 201);
});
