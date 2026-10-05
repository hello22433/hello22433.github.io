// 지표 → 개선 과제. 규칙마다 근거 숫자와 바로 할 일을 함께 낸다.
// 순수 함수라 서버(관리 화면, 주간 메일)와 오프라인 분석기(scripts/analyze.mjs)가 같이 쓴다.
import { FUNNEL } from '../public/assets/events.js';
import { josa } from '../public/assets/score.js';

const SEV = { high: 0, mid: 1, low: 2, info: 3 };
const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '–' : `${(x * 100).toFixed(d)}%`);
const fmt = (n) => Number(n || 0).toLocaleString('ko-KR');
const rate = (a, b) => (b > 0 ? a / b : null);
const top = (h, n = 5) => Object.entries(h || {}).sort((a, b) => b[1] - a[1]).slice(0, n);

// 관심지역 18곳(인구감소지역 아님). 검색 실패어가 여기에 걸리면 확장 수요로 본다.
const INTEREST = ['동구', '중구', '대덕구', '금정구', '강릉', '동해', '인제', '속초', '경주', '김천', '통영', '사천', '동두천', '포천', '익산'];

// 퍼널 단계별 기대치(초기 정보 서비스 기준 경험값). 이보다 낮으면 과제로 올린다.
const BENCH = { engaged: 0.35, compare_add: 0.15, intent: 0.15, convert: 0.2 };
const FUNNEL_ACTIONS = {
  engaged: '첫 화면에서 할 일을 하나로 줄이세요. 진단 버튼을 더 크게 두거나, 상위 3곳 미리보기를 첫 화면에 바로 보여 주는 안을 실험하세요.',
  compare_add: '목록 카드에 비교 담기 버튼이 잘 안 보입니다. 상세 서랍 하단에 "이 지역과 비슷한 곳 2곳 함께 비교" 버튼을 추가하세요.',
  intent: '비교 뒤 다음 행동이 약합니다. 비교표 바로 아래에 상담·리포트 버튼을 두고, 지역 상세에서 상담 카드를 첫 화면 안으로 올리세요.',
  convert: '신청서 단계에서 빠집니다. 필수 항목을 연락처 하나로 줄이고, 오류가 많은 입력칸 문구를 고치세요.',
};

