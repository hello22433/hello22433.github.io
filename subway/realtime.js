/* 실시간 도착 정보 계층
 *
 * 두 가지 소스를 같은 모양으로 돌려준다.
 *   live   — config.realtimeEndpoint 로 설정된 Cloudflare Worker 프록시
 *   sample — 엔드포인트가 없을 때 쓰는 샘플. 시간표상 배차 간격으로 만들어낸
 *            가짜 열차이며 화면에도 "샘플"이라고 표시한다.
 *
 * 혼잡도에 대하여
 * ---------------
 * 도착 시각은 실시간이지만 "그 열차가 얼마나 붐비는지"는 대체로 공개되지
 * 않는다. 그래서 사전 계산된 예측값을 기준으로 두고, 앞차와의 간격
 * (headway)으로 열차별 차이를 만든다. 앞차가 방금 지나갔으면 승강장에 쌓인
 * 사람이 적어 덜 붐비고, 간격이 벌어졌으면 그만큼 더 탄다 — 실제로 관찰되는
 * 현상이고, 도착 시각만으로 계산할 수 있다.
 *
 *   재차율 = 기준 예측값 × (앞차와의 간격 / 그 시간대 평균 배차 간격)
 *
 * 상류가 열차별 실측 혼잡도를 준다면 그 값이 우선한다.
 */
