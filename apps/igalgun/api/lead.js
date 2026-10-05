// 정착 상담 신청. 지역 상세의 "상담 신청" 폼이 보낸다.
import { store } from '../lib/store.js';
import { handle, json, fail, readBody, clientKey } from '../lib/http.js';
import { text, contact, regionCodes, oneOf, mustConsent, isBot } from '../lib/validate.js';
import { notify } from '../lib/notify.js';

export const POST = handle(async (request) => {
  const body = await readBody(request);
  if (isBot(body)) return json({ ok: true });
  if (!(await store.allow(`lead:${clientKey(request)}`, 5, 3600))) {
    return fail(429, '신청이 너무 잦습니다. 한 시간 뒤 다시 시도해 주세요.');
  }
  const lead = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    regions: regionCodes(body.regions),
    name: text(body.name, { max: 40, label: '이름' }),
    contact: contact(body.contact),
    when: oneOf(body.when, ['3개월 이내', '1년 이내', '1~3년', '정해지지 않음'], '이주 시기'),
    household: oneOf(body.household, ['1인', '부부', '자녀 있는 가구', '부모님과 함께', '기타'], '가구 형태'),
    purpose: oneOf(body.purpose, ['원격근무·이직', '귀농', '귀촌·전원생활', '은퇴', '창업', '기타'], '이주 목적'),
    message: text(body.message, { max: 1000, label: '문의 내용' }),
    consent: { collect: mustConsent(body.consentCollect, '개인정보 수집·이용'), thirdParty: body.consentThirdParty === true },
    profile: oneOf(body.profile, ['remote', 'family', 'farm', 'retire', ''], '상황'),
    status: 'new',
  };
  await store.push('leads', lead);
  for (const code of lead.regions) await store.hincr('stats:lead', code);
  await notify('새 정착 상담 신청', `지역 ${lead.regions.join(', ')} · ${lead.purpose || '목적 미입력'} · ${lead.when || '시기 미입력'}`);
  return json({ ok: true, id: lead.id }, 201);
});
