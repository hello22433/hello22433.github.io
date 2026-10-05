// Upstash Redis(REST) 저장소. Vercel Marketplace에서 Upstash를 연결하면
// KV_REST_API_URL / KV_REST_API_TOKEN 이 자동으로 들어온다.
// 테스트에서는 IGG_MEMORY_STORE=1 로 메모리 저장소를 쓴다.

const memory = { kv: new Map(), lists: new Map(), hashes: new Map() };

function config() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

export function storeReady() {
  return Boolean(config()) || process.env.IGG_MEMORY_STORE === '1';
}

export class StoreUnavailable extends Error {}

async function pipeline(commands) {
  const cfg = config();
  if (!cfg) {
    if (process.env.IGG_MEMORY_STORE === '1') return commands.map(runMemory);
    throw new StoreUnavailable('저장소가 설정되지 않았습니다');
  }
  const res = await fetch(`${cfg.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`저장소 오류 ${res.status}`);
  const out = await res.json();
  return out.map((r) => {
    if (r.error) throw new Error(r.error);
    return r.result;
  });
}

function runMemory([cmd, ...args]) {
  const { kv, lists, hashes } = memory;
  switch (cmd.toUpperCase()) {
    case 'SET': kv.set(args[0], args[1]); return 'OK';
    case 'GET': return kv.has(args[0]) ? kv.get(args[0]) : null;
    case 'INCR': { const v = Number(kv.get(args[0]) || 0) + 1; kv.set(args[0], String(v)); return v; }
    case 'EXPIRE': return 1;
    case 'LPUSH': { const l = lists.get(args[0]) || []; l.unshift(...args.slice(1)); lists.set(args[0], l); return l.length; }
    case 'LRANGE': { const l = lists.get(args[0]) || []; const end = Number(args[2]); return l.slice(Number(args[1]), end === -1 ? undefined : end + 1); }
    case 'LLEN': return (lists.get(args[0]) || []).length;
    case 'HINCRBY': { const h = hashes.get(args[0]) || {}; h[args[1]] = Number(h[args[1]] || 0) + Number(args[2]); hashes.set(args[0], h); return h[args[1]]; }
    case 'HGETALL': { const h = hashes.get(args[0]) || {}; return Object.entries(h).flat().map(String); }
    default: throw new Error(`memory store: ${cmd} 미지원`);
  }
}

export function resetMemoryStore() {
  memory.kv.clear(); memory.lists.clear(); memory.hashes.clear();
}

export const store = {
  async get(key) { const [v] = await pipeline([['GET', key]]); return v ? JSON.parse(v) : null; },
  async set(key, value, ttlSeconds) {
    const cmd = ['SET', key, JSON.stringify(value)];
    if (ttlSeconds) cmd.push('EX', String(ttlSeconds));
    await pipeline([cmd]);
  },
  async push(list, value) { const [n] = await pipeline([['LPUSH', list, JSON.stringify(value)]]); return n; },
  async list(list, limit = 5000) {
    const [items] = await pipeline([['LRANGE', list, '0', String(limit - 1)]]);
    return (items || []).map((s) => JSON.parse(s));
  },
  async count(list) { const [n] = await pipeline([['LLEN', list]]); return n || 0; },
  async hincr(hash, field, by = 1) { await pipeline([['HINCRBY', hash, field, String(by)]]); },
  async hgetall(hash) {
    const [flat] = await pipeline([['HGETALL', hash]]);
    const out = {};
    for (let i = 0; i < (flat || []).length; i += 2) out[flat[i]] = Number(flat[i + 1]);
    return out;
  },
  // 고정 창(window) 방식 요청 제한. 한도를 넘으면 false.
  async allow(bucket, limit, windowSeconds) {
    const key = `rl:${bucket}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
    const [n] = await pipeline([['INCR', key], ['EXPIRE', key, String(windowSeconds)]]);
    return n <= limit;
  },
};
