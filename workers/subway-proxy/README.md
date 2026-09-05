# subway-proxy

서울시 실시간 지하철 도착정보를 중계하는 Cloudflare Worker.

`/subway/` 앱이 이 Worker를 통해 실시간 도착 정보를 받는다. Worker가 없으면
앱은 시간표상 배차 간격으로 만든 **샘플**을 보여주고 화면에도 그렇게 표시한다.

## 왜 프록시가 필요한가

| 문제 | 프록시가 없으면 | 프록시가 해결하는 방식 |
|---|---|---|
| 인증키 노출 | 정적 사이트라 키가 JS 소스에 그대로 박힌다 | 키는 Worker 시크릿에만 둔다 |
| CORS | 공공 API가 브라우저 직접 호출을 막는다 | Worker가 CORS 헤더를 붙여 준다 |
| 호출 한도 | 보는 사람 수만큼 상류 호출이 나간다 | 역 단위 15초 캐시로 한 번만 나간다 |

## 배포

1. **인증키 발급** — [서울 열린데이터광장](https://data.seoul.go.kr) 회원가입 후
   "지하철 실시간 도착정보" 인증키를 신청한다. 무료이고 즉시 발급된다.

2. **Worker 배포**

   ```console
   $ cd workers/subway-proxy
   $ npm install
   $ npx wrangler login
   $ npx wrangler secret put SEOUL_API_KEY   # 발급받은 키를 붙여넣는다
   $ npx wrangler deploy
   ```

   배포가 끝나면 `https://subway-proxy.<계정>.workers.dev` 주소가 나온다.

3. **앱에 연결** — `subway/config.js` 의 `realtimeEndpoint` 에 그 주소를 적는다.

   ```js
   window.SUBWAY_CONFIG = {
     realtimeEndpoint: 'https://subway-proxy.<계정>.workers.dev'
   };
   ```

   커밋 전에 먼저 시험해 보려면 주소창에 `?api=https://...` 를 붙이면 된다.
   그 값은 브라우저에 저장되고, `?api=` 를 빈 값으로 열면 해제된다.

## 확인

```console
$ curl "https://subway-proxy.<계정>.workers.dev/health"
{"ok":true,"hasKey":true}

$ curl "https://subway-proxy.<계정>.workers.dev/?station=사당"
```

## 상류 필드명이 다를 때

`src/index.js` 의 `normalize()` 는 API 문서 기준 필드명(`realtimeArrivalList`,
`barvlDt`, `bstatnNm`, `trainLineNm`, `updnLine`, `btrainSttus` …)으로 매핑한다.
실제 응답이 다르면 원본을 직접 보고 매핑만 고치면 된다.

```console
$ npx wrangler secret put ALLOW_DEBUG        # true
$ curl "https://subway-proxy.<계정>.workers.dev/?station=사당&debug=1"
$ npx wrangler secret delete ALLOW_DEBUG     # 확인이 끝나면 끈다
```

## 응답 형태

```jsonc
{
  "station": "사당",
  "updatedAt": "2026-09-05T08:12:03.000Z",
  "source": "live",
  "count": 6,
  "trains": [
    {
      "line": "4",              // 노선 id (1~9)
      "terminus": "당고개",      // 종착역 — 앱이 방향을 판정하는 기준
      "lineNm": "당고개행 - 사당방면",
      "updn": "상행",           // 2호선은 내선/외선
      "trainNo": "4056",
      "express": false,
      "eta": 142,               // 도착까지 남은 초 (없으면 null)
      "message": "전역 출발",
      "at": "이수"
    }
  ]
}
```

열차별 혼잡도는 상류가 주지 않으므로 이 응답에 없다. 앱이 사전 계산된 예측값에
**앞차와의 간격**을 곱해서 열차별로 벌린다 (`subway/realtime.js`). 상류가
`congestion` 필드를 주게 되면 그 값이 우선한다.

## 비용

Cloudflare Workers 무료 티어는 하루 10만 요청이다. 15초 캐시가 걸려 있어
상류(서울시 API) 호출은 역 하나당 분당 최대 4회로 묶인다.
