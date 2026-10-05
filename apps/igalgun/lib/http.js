import { createHash } from 'node:crypto';
import { StoreUnavailable } from './store.js';

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

export function fail(status, message, extra = {}) {
  return json({ ok: false, error: message, ...extra }, status);
}

export async function readBody(request, maxBytes = 16_000) {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, '요청이 너무 큽니다');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, '요청 형식이 올바르지 않습니다');
  }
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// 개인정보 최소화: IP 원문 대신 일 단위 솔트 해시만 남긴다.
export function clientKey(request) {
  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  const day = new Date().toISOString().slice(0, 10);
  return createHash('sha256').update(`${process.env.IGG_SALT || 'igalgun'}:${day}:${ip}`).digest('hex').slice(0, 16);
}

// 정적 사이트(GitHub Pages 등)에서 API를 부를 수 있도록 허용할 출처.
const DEFAULT_ORIGINS = ['https://hello22433.github.io'];
function allowedOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  const list = [...DEFAULT_ORIGINS, ...(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)];
  return list.includes(origin) ? origin : null;
}

function withCors(request, res) {
  const origin = allowedOrigin(request);
  if (!origin) return res;
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Vary', 'Origin');
  return new Response(res.body, { status: res.status, headers });
}

export function preflight(request) {
  const origin = allowedOrigin(request);
  if (!origin) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    },
  });
}

export function handle(fn) {
  return async (request) => {
    let res;
    try {
      res = await fn(request);
    } catch (e) {
      if (e instanceof HttpError) res = fail(e.status, e.message);
      else if (e instanceof StoreUnavailable) res = fail(503, '지금은 접수할 수 없습니다. 잠시 뒤 다시 시도해 주세요.', { code: 'store_unconfigured' });
      else { console.error(e); res = fail(500, '처리 중 오류가 났습니다. 잠시 뒤 다시 시도해 주세요.'); }
    }
    return withCors(request, res);
  };
}

export function requireAdmin(request) {
  const token = process.env.ADMIN_TOKEN;
  const got = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token || token.length < 16 || got !== token) throw new HttpError(401, '관리자 인증이 필요합니다');
}