// 두 비율 차이의 z-검정 (양측). p<0.05면 유의.
export function zTest(c1, n1, c2, n2) {
  if (n1 < 1 || n2 < 1) return null;
  const p1 = c1 / n1, p2 = c2 / n2, p = (c1 + c2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return { z: 0, p: 1, lift: 0 };
  const z = (p1 - p2) / se;
  const pv = 2 * (1 - phi(Math.abs(z)));
  return { z, p: pv, lift: p2 ? p1 / p2 - 1 : null };
}
function phi(x) { // 표준정규 누적분포 근사 (Abramowitz-Stegun)
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989423 * Math.exp(-x * x / 2);
  return 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
}
// 80% 검정력, 유의수준 5%에서 변형당 필요한 표본
export function sampleNeeded(base, mde = 0.2) {
  if (!base || base <= 0 || base >= 1) return null;
  const p2 = base * (1 + mde);
  const pbar = (base + p2) / 2;
  return Math.ceil((1.96 * Math.sqrt(2 * pbar * (1 - pbar)) + 0.84 * Math.sqrt(base * (1 - base) + p2 * (1 - p2))) ** 2 / (p2 - base) ** 2);
}

export function funnelOf(m) {
  const steps = FUNNEL.map(([key, label]) => ({ key, label, uv: m.uv[key] || 0 }));
  steps.forEach((s, i) => {
    s.ofVisit = rate(s.uv, steps[0].uv);
    s.fromPrev = i ? rate(s.uv, steps[i - 1].uv) : 1;
  });
  return steps;
}

export function buildInsights(m, { regions = [], truth = {} } = {}) {
  const name = Object.fromEntries(regions.map((r) => [r.code, `${r.sido} ${r.name}`]));
  const F = [];
  const add = (f) => F.push(f);
  const V = m.visitors || 0;
  const funnel = funnelOf(m);
  const uv = m.uv || {};

  if (V < 50) {
    add({ id: 'sample', area: '데이터', severity: 'info', title: `방문자 ${fmt(V)}명, 아직 판단하기 이릅니다`,
      evidence: `${m.range.from} ~ ${m.range.to}. 대부분의 규칙은 방문자 50명, 실험은 변형당 100명 이상부터 결론을 냅니다.`,
      action: '지역 페이지 몇 곳을 커뮤니티(귀농귀촌 카페, 지역 맘카페)에 공유해 첫 표본을 모으세요.' });
  }

  // 1. 퍼널
  if (V >= 50) {
    let worst = null;
    for (const s of funnel.slice(1)) {
      const base = s.key === 'convert' ? funnel.find((x) => x.key === 'intent') : funnel.find((x) => x.key === 'engaged');
      const r = s.key === 'engaged' ? s.ofVisit : rate(s.uv, base.uv);
      const gap = r == null ? 0 : (BENCH[s.key] - r) / BENCH[s.key];
      if (gap > 0.2 && (!worst || gap > worst.gap)) worst = { s, r, gap };
    }
    if (worst) {
      add({ id: `funnel_${worst.s.key}`, area: '퍼널', severity: worst.gap > 0.5 ? 'high' : 'mid',
        title: `가장 큰 이탈: "${worst.s.label}" 단계 ${pct(worst.r)} (기대 ${pct(BENCH[worst.s.key], 0)})`,
        evidence: funnel.map((s) => `${s.label} ${fmt(s.uv)}명`).join(' → '),
        action: FUNNEL_ACTIONS[worst.s.key], metric: { step: worst.s.key, rate: worst.r } });
    }
  }

  // 2. 진단(퀴즈)
  const qs = uv.quiz_start || 0;
  if (qs >= 20) {
    const done = uv.quiz_complete || 0;
    const steps = m.dims.quiz_step || {};
    const reach = [qs, steps[1] || 0, steps[2] || 0, steps[3] || 0, m.events.quiz_complete || 0];
    let drop = { i: -1, d: 0 };
    for (let i = 1; i < reach.length; i++) {
      const d = reach[i - 1] ? 1 - reach[i] / reach[i - 1] : 0;
      if (d > drop.d) drop = { i, d };
    }
    const comp = rate(done, qs);
    const labels = ['', '2번(일 방식)', '3번(우선순위)', '4번(수도권 왕래)', '결과 보기'];
    if (comp < 0.6) {
      add({ id: 'quiz_drop', area: '진단', severity: comp < 0.4 ? 'high' : 'mid', title: `진단 완료율 ${pct(comp)} — ${labels[drop.i] || ''} 문항에서 가장 많이 빠짐`,
        evidence: `시작 ${fmt(qs)}명, 완료 ${fmt(done)}명. 단계별 도달 ${reach.map(fmt).join(' → ')}. 건너뛰기 ${fmt(Object.values(m.dims.quiz_skip || {}).reduce((a, b) => a + b, 0))}회.`,
        action: drop.i === 2 ? '우선순위 문항을 "하나만 고르기"로 바꾸고 선택지를 4개로 줄이세요.' : '해당 문항에 기본값을 미리 선택해 두고, 진행 막대에 "남은 질문 N개"를 표시하세요.' });
    }
    const prof = top(m.dims.quiz_profile, 4);
    if (prof.length && done >= 20) {
      const [p0, c0] = prof[0];
      const label = { remote: '청년·원격근무', family: '신혼·아이 계획', farm: '귀농·귀촌', retire: '은퇴 후 전원생활' }[p0] || p0;
      add({ id: 'quiz_profile', area: '진단', severity: 'info', title: `방문자 상황 1위: ${label} (${pct(c0 / done, 0)})`,
        evidence: prof.map(([k, v]) => `${k} ${fmt(v)}`).join(', '),
        action: `${label}용 랜딩(지역 페이지 상단 요약, 리포트 예시)을 먼저 다듬고, 이 집단 대상 커뮤니티에 홍보하세요.` });
    }
  }

  // 3. 검색
  const misses = top(m.dims.search_miss, 8).filter(([, c]) => c >= 2);
  const searches = Object.values(m.dims.search || {}).reduce((a, b) => a + b, 0);
  if (misses.length) {
    const outside = misses.filter(([q]) => INTEREST.some((x) => q.includes(x)));
    add({ id: 'search_miss', area: '검색', severity: rate(misses.reduce((a, [, c]) => a + c, 0), searches) > 0.15 ? 'mid' : 'low',
      title: `검색 실패 상위어: ${misses.slice(0, 4).map(([q]) => `"${q}"`).join(', ')}`,
      evidence: `전체 검색 ${fmt(searches)}회 중 결과 없음 ${fmt(misses.reduce((a, [, c]) => a + c, 0))}회.`,
      action: outside.length
        ? `${josa(outside.map(([q]) => q).join(', '), '은', '는')} 인구감소 '관심지역'입니다. 관심지역 18곳을 2차 지원 대상으로 추가하면 이 수요를 받을 수 있습니다.`
        : '오타·약칭을 검색 동의어로 등록하고(예: "남해" ↔ "남해군"), 결과가 없을 때 비슷한 지역을 추천하세요.' });
  }

  // 4. 지역 수요와 B2G 영업 우선순위
  const R = m.regions || {};
  const codes = new Set(Object.values(R).flatMap((h) => Object.keys(h)));
  const rows = [...codes].map((c) => {
    const v = R.region_open?.[c] || 0, cmp = R.compare_add?.[c] || 0, lo = R.lead_open?.[c] || 0, ls = R.lead_submit?.[c] || 0;
    return { code: c, name: name[c] || c, views: v, compare: cmp, leadOpen: lo, leads: ls, corrections: R.correction_click?.[c] || 0, subs: R.subscribe_submit?.[c] || 0,
      score: ls * 10 + lo * 3 + cmp * 2 + v * 0.2 + (R.subscribe_submit?.[c] || 0) * 4 };
  }).sort((a, b) => b.score - a.score);
  const salesTargets = rows.slice(0, 10);
  if (salesTargets.length && salesTargets[0].score >= 10) {
    add({ id: 'b2g_targets', area: '수익', severity: 'mid', title: `지자체 영업 1순위: ${salesTargets.slice(0, 3).map((r) => r.name).join(', ')}`,
      evidence: salesTargets.slice(0, 3).map((r) => `${r.name} 조회 ${fmt(r.views)} · 비교 ${fmt(r.compare)} · 상담 ${fmt(r.leads)}`).join(' / '),
      action: '이 시·군 인구정책 부서에 월간 관심도 리포트 샘플을 보내고 "정보 인증" 플랜(연 300만 원)을 제안하세요. 실제 관심 숫자가 가장 강한 영업 근거입니다.' });
  }
  const leaky = rows.filter((r) => r.views >= 30 && rate(r.leadOpen, r.views) < 0.02).slice(0, 3);
  if (leaky.length) {
    add({ id: 'region_leaky', area: '지역', severity: 'low', title: `많이 보지만 상담으로 안 이어지는 지역: ${leaky.map((r) => r.name).join(', ')}`,
      evidence: leaky.map((r) => `${r.name} 조회 ${fmt(r.views)} → 상담 열기 ${fmt(r.leadOpen)}`).join(' / '),
      action: '이 지역 페이지의 정착 지원 항목이 비어 있거나 오래됐는지 확인하고 보강하세요. 지원 정보가 구체적일수록 상담이 늘어납니다.' });
  }
  const corr = rows.filter((r) => r.corrections > 0).sort((a, b) => b.corrections - a.corrections).slice(0, 5);
  if (corr.length) {
    add({ id: 'data_corrections', area: '데이터', severity: 'mid', title: `정보 정정 요청이 눌린 지역: ${corr.map((r) => r.name).join(', ')}`,
      evidence: corr.map((r) => `${r.name} ${r.corrections}회`).join(', '),
      action: '해당 시·군 공고를 다시 확인해 지원 금액·기간을 갱신하세요. 틀린 정보는 신뢰와 지자체 영업 모두에 치명적입니다.' });
  }

  // 5. 기기
  const D = m.devices || {};
  const conv = (s) => rate(s?.convert || 0, s?.page_view || 0);
  const eng = (s) => rate(s?.engaged || 0, s?.page_view || 0);
  if ((D.m?.page_view || 0) >= 50 && (D.d?.page_view || 0) >= 50) {
    const mobileShare = rate(D.m.page_view, (D.m.page_view || 0) + (D.d.page_view || 0) + (D.t?.page_view || 0));
    const ratio = eng(D.m) / (eng(D.d) || 1);
    if (ratio < 0.7) {
      add({ id: 'mobile_gap', area: '기기', severity: mobileShare > 0.5 ? 'high' : 'mid', title: `모바일 탐색률이 데스크톱의 ${pct(ratio, 0)} 수준`,
        evidence: `모바일 비중 ${pct(mobileShare, 0)}. 탐색률 모바일 ${pct(eng(D.m))} vs 데스크톱 ${pct(eng(D.d))}. 전환율 모바일 ${pct(conv(D.m))} vs 데스크톱 ${pct(conv(D.d))}.`,
        action: '모바일 첫 화면에서 순위 카드가 스크롤 두 번 아래에 있습니다. 진단·필터 영역을 접고 상위 3곳을 먼저 보여 주세요.' });
    }
  }

  // 6. 유입 경로
  const S = Object.entries(m.sources || {}).filter(([, s]) => (s.page_view || 0) >= 30)
    .map(([k, s]) => ({ k, n: s.page_view, eng: eng(s), conv: conv(s) })).sort((a, b) => (b.conv ?? 0) - (a.conv ?? 0));
  if (S.length >= 2) {
    add({ id: 'sources', area: '유입', severity: 'info', title: `전환이 가장 좋은 유입: ${S[0].k} (${pct(S[0].conv)}), 가장 낮은 유입: ${S[S.length - 1].k} (${pct(S[S.length - 1].conv)})`,
      evidence: S.slice(0, 6).map((s) => `${s.k} ${fmt(s.n)}명 · 탐색 ${pct(s.eng, 0)} · 전환 ${pct(s.conv)}`).join(' / '),
      action: `${S[0].k} 채널에 콘텐츠를 더 올리고, ${S[S.length - 1].k}에서 들어오는 랜딩 페이지를 그 채널 관심사(예: 지역명)에 맞춰 바꾸세요.` });
  }

  // 7. 실험
  const EXP = { hero_cta: ['engaged', '첫 화면 버튼', '탐색률'], lead_cta: ['lead_submit', '상담 버튼 문구', '상담 신청률'] };
  for (const [x, [metric, label, mlabel]] of Object.entries(EXP)) {
    const vs = Object.entries(m.experiments?.[x] || {});
    if (vs.length < 2) continue;
    const [[a, A], [b, Bv]] = vs;
    const nA = A.page_view || 0, nB = Bv.page_view || 0;
    const t = zTest(A[metric] || 0, nA, Bv[metric] || 0, nB);
    const base = rate((A[metric] || 0) + (Bv[metric] || 0), nA + nB);
    const need = sampleNeeded(base);
    const done = t && t.p < 0.05 && nA >= 100 && nB >= 100;
    const winner = done ? (t.z > 0 ? a : b) : null;
    const rA = rate(A[metric] || 0, nA), rB = rate(Bv[metric] || 0, nB);
    const lift = done ? (t.z > 0 ? rA / rB : rB / rA) - 1 : null;
    add({ id: `exp_${x}`, area: '실험', severity: done ? 'mid' : 'info',
      title: done ? `실험 "${label}": ${winner} 승 (${mlabel} ${Number.isFinite(lift) ? `+${pct(lift, 0)}` : ''}, p=${t.p.toFixed(3)})` : `실험 "${label}" 진행 중`,
      evidence: `${a}: ${fmt(A[metric] || 0)}/${fmt(nA)} (${pct(rate(A[metric] || 0, nA))}) · ${b}: ${fmt(Bv[metric] || 0)}/${fmt(nB)} (${pct(rate(Bv[metric] || 0, nB))})${t ? ` · p=${t.p.toFixed(3)}` : ''}`,
      action: done ? `${winner} 변형으로 고정하고 다음 실험으로 넘어가세요.` : `변형당 약 ${need ? fmt(need) : '?'}명이 모이면 20% 차이를 판별할 수 있습니다.` });
  }

  // 8. 성능·오류·폼
  for (const [v, limit, unit] of [['LCP', 2500, 'ms'], ['INP', 200, 'ms'], ['CLS', 0.1, '']]) {
    for (const [dev, label] of [['m', '모바일'], ['d', '데스크톱']]) {
      const s = m.vitals?.[v]?.[dev];
      if (s && s.n >= 20 && s.p75 > limit) {
        add({ id: `vital_${v}_${dev}`, area: '성능', severity: s.p75 > limit * 1.6 ? 'high' : 'mid', title: `${label} ${v} p75 ${v === 'CLS' ? s.p75.toFixed(3) : Math.round(s.p75) + unit} (기준 ${limit}${unit})`,
          evidence: `표본 ${fmt(s.n)}개, 중앙값 ${v === 'CLS' ? s.p50.toFixed(3) : Math.round(s.p50) + unit}.`,
          action: v === 'LCP' ? '지역 데이터(regions.json)를 첫 화면용 요약과 상세로 나누고, 웹폰트를 줄이거나 font-display를 optional로 바꾸세요.'
            : v === 'INP' ? '가중치 슬라이더 입력마다 89곳 전체를 다시 그립니다. 입력을 150ms 디바운스하세요.'
              : '지도와 목록 영역에 고정 높이를 주어 레이아웃 이동을 막으세요.' });
      }
    }
  }
  const errs = top(m.dims.err, 3);
  const errTotal = Object.values(m.dims.err || {}).reduce((a, b) => a + b, 0);
  if (errTotal >= 5) {
    add({ id: 'js_errors', area: '오류', severity: 'high', title: `스크립트 오류 ${fmt(errTotal)}건`,
      evidence: errs.map(([k, c]) => `${k} (${c})`).join(' / '), action: '가장 많은 오류부터 재현해 고치세요. 오류가 난 화면에서는 버튼이 동작하지 않을 수 있습니다.' });
  }
  const fe = top(m.dims.form_err, 3);
  if (fe.length && fe[0][1] >= 5) {
    add({ id: 'form_errors', area: '퍼널', severity: 'mid', title: `신청서에서 가장 많이 막히는 칸: ${fe[0][0]}`,
      evidence: fe.map(([k, c]) => `${k} ${c}회`).join(', '),
      action: '해당 입력칸 안내 문구를 예시와 함께 바꾸고, 형식 검사를 너그럽게(하이픈·공백 허용) 하세요.' });
  }

  // 9. 화면 사용 패턴
  const ui = m.dims.ui || {};
  const filters = top(Object.fromEntries(Object.entries(ui).filter(([k]) => k.startsWith('filter:'))), 3);
  if (filters.length && V >= 50) {
    add({ id: 'filters', area: '탐색', severity: 'info', title: `가장 많이 쓴 조건: ${filters.map(([k]) => k.replace('filter:', '')).join(', ')}`,
      evidence: filters.map(([k, c]) => `${k.replace('filter:', '')} ${fmt(c)}회`).join(' / '),
      action: filters[0][0].includes('bi') ? '기본소득 관심이 큽니다. 기본소득 지역 모음 페이지와 2027년 확대 지역 발표 알림을 따로 만드세요.' : '자주 쓰는 조건은 기본값 또는 첫 화면 바로가기로 올리세요.' });
  }
  const weights = Object.entries(ui).filter(([k]) => k.startsWith('weight:')).reduce((a, [, c]) => a + c, 0);
  if (weights > (uv.quiz_complete || 0) * 3 && weights >= 50) {
    add({ id: 'weights', area: '진단', severity: 'low', title: '가중치를 직접 많이 조절합니다', evidence: `가중치 변경 ${fmt(weights)}회, 진단 완료 ${fmt(uv.quiz_complete || 0)}명.`,
      action: '진단 결과가 기대와 다르다는 신호입니다. 가장 많이 올린 지표를 해당 상황의 기본 가중치에 반영하세요.' });
  }
  const opens = m.dims.open_rank || {};
  const openTotal = Object.values(opens).reduce((a, b) => a + b, 0);
  if (openTotal >= 50 && rate(opens['1-5'] || 0, openTotal) > 0.6) {
    add({ id: 'rank_bias', area: '탐색', severity: 'info', title: `지역 열람의 ${pct(rate(opens['1-5'], openTotal), 0)}가 상위 5위 안에서 나옵니다`,
      evidence: Object.entries(opens).map(([k, c]) => `${k}위 ${c}`).join(', '),
      action: '순위가 선택을 크게 좌우합니다. 점수 산식의 근거를 카드에 더 보여 주고, 지원 정보가 비어 있는 지역이 불리하지 않은지 점검하세요.' });
  }

  // 10. 수익
  const pv = uv.report_preview || 0, ps = uv.payment_start || 0, pok = uv.payment_success || 0;
  const rev = m.dims.rev?.krw || 0;
  if (pv >= 10) {
    add({ id: 'report_funnel', area: '수익', severity: pok === 0 && ps > 0 ? 'high' : 'info',
      title: `리포트: 미리보기 ${fmt(pv)}명 → 결제 시작 ${fmt(ps)}명 → 결제 ${fmt(pok)}명 (매출 ${fmt(rev)}원)`,
      evidence: `미리보기→결제 ${pct(rate(pok, pv))}. 결제 실패 사유: ${top(m.dims.pay_fail, 3).map(([k, c]) => `${k} ${c}`).join(', ') || '없음'}. 출시 알림 신청 ${fmt(truth.waitlist ?? (m.events.subscribe_submit || 0))}건.`,
      action: ps === 0 ? '결제가 아직 열리지 않았습니다. 출시 알림 신청 수가 미리보기의 10%를 넘으면 결제를 여세요.' : rate(pok, pv) < 0.02 ? '미리보기에서 잠긴 항목(일정, 지원 내역) 하나를 공개해 가치를 먼저 보여 주거나, 1곳 가격을 4,900원으로 실험하세요.' : '현재 전환이 양호합니다. 2~3곳 비교 상품을 기본 선택으로 두세요.' });
  }
  const lw = m.dims.lead_when || {};
  const leadsN = Object.values(lw).reduce((a, b) => a + b, 0);
  if (leadsN >= 5) {
    const hot = (lw['3개월 이내'] || 0) + (lw['1년 이내'] || 0);
    add({ id: 'lead_quality', area: '수익', severity: 'info', title: `상담 신청 ${fmt(leadsN)}건 중 1년 안 이주 ${pct(rate(hot, leadsN), 0)}, 지자체 제공 동의 ${pct(rate(m.dims.lead_third?.yes || 0, leadsN), 0)}`,
      evidence: top(m.dims.lead_purpose, 4).map(([k, c]) => `${k} ${c}`).join(', '),
      action: '1년 안 이주·제공 동의 리드가 지자체 판매 단가(건당 2만 원)의 근거입니다. 동의율이 50% 미만이면 동의 문구에 "담당 공무원이 직접 연락" 혜택을 강조하세요.' });
  }

  F.sort((a, b) => SEV[a.severity] - SEV[b.severity]);
  const kpis = {
    visitors: V, sessions: m.sessions || 0,
    engagedRate: rate(uv.engaged || 0, uv.page_view || V), convertRate: rate(uv.convert || 0, uv.page_view || V),
    leads: truth.leads ?? (m.events.lead_submit || 0), revenue: rev, orders: m.dims.rev?.orders || 0,
    eventsPerSession: rate(Object.values(m.events || {}).reduce((a, b) => a + b, 0), m.sessions || 0),
  };
  return { range: m.range, kpis, funnel, findings: F, salesTargets, daily: m.daily };
}

export function insightsMarkdown(r) {
  const lines = [`# 이사갈군 데이터 인사이트 (${r.range.from} ~ ${r.range.to})`, '',
    `방문자 ${fmt(r.kpis.visitors)}명 · 세션 ${fmt(r.kpis.sessions)} · 탐색률 ${pct(r.kpis.engagedRate)} · 전환율 ${pct(r.kpis.convertRate)} · 상담 ${fmt(r.kpis.leads)}건 · 매출 ${fmt(r.kpis.revenue)}원`, '',
    '## 퍼널', ...r.funnel.map((s) => `- ${s.label}: ${fmt(s.uv)}명 (방문 대비 ${pct(s.ofVisit)}, 이전 단계 대비 ${pct(s.fromPrev)})`), '',
    '## 개선 과제 (우선순위순)'];
  r.findings.forEach((f, i) => lines.push(`${i + 1}. [${f.severity}] [${f.area}] ${f.title}`, `   - 근거: ${f.evidence}`, `   - 할 일: ${f.action}`));
  if (r.salesTargets.length) {
    lines.push('', '## 지자체 영업 우선순위', ...r.salesTargets.map((t, i) => `${i + 1}. ${t.name} — 조회 ${fmt(t.views)}, 비교 ${fmt(t.compare)}, 상담 열기 ${fmt(t.leadOpen)}, 상담 ${fmt(t.leads)}`));
  }
  return lines.join('\n');
}
