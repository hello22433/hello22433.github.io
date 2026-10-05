// 유료 이주 리포트 생성. 같은 입력이면 항상 같은 결과가 나온다.
import { createRequire } from 'node:module';
import { scoreAll, PROFILES, FACTORS, amount, basicIncome2y, won, josa } from '../public/assets/score.js';

const require = createRequire(import.meta.url);
const DATA = require('../public/data/regions.json');
const R = DATA.regions;

// 1곳 9,900원, 2~3곳 비교 19,900원 (부가세 포함). 환경변수로 조정 가능.
export const PRICES = { one: Number(process.env.REPORT_PRICE_ONE || 9900), multi: Number(process.env.REPORT_PRICE_MULTI || 19900) };
export const priceFor = (n) => (n > 1 ? PRICES.multi : PRICES.one);
export const REPORT_NAME = '이사갈군 맞춤 이주 리포트';

const FACTOR_WORDS = {
  vital: ['최근 인구가 느는 편', '인구가 빠르게 줄고 있음'],
  peer: ['20~30대 비율이 높음', '또래 청년이 적음'],
  med: ['병·의원이 많은 편', '의료기관이 부족한 편'],
  move: ['KTX·수도권 접근이 좋음', 'KTX역·서울과 멂'],
  money: ['정착 지원 금액이 큼', '조사된 정착 지원이 적음'],
  kids: ['출산·육아 여건이 좋은 편', '출산·육아 여건이 약함'],
};

const QUESTIONS = {
  common: [
    '전입 후 몇 개월이 지나야 각 지원사업을 신청할 수 있나요? 연령·소득 조건은요?',
    '올해 예산이 남아 있나요? 다음 공고는 언제 나오나요?',
    '지원금을 받은 뒤 의무 거주 기간과 중도 전출 시 환수 조건은 무엇인가요?',
    '빈집이나 임대주택은 어디서 소개받을 수 있나요?',
  ],
  remote: ['초고속 인터넷과 공유 오피스(또는 워케이션 센터)가 있나요?', '청년 월세·전입 지원을 함께 받을 수 있나요?'],
  family: ['어린이집 대기와 초등학교 통학은 어떤가요?', '가장 가까운 분만 가능 산부인과와 소아 야간진료는 어디인가요?'],
  farm: ['귀농인의 집이나 체류형 지원센터에 입주할 수 있나요?', '귀농 창업자금 신청 전에 필요한 교육 시간은 얼마인가요?', '임대 가능한 농지를 소개받을 수 있나요?'],
  retire: ['종합병원까지 걸리는 시간과 응급 이송 체계는 어떤가요?', '세컨드홈 특례 대상 주택인지 어디서 확인하나요?'],
};

function timeline(r, profile) {
  const t = [
    { when: '이주 3개월 전', what: `${r.name} 방문과 상담`, detail: '시·군청 귀농귀촌·인구정책 부서에 상담을 예약하고, 지역 살아보기 프로그램이 있으면 신청합니다.', link: r.inc && r.inc.homepage },
    { when: '이주 1개월 전', what: '집 구하기와 지원사업 공고 확인', detail: '빈집 리모델링·주택 지원은 대개 연초 공고, 예산 소진 시 마감입니다.' },
    { when: '이주 당일~14일', what: '전입신고', detail: '주민등록법상 14일 이내. 정부24 온라인 또는 읍·면사무소.' },
  ];
  if (r.basic_income) t.push({ when: '전입 30일 뒤', what: '농어촌 기본소득 신청', detail: `월 ${won(r.bi_monthly || 150000)} 지역사랑상품권. 실제 거주 확인(월 3일 이상 거주 등)이 필요하고, 90일 거주 확인 뒤 소급될 수 있습니다.` });
  for (const [k, label] of [['youth', '청년 지원'], ['housing', '주거 지원'], ['transfer', '전입 지원'], ['farm', '귀농·귀촌 지원']]) {
    if (profile === 'retire' && k === 'youth') continue;
    if (profile !== 'farm' && k === 'farm' && !amount(r, k)) continue;
    const it = r.inc && r.inc[k];
    if (it) t.push({ when: '전입 후', what: `${label} 신청`, detail: it.desc || '', amount: it.amount || null, link: it.url });
  }
  if (profile === 'farm') t.push({ when: '전입 후 6개월 안팎', what: '귀농 창업·주택자금 융자', detail: '농업창업 최대 3억 원, 주택 최대 7,500만 원, 연 2% 수준(5년 거치 10년 상환). 교육 이수 요건이 있습니다.' });
  if (profile === 'family' && r.inc && r.inc.birth) t.push({ when: '출생 후', what: '출산지원금 신청', detail: `지자체분 첫째 ${won(r.inc.birth.first) || '–'}, 셋째 ${won(r.inc.birth.third) || '–'}. 국가 첫만남이용권은 별도.`, link: r.inc.birth.url });
  return t;
}

