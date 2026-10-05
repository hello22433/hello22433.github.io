// 로그 수집기. track.js가 모아 보낸 이벤트 묶음을 검증하고 집계·원본으로 저장한다.
// sendBeacon이 교차 출처에서도 동작하도록 본문은 text/plain JSON으로 받는다.
import { exec, store, storeReady } from '../lib/store.js';
import { preflight, handle, clientKey } from '../lib/http.js';
import { parseBatch, BOT } from '../lib/collect.js';
import { opsFor, rawOps, kstDay } from '../lib/aggregate.js';

export const POST = handle(async (request) => {
  if (!storeReady()) return new Response(null, { status: 204 });
  const ua = request.headers.get('user-agent') || '';
  if (BOT.test(ua) && process.env.IGG_ALLOW_HEADLESS !== '1') return new Response(null, { status: 204 });
  const text = await request.text();
  if (text.length > 64_000) return new Response(null, { status: 413 });
  let body;
  try { body = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
  const batch = parseBatch(body);
  if (!batch || !batch.events.length) return new Response(null, { status: 204 });
  if (!(await store.allow(`col:${clientKey(request)}`, 1500, 3600))) return new Response(null, { status: 429 });
  const day = kstDay();
  const ops = batch.events.flatMap((ev) => opsFor(batch.env, ev, day));
  const records = batch.events.map((ev) => ({ ...ev, vid: batch.env.vid, sid: batch.env.sid, dev: batch.env.dev, src: batch.env.src, exp: batch.env.exp }));
  await exec([...ops, ...rawOps(day, records)]);
  return new Response(null, { status: 204 });
});

export const OPTIONS = preflight;