(function () {
  'use strict';

  var LS_ENDPOINT = 'subway.endpoint';

  /** 설정된 프록시 주소. ?api= 로 임시 지정할 수 있다. */
  function endpoint() {
    try {
      var q = new URLSearchParams(location.search).get('api');
      if (q !== null) {
        if (q === '') localStorage.removeItem(LS_ENDPOINT);
        else if (/^https:\/\//.test(q)) localStorage.setItem(LS_ENDPOINT, q);
      }
      var saved = localStorage.getItem(LS_ENDPOINT);
      if (saved) return saved;
    } catch (e) { /* 스토리지가 막혀 있으면 설정 파일만 본다 */ }
    var cfg = window.SUBWAY_CONFIG || {};
    return cfg.realtimeEndpoint || '';
  }

  function isOverridden() {
    try { return Boolean(localStorage.getItem(LS_ENDPOINT)); } catch (e) { return false; }
  }

  /** 그 시간대의 평균 배차 간격(초). build_data.py 의 trains_per_hour 와 맞춘 값. */
  function headwaySec(day, hour) {
    var tph;
    if (day === 'wd') {
      if (hour >= 7 && hour < 9) tph = 30;
      else if (hour >= 18 && hour < 19.5) tph = 26;
      else if ((hour >= 6 && hour < 7) || (hour >= 9 && hour < 10) ||
               (hour >= 17 && hour < 18) || (hour >= 19.5 && hour < 20.5)) tph = 18;
      else if (hour < 6) tph = 8;
      else if (hour >= 22.5) tph = 10;
      else tph = 13;
    } else {
      if (hour < 6.5) tph = 7;
      else if (hour >= 22.5) tph = 9;
      else tph = 12;
    }
    return 3600 / tph;
  }

  // --- 샘플 생성 -----------------------------------------------------------

  /** 문자열에서 만든 결정적 난수 (같은 역은 항상 같은 패턴) */
  function seeded(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return function () {
      h += 0x6D2B79F5;
      var t = h;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * 배차 간격 위에 열차를 얹고 편차를 준다. 실제 시각을 쓰기 때문에
   * 화면을 열어 두면 남은 시간이 자연스럽게 줄어든다.
   */
  function sampleArrivals(ctx) {
    var hw = headwaySec(ctx.day, ctx.hour);
    var rnd = seeded(ctx.station + '|' + ctx.dirLabel);
    var phase = rnd() * hw;
    var nowSec = Date.now() / 1000;
    var idx = Math.floor((nowSec - phase) / hw);

    var trains = [];
    for (var k = 0; k < 4; k++) {
      var n = idx + 1 + k;
      var jitter = (seeded(ctx.station + n)() - 0.5) * hw * 0.5;
      var at = n * hw + phase + jitter;
      var eta = Math.round(at - nowSec);
      if (eta < 0) continue;
      trains.push({
        eta: eta,
        // 순환선은 "○○행"이 방향을 설명하지 못하므로 비워 두고 화면에서
        // 방향 이름(내선/외선순환)으로 대신 표시한다.
        terminus: ctx.loop ? '' : ctx.terminus,
        express: ctx.expressLine && ((n % 3) === 0),
        trainNo: '',
        message: '',
        line: ctx.lineId
      });
      if (trains.length >= 3) break;
    }
    return { source: 'sample', updatedAt: new Date().toISOString(), trains: trains };
  }

  // --- 실시간 조회 ---------------------------------------------------------

  function fetchLive(station) {
    var base = endpoint();
    if (!base) return Promise.resolve(null);
    var url = base + (base.indexOf('?') >= 0 ? '&' : '?') + 'station=' + encodeURIComponent(station);
    return fetch(url, { mode: 'cors' })
      .then(function (r) {
        if (!r.ok) throw new Error('프록시 응답 ' + r.status);
        return r.json();
      })
      .then(function (d) {
        if (d && d.error) throw new Error(d.message || d.error);
        return d;
      });
  }

  /**
   * 실시간 목록에서 지금 보고 있는 노선·방향의 열차만 고른다.
   *
   * 방향 판정은 종착역을 쓴다. 열차의 종착역이 내가 선 위치보다 뒤쪽(진행
   * 방향)에 있으면 내가 탈 수 있는 열차다. 상행/하행 표기는 노선마다 뜻이
   * 달라서(2호선은 내선/외선) 예비 수단으로만 쓴다.
   */
  function matchDirection(trains, ctx) {
    var downstream = {};
    ctx.downstream.forEach(function (n) { downstream[n] = true; });

    return trains.filter(function (t) {
      if (t.line && ctx.lineId && t.line !== ctx.lineId) return false;

      if (ctx.loop) {
        var u = t.updn || '';
        if (/내선/.test(u)) return /내선/.test(ctx.dirLabel);
        if (/외선/.test(u)) return /외선/.test(ctx.dirLabel);
      }

      if (t.terminus && downstream[t.terminus]) return true;

      // 종착역이 우리 노선 데이터에 없을 때(연장 운행 등) "○○방면" 문구로 판단
      var m = /-\s*(.+?)방면/.exec(t.lineNm || '');
      if (m && downstream[m[1].trim()]) return true;

      return false;
    });
  }

  /**
   * 앞차와의 간격으로 열차별 혼잡도를 만든다.
   * 첫 열차의 앞 간격은 알 수 없으므로 뒤따르는 간격들의 평균으로 대신한다.
   */
  function applyCongestion(trains, ctx) {
    var hw = headwaySec(ctx.day, ctx.hour);
    var gaps = [];
    for (var i = 1; i < trains.length; i++) {
      gaps.push(Math.max(30, (trains[i].eta || 0) - (trains[i - 1].eta || 0)));
    }
    var avgGap = gaps.length
      ? gaps.reduce(function (a, b) { return a + b; }, 0) / gaps.length
      : hw;

    return trains.map(function (t, i) {
      var gap = i === 0 ? avgGap : Math.max(30, t.eta - trains[i - 1].eta);
      var ratio = Math.max(0.55, Math.min(1.7, gap / hw));
      var v = t.congestion != null
        ? t.congestion                       // 상류가 실측을 주면 그대로
        : Math.round(ctx.baseCongestion * ratio);
      return {
        eta: t.eta,
        terminus: t.terminus,
        express: t.express,
        trainNo: t.trainNo,
        message: t.message,
        gap: Math.round(gap),
        estimated: t.congestion == null,   // 혼잡도가 추정치인지
        congestion: Math.max(0, Math.min(300, v))
      };
    });
  }

  /**
   * ctx = {
   *   station, lineId, dirLabel, loop, terminus, downstream[], expressLine,
   *   day, hour, baseCongestion
   * }
   * → { source: 'live'|'sample', trains: [...], warning? }
   */
  function arrivals(ctx) {
    return fetchLive(ctx.station).then(function (live) {
      if (!live) return sampleArrivals(ctx);
      var mine = matchDirection(live.trains || [], ctx);
      return {
        source: 'live',
        updatedAt: live.updatedAt,
        trains: mine.slice(0, 3),
        warning: (live.trains && live.trains.length && !mine.length)
          ? '이 역의 실시간 정보는 받았지만 이 방향으로 오는 열차를 찾지 못했습니다.'
          : ''
      };
    }).catch(function (err) {
      var s = sampleArrivals(ctx);
      s.warning = '실시간 조회 실패 (' + err.message + ') — 샘플로 대체했습니다.';
      return s;
    }).then(function (res) {
      res.trains = applyCongestion(res.trains || [], ctx);
      return res;
    });
  }

  window.SubwayRealtime = {
    arrivals: arrivals,
    headwaySec: headwaySec,
    endpoint: endpoint,
    isOverridden: isOverridden,
    configured: function () { return Boolean(endpoint()); }
  };
})();
