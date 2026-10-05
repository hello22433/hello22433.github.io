import { createRequire } from 'node:module';
import { HttpError } from './http.js';

const require = createRequire(import.meta.url);
const DATA = require('../public/data/regions.json');
export const REGION_CODES = new Set(DATA.regions.map((r) => r.code));
export const REGIONS = DATA.regions;

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
const PHONE = /^0\d{1,2}-?\d{3,4}-?\d{4}$/;

export function text(v, { max = 200, required = false, label = '값' } = {}) {
  const s = typeof v === 'string' ? v.trim().replace(/[\u0000-\u001f\u007f]/g, ' ') : '';
  if (required && !s) throw new HttpError(400, `${label}을(를) 입력해 주세요`);
  if (s.length > max) throw new HttpError(400, `${label}은(는) ${max}자 이내로 입력해 주세요`);
  return s;
}

export function contact(v) {
  const s = text(v, { max: 120, required: true, label: '연락처' });
  if (EMAIL.test(s)) return { type: 'email', value: s.toLowerCase() };
  const digits = s.replace(/[\s-]/g, '');
  if (PHONE.test(digits)) return { type: 'phone', value: digits };
  throw new HttpError(400, '이메일 또는 휴대전화 번호를 정확히 입력해 주세요');
}

export function email(v) {
  const s = text(v, { max: 200, required: true, label: '이메일' }).toLowerCase();
  if (!EMAIL.test(s)) throw new HttpError(400, '이메일 주소를 정확히 입력해 주세요');
  return s;
}

export function regionCodes(v, { min = 1, max = 3 } = {}) {
  const arr = Array.isArray(v) ? [...new Set(v.map(String))] : [];
  if (arr.length < min) throw new HttpError(400, '지역을 하나 이상 골라 주세요');
  if (arr.length > max) throw new HttpError(400, `지역은 ${max}곳까지 고를 수 있습니다`);
  for (const c of arr) if (!REGION_CODES.has(c)) throw new HttpError(400, '알 수 없는 지역입니다');
  return arr;
}

export function oneOf(v, allowed, label) {
  if (v == null || v === '') return '';
  if (!allowed.includes(v)) throw new HttpError(400, `${label} 값이 올바르지 않습니다`);
  return v;
}

export function mustConsent(v, label) {
  if (v !== true) throw new HttpError(400, `${label}에 동의해 주세요`);
  return true;
}

// 봇이 채우는 숨은 입력칸. 값이 있으면 조용히 성공 처리하고 버린다.
export function isBot(body) {
  return typeof body.website === 'string' && body.website.length > 0;
}
