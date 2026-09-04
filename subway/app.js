/* 덜 붐비는 칸 — 지하철 혼잡도 예측
 *
 * 데이터는 tools/subway/build_data.py 가 미리 계산해 둔 정적 JSON이다.
 * data/index.json  : 노선 목록 + 역 이름(검색용)
 * data/line-N.json : 노선별 상세 (방향 × 요일 × 30분 슬롯의 재차율/하차율)
 */
(function () {
  'use strict';

  var DATA_DIR = 'data/';
  var MIN_PER_STATION = 2.1;   // 역간 평균 소요 시간(분)
  var FAV_KEY = 'subway.favorites';
  var POPULAR = ['신도림', '사당', '강남', '잠실', '홍대입구', '고속터미널', '노원', '여의도'];

  var INDEX = null;
  var LINE_CACHE = {};
  var SLOTS = 40, SLOT_STEP = 30, SLOT_START = 300;
  var CAP = 160, SEATS = 54;

  var state = {
    station: null,   // 역 이름
    options: [],     // 이 역에서 탈 수 있는 열차 목록
    optIdx: 0,
    day: 'wd',
    slot: 6,
    dest: ''
  };

  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- 등급
  var GRADES = [
    { max: 80,       name: '여유',      v: '--g1', desc: '앉거나 편하게 서서 갈 수 있습니다.' },
    { max: 130,      name: '보통',      v: '--g2', desc: '서서 가지만 이동에 불편은 없습니다.' },
    { max: 150,      name: '주의',      v: '--g3', desc: '옆 사람과 어깨가 닿습니다. 문 앞은 피하세요.' },
    { max: 170,      name: '혼잡',      v: '--g4', desc: '몸을 돌리기 어렵습니다. 한 대 보내는 편이 낫습니다.' },
    { max: Infinity, name: '매우 혼잡', v: '--g5', desc: '탑승을 못 할 수도 있습니다. 시간을 옮기는 걸 권합니다.' }
  ];

  function grade(v) {
    for (var i = 0; i < GRADES.length; i++) if (v <= GRADES[i].max) return GRADES[i];
    return GRADES[GRADES.length - 1];
  }
  function color(v) { return 'var(' + grade(v).v + ')'; }

  // ---------------------------------------------------------------- 시각
  function slotLabel(s) {
    var m = SLOT_START + s * SLOT_STEP;
    var h = Math.floor(m / 60), mm = m % 60;
    return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
  }
  function nowSlot() {
    var d = new Date();
    var m = d.getHours() * 60 + d.getMinutes();
    if (m < SLOT_START) m += 24 * 60;             // 00:00~04:59 는 전날 심야로 본다
    var s = Math.round((m - SLOT_START) / SLOT_STEP);
    return Math.max(0, Math.min(SLOTS - 1, s));
  }
  function nowDay() {
    var d = new Date();
    var wd = d.getDay();
    if (d.getHours() < 5) wd = (wd + 6) % 7;      // 심야는 전날로 계산
    return wd === 0 ? 'su' : (wd === 6 ? 'sa' : 'wd');
  }
  var DAY_NAME = { wd: '평일', sa: '토요일', su: '일·공휴일' };

  /** 분 단위를 "1시간 30분" 형태로 */
  function span(mins) {
    var h = Math.floor(mins / 60), m = mins % 60;
    if (!h) return m + '분';
    return h + '시간' + (m ? ' ' + m + '분' : '');
  }

  // ---------------------------------------------------------------- 데이터
  function fetchJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return r.json();
    });
  }
  function loadLine(id) {
    if (LINE_CACHE[id]) return Promise.resolve(LINE_CACHE[id]);
    var meta = INDEX.lines.filter(function (l) { return l.id === id; })[0];
    return fetchJSON(DATA_DIR + meta.file).then(function (d) {
      LINE_CACHE[id] = d;
      return d;
    });
  }
  function linesOf(name) {
    return INDEX.lines.filter(function (l) { return l.stations.indexOf(name) >= 0; })
                      .map(function (l) { return l.id; });
  }

  /** 해당 역에서 탈 수 있는 (노선 × 운행계통 × 방향) 목록 */
  function buildOptions(name) {
    var out = [];
    linesOf(name).forEach(function (lid) {
      var line = LINE_CACHE[lid];
      var si = -1;
      for (var i = 0; i < line.stations.length; i++) {
        if (line.stations[i].n === name) { si = i; break; }
      }
      if (si < 0) return;
      line.runs.forEach(function (run, ri) {
        run.dirs.forEach(function (dir, di) {
          var pos = dir.seq.indexOf(si);
          if (pos < 0) return;
          var isEnd = !run.loop && pos === dir.seq.length - 1;
          if (isEnd) return;                       // 종착역 방향은 탈 수 없다
          var nextPos = (pos + 1) % dir.seq.length;
          out.push({
            line: line, lineId: lid, runIdx: ri, dirIdx: di,
            run: run, dir: dir, pos: pos, stationIdx: si,
            next: line.stations[dir.seq[nextPos]].n
          });
        });
      });
    });
    return out;
  }

  function loadAt(opt, day, slot, pos) {
    var row = opt.dir.load[day][pos === undefined ? opt.pos : pos];
    return row ? row[slot] : 0;
  }
  function alightAt(opt, day, slot, pos) {
    var row = opt.dir.alight[day][pos];
    return row ? row[slot] : 0;
  }

  // ---------------------------------------------------------------- 모델(표시용)
  /** 칸별 혼잡 분포. 승강장 중앙부에 계단·환승통로가 몰리는 일반적 경향을 반영한다. */
  function carShape(cars, transfers, load) {
    var amp = 0.40 + 0.09 * Math.min(transfers, 3);
    var w = [], k, pos, sum = 0;
    for (k = 1; k <= cars; k++) {
      pos = (k - 0.5) / cars;
      w.push(0.80 + amp * Math.exp(-Math.pow((pos - 0.5) / 0.42, 2)));
    }
    for (k = 0; k < cars; k++) sum += w[k];
    var mean = sum / cars;
    // 아주 혼잡하면 승객이 고르게 퍼지므로 편차를 줄인다
    var f = Math.max(0.5, Math.min(1.15, 1.3 - load / 280));
    return w.map(function (x) { return 1 + ((x / mean) - 1) * f; });
  }

  /** 앞으로 3개 역의 하차율을 보고 앉을 확률을 추정한다. */
  function seatProb(opt, day, slot, load) {
    var occ = load / 100 * CAP;
    if (occ <= SEATS * 0.9) return 0.9;
    var remain = 1, n = opt.dir.seq.length;
    for (var i = 1; i <= 3; i++) {
      var p = opt.pos + i;
      if (p >= n) { if (!opt.run.loop) break; p -= n; }
      remain *= (1 - alightAt(opt, day, slot, p) / 100);
    }
    var freed = SEATS * (1 - remain);
    var standing = occ - SEATS;
    return Math.max(0.03, Math.min(0.92, freed / (standing * 0.85 + freed + 3)));
  }

  function transfersOf(opt) {
    var st = opt.line.stations[opt.stationIdx];
    return st.t ? st.t.length : 0;
  }

  // ---------------------------------------------------------------- 검색 UI
  var searchList = [];   // {name, lines:[id]}
  function buildSearchList() {
    var map = {};
    INDEX.lines.forEach(function (l) {
      l.stations.forEach(function (n) {
        (map[n] = map[n] || []).push(l.id);
      });
    });
    searchList = Object.keys(map).map(function (n) { return { name: n, lines: map[n] }; });
    searchList.sort(function (a, b) { return a.name.localeCompare(b.name, 'ko'); });
  }

  function lineMeta(id) {
    return INDEX.lines.filter(function (l) { return l.id === id; })[0];
  }
  function pill(id) {
    var m = lineMeta(id);
    return '<span class="line-pill" style="background:' + m.color + '">' + m.id + '</span>';
  }

  function renderSuggest(q) {
    var box = $('suggest');
    if (!q) { box.hidden = true; box.innerHTML = ''; $('q').setAttribute('aria-expanded', 'false'); return; }
    var starts = [], contains = [];
    searchList.forEach(function (s) {
      var i = s.name.indexOf(q);
      if (i === 0) starts.push(s); else if (i > 0) contains.push(s);
    });
    var hits = starts.concat(contains).slice(0, 12);
    if (!hits.length) {
      box.innerHTML = '<li class="muted" aria-disabled="true">검색 결과가 없습니다</li>';
    } else {
      box.innerHTML = hits.map(function (s) {
        return '<li role="option" data-name="' + s.name + '">' +
               s.lines.map(pill).join('') + '<span>' + s.name + '</span></li>';
      }).join('');
    }
    box.hidden = false;
    $('q').setAttribute('aria-expanded', 'true');
  }

  // ---------------------------------------------------------------- 즐겨찾기
  function favs() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch (e) { return []; }
  }
  function setFavs(list) {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(list.slice(0, 8))); } catch (e) {}
    renderFavs();
  }
  function toggleFav(name) {
    var list = favs(), i = list.indexOf(name);
    if (i >= 0) list.splice(i, 1); else list.unshift(name);
    setFavs(list);
    if (state.station) renderTitle();
  }
  function renderFavs() {
    var list = favs(), box = $('favorites');
    box.hidden = !list.length;
    box.innerHTML = list.map(function (n) {
      return '<span class="fav-chip" data-fav="' + n + '">' + n +
             '<span class="x" data-del="' + n + '" role="button" aria-label="' + n + ' 삭제">&times;</span></span>';
    }).join('');
  }

  // ---------------------------------------------------------------- 렌더
  function selectStation(name) {
    var ids = linesOf(name);
    if (!ids.length) return;
    Promise.all(ids.map(loadLine)).then(function () {
      state.station = name;
      state.options = buildOptions(name);
      state.optIdx = 0;
      state.dest = '';
      $('empty').hidden = true;
      $('result').hidden = false;
      $('q').value = '';
      $('clear').hidden = true;
      $('suggest').hidden = true;
      render();
      $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (e) {
      alert('데이터를 불러오지 못했습니다: ' + e.message);
    });
  }

  function renderTitle() {
    var isFav = favs().indexOf(state.station) >= 0;
    $('station-title').innerHTML = state.station +
      ' <button class="ghost-btn" id="fav-btn" type="button" style="margin-left:8px;padding:3px 9px;font-size:12px">' +
      (isFav ? '★ 즐겨찾기 해제' : '☆ 즐겨찾기') + '</button>';
    $('fav-btn').addEventListener('click', function () { toggleFav(state.station); });
  }

  function render() {
    if (!state.station) return;
    renderTitle();
    renderOptions();
    var opt = state.options[state.optIdx];
    if (!opt) return;
    renderDetail(opt);
    renderTrain(opt);
    renderChart(opt);
    renderDestOptions(opt);
    renderTrip(opt);
    renderLineHeat(opt);
  }

  function renderOptions() {
    var day = state.day, slot = state.slot;
    var items = state.options.map(function (o, i) {
      var v = loadAt(o, day, slot);
      var g = grade(v);
      var runName = o.line.runs.length > 1 ? ' · ' + o.run.name.replace(/\s*\(.*\)/, '') : '';
      return '<li><button type="button" data-opt="' + i + '" aria-pressed="' + (i === state.optIdx) + '">' +
        '<span class="line-pill" style="background:' + o.line.color + '">' + o.line.id + '</span>' +
        '<span class="opt-main"><span class="opt-dir">' + o.dir.label + runName + '</span>' +
        '<span class="opt-next">다음 역 · ' + o.next + '</span></span>' +
        '<span class="opt-val"><span class="v" style="color:' + color(v) + '">' + v + '%</span>' +
        '<span class="g">' + g.name + '</span></span>' +
        '<span class="opt-bar"><i style="width:' + Math.min(100, v / 200 * 100) + '%;background:' + color(v) + '"></i></span>' +
        '</button></li>';
    });
    $('options').innerHTML = items.join('');
  }

  function renderDetail(opt) {
    var v = loadAt(opt, state.day, state.slot);
    var g = grade(v);
    $('detail-line').textContent = opt.line.id;
    $('detail-line').style.background = opt.line.color;
    $('detail-dir').textContent = opt.dir.label;
    $('detail-next').textContent = opt.line.name + ' · 다음 역 ' + opt.next;
    $('grade').textContent = g.name;
    $('grade').style.color = 'var(' + g.v + ')';
    $('pct').textContent = v + '%';
    $('pct').style.color = 'var(' + g.v + ')';
    $('gauge-fill').style.width = Math.min(100, v / 300 * 100) + '%';
    $('gauge-fill').style.background = 'var(' + g.v + ')';
    $('grade-desc').textContent = g.desc;

    var p = seatProb(opt, state.day, state.slot, v);
    $('seat-p').textContent = Math.round(p * 100) + '%';
    $('head-count').textContent = Math.round(v / 100 * CAP) + '명';
    $('alight-rate').textContent = alightAt(opt, state.day, state.slot, opt.pos) + '%';

    // 급행이 다니는 노선은 급행·일반의 혼잡도 차이가 매우 크다
    var note = $('express-note');
    var st = opt.line.stations[opt.stationIdx];
    if (st.x) {
      note.hidden = false;
      note.innerHTML = '이 역은 <b>' + opt.line.name + ' 급행 정차역</b>입니다. 위 값은 급행과 일반을 합친 ' +
        '평균이라, 실제로는 <b>급행이 훨씬 혼잡하고 일반열차는 훨씬 여유롭습니다.</b> ' +
        '급행을 한 대 보내고 일반열차를 타면 확실히 덜 붐빕니다.';
    } else {
      note.hidden = true;
    }
  }

  function renderTrain(opt) {
    var v = loadAt(opt, state.day, state.slot);
    var cars = opt.line.cars;
    var shape = carShape(cars, transfersOf(opt), v);
    var vals = shape.map(function (s) { return Math.round(v * s); });
    var min = Math.min.apply(null, vals);
    var cool = opt.line.cool || [];
    var maxH = 78, minH = 40;
    var peak = Math.max.apply(null, vals) || 1;

    $('train-sub').textContent = '진행 방향 →  ' + opt.next + ' 방면 · ' + cars + '량';
    $('train').innerHTML = vals.map(function (cv, i) {
      var k = i + 1;
      var h = minH + (maxH - minH) * (cv / peak);
      var best = cv === min;
      return '<div class="car' + (best ? ' best' : '') + '" style="height:' + h.toFixed(0) + 'px;background:' + color(cv) + '">' +
        (best ? '<span class="flag">여유</span>' : '') +
        '<span class="num">' + k + '</span>' +
        '<span class="val">' + cv + '%</span>' +
        (cool.indexOf(k) >= 0 ? '<span class="cool">약냉방</span>' : '') +
        '</div>';
    }).join('');

    var bestCars = [];
    vals.forEach(function (cv, i) { if (cv <= min + 2) bestCars.push(i + 1); });
    var diff = Math.round(Math.max.apply(null, vals) - min);
    var doors = bestCars[0] + '-1 ~ ' + bestCars[0] + '-4';
    $('car-tip').innerHTML =
      '가장 여유로운 칸은 <b>' + bestCars.join('번, ') + '번 칸</b>입니다. ' +
      '가장 붐비는 칸보다 <b>' + diff + '%p</b> 낮습니다. ' +
      '승강장 바닥의 <b>' + doors + '</b> 표시 앞에서 기다리세요.' +
      (cool.length ? ' <span class="muted">(' + cool.join('·') + '번 칸은 약냉방칸)</span>' : '') +
      '<br><span class="muted">칸별 값은 승강장 계단·환승통로가 중앙부에 몰리는 일반적 경향을 적용한 추정입니다.</span>';
  }

  function renderChart(opt) {
    var day = state.day;
    var vals = [];
    for (var s = 0; s < SLOTS; s++) vals.push(loadAt(opt, day, s));
    var maxV = Math.max(200, Math.max.apply(null, vals) * 1.12);
    var W = 400, H = 150, PAD = 4;

    function x(i) { return PAD + i * (W - PAD * 2) / (SLOTS - 1); }
    function y(v) { return H - (v / maxV) * H; }

    var pts = vals.map(function (v, i) { return x(i).toFixed(1) + ',' + y(v).toFixed(1); }).join(' ');
    var area = 'M' + x(0).toFixed(1) + ',' + H + ' L' + pts.split(' ').join(' L') + ' L' + x(SLOTS - 1).toFixed(1) + ',' + H + ' Z';
    var cur = state.slot, curV = vals[cur];
    var thresholds = [80, 130, 170].filter(function (t) { return t < maxV; });

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="시간대별 혼잡도">' +
      thresholds.map(function (t) {
        return '<line x1="0" y1="' + y(t).toFixed(1) + '" x2="' + W + '" y2="' + y(t).toFixed(1) +
               '" stroke="currentColor" stroke-opacity=".14" stroke-dasharray="3 4"/>';
      }).join('') +
      '<path d="' + area + '" fill="' + color(curV) + '" fill-opacity=".16"/>' +
      '<polyline points="' + pts + '" fill="none" stroke="' + color(curV) + '" stroke-width="2.2" stroke-linejoin="round"/>' +
      '<line x1="' + x(cur).toFixed(1) + '" y1="0" x2="' + x(cur).toFixed(1) + '" y2="' + H + '" stroke="currentColor" stroke-opacity=".35"/>' +
      '<circle cx="' + x(cur).toFixed(1) + '" cy="' + y(curV).toFixed(1) + '" r="4.5" fill="' + color(curV) + '" stroke="var(--surface)" stroke-width="2"/>' +
      '</svg>' +
      '<div class="chart-x">' + [2, 8, 14, 20, 26, 32, 38].map(function (i) {
        return '<span style="left:' + (i / (SLOTS - 1) * 100).toFixed(1) + '%">' +
               slotLabel(i).slice(0, 2) + '</span>';
      }).join('') + '</div>';
    $('chart-wrap').innerHTML = svg;

    $('chart-wrap').onclick = function (ev) {
      var r = this.getBoundingClientRect();
      var i = Math.round((ev.clientX - r.left) / r.width * (SLOTS - 1));
      setSlot(Math.max(0, Math.min(SLOTS - 1, i)));
    };

    // ±2시간 안에서 가장 여유로운 시각
    var best = cur, bestV = curV;
    for (var d = -4; d <= 4; d++) {
      var i2 = cur + d;
      if (i2 < 0 || i2 >= SLOTS || d === 0) continue;
      if (vals[i2] < bestV - 0.5) { bestV = vals[i2]; best = i2; }
    }
    var gain = curV - bestV;
    if (gain >= 8) {
      var mins = (best - cur) * SLOT_STEP;
      var when = span(Math.abs(mins)) + (mins > 0 ? ' 뒤' : ' 일찍');
      $('shift-tip').innerHTML = '<b>' + when + '(' + slotLabel(best) + ')</b> 타면 ' +
        '<b style="color:' + color(bestV) + '">' + bestV + '%</b>로 <b>' + Math.round(gain) + '%p</b> 덜 붐빕니다.';
    } else {
      $('shift-tip').innerHTML = '앞뒤 2시간 안에서는 지금(<b>' + slotLabel(cur) + '</b>)이 크게 나쁘지 않습니다. ' +
        '차이가 <b>' + Math.round(gain) + '%p</b> 이내입니다.';
    }
  }

  function renderDestOptions(opt) {
    var n = opt.dir.seq.length;
    var limit = opt.run.loop ? n - 1 : n - 1 - opt.pos;
    var html = ['<option value="">— 하차역 선택 —</option>'];
    for (var d = 1; d <= limit; d++) {
      var p = opt.pos + d;
      if (p >= n) p -= n;
      html.push('<option value="' + d + '"' + (String(d) === String(state.dest) ? ' selected' : '') + '>' +
                opt.line.stations[opt.dir.seq[p]].n + ' (' + d + '개 역)</option>');
    }
    $('dest').innerHTML = html.join('');
  }

  function renderTrip(opt) {
    var box = $('trip');
    if (!state.dest) { box.hidden = true; return; }
    var steps = parseInt(state.dest, 10);
    var n = opt.dir.seq.length;
    var legs = [], maxV = 0;
    for (var d = 0; d < steps; d++) {
      var p = opt.pos + d;
      if (p >= n) p -= n;
      var minsIn = d * MIN_PER_STATION;
      var slot = Math.min(SLOTS - 1, state.slot + Math.round(minsIn / SLOT_STEP));
      var v = loadAt(opt, state.day, slot, p);
      if (v > maxV) maxV = v;
      legs.push({ name: opt.line.stations[opt.dir.seq[p]].n, v: v });
    }
    var pEnd = opt.pos + steps; if (pEnd >= n) pEnd -= n;
    var total = Math.round(steps * MIN_PER_STATION);
    var arriveMin = SLOT_START + state.slot * SLOT_STEP + total;
    var ah = Math.floor(arriveMin / 60), am = arriveMin % 60;
    var arriveLabel = (ah < 10 ? '0' : '') + ah + ':' + (am < 10 ? '0' : '') + am;

    var seatEnd = seatProb(opt, state.day, state.slot, legs[0].v);
    box.hidden = false;
    box.innerHTML =
      '<div class="trip-summary">' +
        '<div class="stat"><span class="stat-label">' + opt.line.stations[opt.dir.seq[pEnd]].n + '까지</span><strong>' + total + '분</strong></div>' +
        '<div class="stat"><span class="stat-label">도착 예정</span><strong>' + arriveLabel + '</strong></div>' +
        '<div class="stat"><span class="stat-label">구간 최고 혼잡</span><strong style="color:' + color(maxV) + '">' + maxV + '%</strong></div>' +
      '</div>' +
      '<ul class="trip-legs">' + legs.map(function (l) {
        return '<li><span class="nm">' + l.name + '</span>' +
          '<span class="bar"><i style="width:' + Math.min(100, l.v / 200 * 100) + '%;background:' + color(l.v) + '"></i></span>' +
          '<span class="pc">' + l.v + '%</span></li>';
      }).join('') + '</ul>' +
      '<p class="tip">출발 시점 착석 확률 <b>' + Math.round(seatEnd * 100) + '%</b>. ' +
      '앉아서 가고 싶다면 붐비는 구간(' + maxV + '%) 전에 자리가 나는지가 관건입니다.</p>';
  }

  function renderLineHeat(opt) {
    var day = state.day, slot = state.slot;
    $('line-sub').textContent = opt.line.name + ' · ' + opt.dir.label + ' · ' +
      DAY_NAME[day] + ' ' + slotLabel(slot) + ' 기준';
    var rows = opt.dir.seq.map(function (si, i) {
      var v = opt.dir.load[day][i][slot];
      var st = opt.line.stations[si];
      var here = i === opt.pos;
      return '<div class="row' + (here ? ' here' : '') + '">' +
        '<span class="nm">' + (here ? '▶ ' : '') + st.n + (st.x ? ' <span class="muted">급행</span>' : '') + '</span>' +
        '<span class="bar"><i style="width:' + Math.min(100, v / 200 * 100) + '%;background:' + color(v) + '"></i></span>' +
        '<span class="pc">' + v + '%</span></div>';
    });
    var box = $('line-heat');
    box.innerHTML = rows.join('');
    // 긴 노선에서도 지금 서 있는 역이 바로 보이도록 스크롤을 맞춘다
    var here = box.querySelector('.row.here');
    if (here) box.scrollTop = Math.max(0, here.offsetTop - box.clientHeight / 3);
  }

  // ---------------------------------------------------------------- 상태 변경
  function setSlot(s) {
    state.slot = s;
    $('time-range').value = s;
    $('time-label').textContent = slotLabel(s);
    render();
  }
  function setDay(d) {
    state.day = d;
    $('day-label').textContent = DAY_NAME[d];
    Array.prototype.forEach.call(document.querySelectorAll('.day-btn'), function (b) {
      b.setAttribute('aria-checked', String(b.dataset.day === d));
    });
    render();
  }

  // ---------------------------------------------------------------- 초기화
  function bind() {
    var q = $('q');
    q.addEventListener('input', function () {
      $('clear').hidden = !q.value;
      renderSuggest(q.value.trim());
    });
    q.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var first = $('suggest').querySelector('li[data-name]');
      if (first) selectStation(first.dataset.name);
    });
    $('clear').addEventListener('click', function () {
      q.value = ''; $('clear').hidden = true; renderSuggest('');
    });
    $('suggest').addEventListener('click', function (e) {
      var li = e.target.closest('li[data-name]');
      if (li) selectStation(li.dataset.name);
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.search-box')) $('suggest').hidden = true;
    });

    $('favorites').addEventListener('click', function (e) {
      var del = e.target.closest('[data-del]');
      if (del) { toggleFav(del.dataset.del); return; }
      var chip = e.target.closest('[data-fav]');
      if (chip) selectStation(chip.dataset.fav);
    });

    $('options').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-opt]');
      if (!b) return;
      state.optIdx = parseInt(b.dataset.opt, 10);
      state.dest = '';
      render();
    });

    $('time-range').addEventListener('input', function () { setSlot(parseInt(this.value, 10)); });
    $('now-btn').addEventListener('click', function () { setDay(nowDay()); setSlot(nowSlot()); });
    Array.prototype.forEach.call(document.querySelectorAll('.day-btn'), function (b) {
      b.addEventListener('click', function () { setDay(b.dataset.day); });
    });
    $('dest').addEventListener('change', function () {
      state.dest = this.value;
      renderTrip(state.options[state.optIdx]);
    });
    $('quick').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-name]');
      if (b) selectStation(b.dataset.name);
    });
  }

  fetchJSON(DATA_DIR + 'index.json').then(function (idx) {
    INDEX = idx;
    SLOTS = idx.slots.count;
    SLOT_STEP = idx.slots.step;
    SLOT_START = idx.slots.start;
    CAP = idx.capacityPerCar;
    SEATS = idx.seatsPerCar;
    $('gen-at').textContent = idx.generated;
    $('time-range').max = String(SLOTS - 1);

    buildSearchList();
    renderFavs();
    $('quick').innerHTML = POPULAR.filter(function (n) {
      return searchList.some(function (s) { return s.name === n; });
    }).map(function (n) {
      return '<button type="button" data-name="' + n + '">' + n + '</button>';
    }).join('');

    bind();
    setDay(nowDay());
    setSlot(nowSlot());
  }).catch(function (e) {
    $('empty').innerHTML = '<p>데이터를 불러오지 못했습니다.<br><span class="muted">' + e.message + '</span></p>';
  });
})();
