/**
 * 서울시 실시간 지하철 도착정보 프록시 (Cloudflare Worker)
 *
 * 왜 필요한가
 * -----------
 * 1. 인증키 숨기기 — GitHub Pages는 정적이라 브라우저에서 직접 호출하면
 *    키가 JS 소스에 그대로 노출된다. 키는 Worker 시크릿에만 둔다.
 * 2. CORS — 공공 API는 브라우저 직접 호출을 허용하지 않는다.
 * 3. 호출량 절약 — 실시간 API는 일일 호출 한도가 있다. 역 단위로 짧게
 *    캐시해서 같은 역을 여러 명이 봐도 상류 호출은 한 번만 나가게 한다.
 *
 * 엔드포인트
 * ----------
 *   GET /?station=사당          → 정규화된 도착 목록
 *   GET /?station=사당&debug=1  → 상류 원본 응답 (ALLOW_DEBUG=true 일 때만)
 *   GET /health                 → 상태 확인
 *
 * 응답 형태 (자세한 내용은 README 참고)
 *   { station, updatedAt, source: "live", trains: [...] }
 */

const CACHE_SECONDS = 15;      // 상류 호출 간격
const UPSTREAM_TIMEOUT_MS = 6000;
const MAX_ROWS = 20;

// 서울시 API 의 subwayId → 이 앱의 노선 id
const SUBWAY_ID = {
  1001: '1', 1002: '2', 1003: '3', 1004: '4', 1005: '5',
  1006: '6', 1007: '7', 1008: '8', 1009: '9',
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);

    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, hasKey: Boolean(env.SEOUL_API_KEY) });

    const station = (url.searchParams.get('station') || '').trim();
    if (!station) return json({ error: 'station_required' }, 400);
    if (station.length > 20) return json({ error: 'station_too_long' }, 400);

    if (!env.SEOUL_API_KEY) {
      return json({ error: 'key_not_configured', hint: 'wrangler secret put SEOUL_API_KEY' }, 500);
    }

    const debug = url.searchParams.get('debug') === '1' && env.ALLOW_DEBUG === 'true';

    // 같은 역에 대한 상류 호출은 CACHE_SECONDS 동안 한 번만
    const cache = caches.default;
    const cacheKey = new Request(
      new URL('/__cache?station=' + encodeURIComponent(station) + (debug ? '&debug=1' : ''), url.origin),
      { method: 'GET' }
    );
    if (!debug) {
      const hit = await cache.match(cacheKey);
      if (hit) return cors(new Response(hit.body, hit));
    }

    let upstream;
    try {
      upstream = await fetchUpstream(env.SEOUL_API_KEY, station);
    } catch (err) {
      return json({ error: 'upstream_unavailable', detail: String(err && err.message || err) }, 502);
    }

    if (debug) return json(upstream);

    const payload = normalize(station, upstream);
    if (payload.error) return json(payload, 502);

    const res = json(payload, 200, {
      'Cache-Control': 'public, max-age=' + CACHE_SECONDS,
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};

async function fetchUpstream(key, station) {
  // 서울 열린데이터광장 실시간 도착정보 (http 전용)
  const endpoint = 'http://swopenAPI.seoul.go.kr/api/subway/' + encodeURIComponent(key) +
    '/json/realtimeStationArrival/0/' + MAX_ROWS + '/' + encodeURIComponent(station);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(endpoint, { signal: ctrl.signal, cf: { cacheTtl: 0 } });
    if (!r.ok) throw new Error('upstream status ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 상류 응답을 앱이 쓰는 모양으로 정규화한다.
 *
 * 상류 필드명은 API 문서 기준이며, 실제 응답과 다르면 debug=1 로 원본을 확인해
 * 이 함수의 매핑만 고치면 된다. 필드가 없으면 그 값만 비우고 나머지는 살린다.
 */
export function normalize(station, raw) {
  if (raw && raw.errorMessage && raw.errorMessage.status && raw.errorMessage.status !== 200) {
    const m = raw.errorMessage;
    return { error: 'upstream_error', code: m.code, message: m.message };
  }

  const rows = raw && Array.isArray(raw.realtimeArrivalList) ? raw.realtimeArrivalList : [];
  const trains = rows.map((row) => {
    const eta = toInt(row.barvlDt);
    const status = String(row.btrainSttus || '');
    return {
      line: SUBWAY_ID[toInt(row.subwayId)] || null,
      // 종착역. 방향 판정의 기준으로 쓴다.
      terminus: clean(row.bstatnNm),
      // "당고개행 - 사당방면" 같은 원문. 종착역이 비었을 때의 예비 수단.
      lineNm: clean(row.trainLineNm),
      // 상행/하행, 2호선은 내선/외선
      updn: clean(row.updnLine),
      trainNo: clean(row.btrainNo),
      express: /급행|특급/.test(status),
      // 도착 예정 초. 0 이거나 없으면 arvlMsg 로만 판단한다.
      eta: eta > 0 ? eta : null,
      // "전역 출발", "곧 도착" 같은 안내 문구
      message: clean(row.arvlMsg2) || clean(row.arvlMsg3),
      // 현재 위치로 표시되는 역
      at: clean(row.arvlMsg3),
    };
  }).filter((t) => t.line);

  return {
    station,
    updatedAt: new Date().toISOString(),
    source: 'live',
    count: trains.length,
    trains,
  };
}

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function clean(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, 60);
}

function json(body, status = 200, headers = {}) {
  return cors(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  }));
}

function cors(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  h.set('Access-Control-Max-Age', '86400');
  return new Response(res.body, { status: res.status, headers: h });
}