function regionBlock(r, s, profile) {
  const ranked = FACTORS.map((F) => ({ k: F.k, label: F.label, p: s.f[F.k] })).sort((a, b) => b.p - a.p);
  const relevant = ranked.filter((x) => (PROFILES.find((p) => p.id === profile)?.w[x.k] || 0) > 0);
  const est = [
    ['농어촌 기본소득 2년', basicIncome2y(r) || null],
    ['청년 지원 최대', profile === 'retire' ? null : amount(r, 'youth')],
    ['주거 지원 최대', amount(r, 'housing')],
    ['전입 지원', amount(r, 'transfer')],
    ['귀농·귀촌 지원 최대', profile === 'farm' ? amount(r, 'farm') : null],
  ].filter(([, v]) => v);
  return {
    code: r.code, name: r.name, sido: r.sido, cls: r.cls, score: s.score,
    factors: FACTORS.map((F) => ({ k: F.k, label: F.label, pct: Math.round(s.f[F.k] * 100) })),
    strengths: relevant.slice(0, 2).map((x) => FACTOR_WORDS[x.k][0]),
    risks: relevant.slice(-2).reverse().filter((x) => x.p < 0.5).map((x) => FACTOR_WORDS[x.k][1]),
    support: { items: est.map(([label, value]) => ({ label, value })), total: est.reduce((a, [, v]) => a + v, 0) },
    facts: {
      pop: r.pop, chg12m: r.chg12m, chg10: r.chg10, young: r.young, old: r.old,
      ktx: `${r.ktx_name} ${r.ktx_km}km`, seoul_km: r.seoul_km,
      med: r.med, clinic_per10k: r.clinic_per10k, basic_income: r.basic_income,
    },
    timeline: timeline(r, profile),
    homepage: r.inc && r.inc.homepage,
  };
}

export function buildReport(codes, profile, { full = true } = {}) {
  const p = PROFILES.find((x) => x.id === profile) ? profile : 'remote';
  const scores = scoreAll(R, p);
  const byCode = new Map(R.map((r, i) => [r.code, [r, scores[i]]]));
  const picked = codes.map((c) => byCode.get(c)).filter(Boolean);
  const rankOf = (code) => [...scores].sort((a, b) => b.score - a.score).findIndex((s) => s.code === code) + 1;
  const regions = picked.map(([r, s]) => ({ ...regionBlock(r, s, p), rank: rankOf(r.code) }));
  const best = [...regions].sort((a, b) => b.score - a.score)[0];
  const report = {
    title: REPORT_NAME,
    profile: PROFILES.find((x) => x.id === p).name,
    generatedAt: new Date().toISOString().slice(0, 10),
    dataAsOf: '인구 2026.9 · 의료 2026.6 · 정책 2026.10 조사',
    verdict: best ? `${PROFILES.find((x) => x.id === p).name} 기준으로는 ${best.sido} ${josa(best.name, '이', '가')} 고른 곳 중 가장 잘 맞습니다 (89곳 중 ${best.rank}위).` : '',
    regions,
    questions: [...QUESTIONS.common, ...(QUESTIONS[p] || [])],
    caveat: '지원 금액은 조건이 붙는 최대치이며 예산 소진·조례 개정으로 바뀔 수 있습니다. 신청 전 해당 시·군에 확인하세요.',
  };
  if (full) return report;
  // 무료 미리보기: 점수와 판정만, 일정·지원 내역·질문은 잠금
  return {
    ...report,
    locked: true,
    regions: regions.map(({ timeline: t, support, ...rest }) => ({ ...rest, support: { total: support.total, items: [] }, timelineCount: t.length })),
    questions: report.questions.slice(0, 1),
  };
}
