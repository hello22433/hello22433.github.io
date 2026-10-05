// 점수 계산 공용 모듈. 브라우저(app.js)와 서버(api/report)가 같은 코드를 쓴다.

export const FACTORS = [
  { k: 'vital', label: '인구 활력', hint: '최근 1년·10년 인구 증감' },
  { k: 'peer', label: '또래 청년', hint: '20~39세 비율' },
  { k: 'med', label: '의료', hint: '인구 대비 병·의원, 소아과·산부인과' },
  { k: 'move', label: '교통', hint: 'KTX역·서울까지 거리' },
  { k: 'money', label: '정착 지원', hint: '지원금 최대액과 기본소득' },
  { k: 'kids', label: '아이 키우기', hint: '출산지원금, 아동 비율, 소아과' },
];

export const PROFILES = [
  { id: 'remote', name: '청년·원격근무', sub: '1인, 20~30대', w: { vital: 3, peer: 4, med: 1, move: 4, money: 3, kids: 0 }, sup: { youth: 1, housing: 1, transfer: 1, farm: 0.2 } },
  { id: 'family', name: '신혼·아이 계획', sub: '2~4인 가구', w: { vital: 2, peer: 2, med: 4, move: 2, money: 2, kids: 5 }, sup: { youth: 0.6, housing: 1, transfer: 1, farm: 0.2 } },
  { id: 'farm', name: '귀농·귀촌', sub: '농사, 전원생활', w: { vital: 1, peer: 1, med: 2, move: 1, money: 5, kids: 0 }, sup: { farm: 1.2, housing: 1, transfer: 0.6, youth: 0.4 } },
  { id: 'retire', name: '은퇴 후 전원생활', sub: '50~60대 부부', w: { vital: 2, peer: 0, med: 5, move: 3, money: 3, kids: 0 }, sup: { housing: 1, transfer: 1, farm: 0.6, youth: 0 } },
];

// 농어촌 기본소득 2년분. 기본 월 15만 원, 군비를 더하는 곳은 bi_monthly에 기록.
export const basicIncome2y = (r) => (r.basic_income ? (r.bi_monthly || 150_000) * 24 : 0);

export function rankPct(vals) {
  const idx = vals.map((v, i) => [v, i]).filter((x) => x[0] != null).sort((a, b) => a[0] - b[0]);
  const out = vals.map(() => null);
  const n = idx.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
    const p = n > 1 ? (i + j) / 2 / (n - 1) : 0.5;
    for (let k = i; k <= j; k++) out[idx[k][1]] = p;
    i = j + 1;
  }
  return out;
}

const fill = (arr, d = 0.5) => arr.map((v) => (v == null ? d : v));
export const amount = (r, k) => (r.inc && r.inc[k] && r.inc[k].amount ? Math.min(r.inc[k].amount, 5e7) : null);
export const birthTotal = (r) => (r.inc && r.inc.birth && (r.inc.birth.first || r.inc.birth.third) ? (r.inc.birth.first || 0) + (r.inc.birth.third || 0) : null);

export function supportTotal(r, w) {
  let s = 0;
  let known = 0;
  for (const [k, wt] of Object.entries(w)) {
    const a = amount(r, k);
    if (a != null) { s += a * wt; known++; }
  }
  s += basicIncome2y(r);
  return known || r.basic_income ? s : null;
}

// regions 배열과 가중치로 각 지역의 지표 백분위(f)와 0~100 점수를 계산한다.
export function scoreAll(R, profileId, weights) {
  const prof = PROFILES.find((p) => p.id === profileId) || PROFILES[0];
  const W = weights || prof.w;
  const chg12 = rankPct(R.map((r) => r.chg12m));
  const chg10 = rankPct(R.map((r) => r.chg10));
  const young = rankPct(R.map((r) => r.young));
  const kids = rankPct(R.map((r) => r.kids));
  const med = rankPct(R.map((r) => r.clinic_per10k));
  const ktx = rankPct(R.map((r) => -r.ktx_km));
  const seoul = rankPct(R.map((r) => -r.seoul_km));
  const birth = fill(rankPct(R.map(birthTotal)));
  const sup = fill(rankPct(R.map((r) => supportTotal(r, prof.sup))));
  const spec = R.map((r) => (r.med.ped > 0 ? 0.5 : 0) + (r.med.obgyn > 0 ? 0.5 : 0));
  const f = {
    vital: R.map((r, i) => 0.6 * chg12[i] + 0.4 * chg10[i]),
    peer: young,
    med: R.map((r, i) => 0.6 * med[i] + 0.4 * spec[i]),
    move: R.map((r, i) => 0.6 * ktx[i] + 0.4 * seoul[i]),
    money: sup,
    kids: R.map((r, i) => 0.5 * birth[i] + 0.25 * kids[i] + 0.25 * spec[i]),
  };
  const tot = Object.values(W).reduce((a, b) => a + b, 0) || 1;
  const raw = R.map((r, i) => FACTORS.reduce((s, F) => s + (W[F.k] || 0) * f[F.k][i], 0) / tot);
  const mn = Math.min(...raw);
  const mx = Math.max(...raw);
  return R.map((r, i) => ({
    code: r.code,
    score: Math.round(((raw[i] - mn) / (mx - mn || 1)) * 100),
    f: Object.fromEntries(FACTORS.map((F) => [F.k, f[F.k][i]])),
  }));
}

export function won(n) {
  if (n == null) return '';
  if (n >= 1e8) return `${(n / 1e8).toFixed(n % 1e8 ? 1 : 0)}억 원`;
  if (n >= 1e4) return `${Math.round(n / 1e4).toLocaleString('ko-KR')}만 원`;
  return `${n.toLocaleString('ko-KR')}원`;
}

// 받침에 따라 조사를 고른다: josa('정선군', '을', '를') → '정선군을'
export function josa(word, withBatchim, without) {
  const c = String(word).charCodeAt(String(word).length - 1);
  const has = c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 !== 0 : false;
  return word + (has ? withBatchim : without);
}
