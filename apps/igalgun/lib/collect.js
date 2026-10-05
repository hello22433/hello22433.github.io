// 수집 배치 검증. api/collect와 테스트·분석 스크립트가 함께 쓴다.
import { sanitize, EXPERIMENTS } from '../public/assets/events.js';

const ID = /^[a-z0-9]{8,32}$/;
export const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|pingdom|monitor/i;
const MAX_EVENTS = 50;

export function parseBatch(body, now = Date.now()) {
  if (!body || !ID.test(body.vid || '') || !ID.test(body.sid || '')) return null;
  const env = {
    vid: body.vid,
    sid: body.sid,
    dev: ['m', 't', 'd'].includes(body.dev) ? body.dev : 'd',
    src: String(body.src || 'direct').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40) || 'direct',
    exp: {},
  };
  for (const [x, v] of Object.entries(body.exp || {})) if (EXPERIMENTS[x]?.includes(v)) env.exp[x] = v;
  const events = [];
  for (const raw of (Array.isArray(body.events) ? body.events : []).slice(0, MAX_EVENTS)) {
    const p = sanitize(raw?.e, raw?.p);
    if (!p) continue;
    const t = Number(raw.t);
    if (!Number.isFinite(t) || Math.abs(t - now) > 86_400_000) continue;
    const path = typeof raw.path === 'string' ? raw.path.slice(0, 80).replace(/[^\w/.-]/g, '') : '/';
    events.push({ e: raw.e, p, t, path });
  }
  return { env, events };
}

