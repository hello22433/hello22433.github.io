// 로그 이벤트 스키마. 브라우저(track.js)와 서버(api/collect)가 같은 정의를 쓴다.
// 여기에 없는 이벤트·속성은 서버에서 버린다. 개인정보(이름, 연락처, 이메일)는 절대 넣지 않는다.
//   s: 문자열(최대 80자)  n: 숫자  b: 불리언  c: 지역 코드(5자리)

export const EVENTS = {
  page_view: { path: 's', ref: 's', utm_source: 's', utm_medium: 's', utm_campaign: 's' },
  quiz_start: {},
  quiz_step: { step: 'n' },
  quiz_complete: { profile: 's' },
  quiz_skip: { step: 'n' },
  profile_change: { profile: 's' },
  weight_change: { factor: 's', value: 'n' },
  filter_change: { filter: 's', on: 'b', value: 's' },
  sort_change: { sort: 's' },
  list_more: { shown: 'n' },
  search: { q: 's', results: 'n' },
  region_open: { code: 'c', source: 's', rank: 'n' },
  compare_add: { code: 'c' },
  compare_remove: { code: 'c' },
  compare_open: { n: 'n' },
  lead_open: { code: 'c' },
  lead_submit: { code: 'c', purpose: 's', when: 's', third: 'b' },
  subscribe_submit: { topic: 's', code: 'c' },
  form_error: { form: 's', field: 's' },
  report_open: { code: 'c' },
  report_preview: { n: 'n', profile: 's' },
  report_sample: {},
  payment_start: { amount: 'n' },
  payment_success: { amount: 'n' },
  payment_fail: { code: 's' },
  partner_view: {},
  partner_plan_click: { plan: 's' },
  partner_submit: { plan: 's' },
  source_click: { code: 'c', kind: 's' },
  correction_click: { code: 'c' },
  scroll_depth: { pct: 'n' },
  vital: { name: 's', value: 'n' },
  js_error: { msg: 's' },
  exp_expose: { exp: 's', variant: 's' },
};

// 퍼널 단계(고유 방문자 기준). 순서가 곧 퍼널이다.
export const FUNNEL = [
  ['page_view', '방문'],
  ['engaged', '탐색 (지역 열람·진단 완료)'],
  ['compare_add', '비교함 담기'],
  ['intent', '전환 의도 (상담 열기·리포트 미리보기)'],
  ['convert', '전환 (상담 신청·결제·구독)'],
];
export const ENGAGED = new Set(['region_open', 'quiz_complete']);
export const INTENT = new Set(['lead_open', 'report_preview', 'report_open']);
export const CONVERT = new Set(['lead_submit', 'payment_success', 'subscribe_submit', 'partner_submit']);
// 기기·유입경로·실험별로 고유 방문자를 따로 세는 이벤트
export const KEY_EVENTS = ['page_view', 'engaged', 'compare_add', 'intent', 'convert', 'lead_submit', 'payment_success', 'quiz_complete'];

// A/B 실험. 변형은 방문자 ID 해시로 고정 배정된다.
export const EXPERIMENTS = {
  hero_cta: ['quiz', 'browse'], // 첫 화면 주 버튼: 진단 시작 vs 바로 둘러보기
  lead_cta: ['consult', 'question'], // 상담 버튼 문구: "상담 신청" vs "궁금한 점 물어보기"
};

const CODE = /^\d{5}$/;

export function sanitize(name, props) {
  const schema = EVENTS[name];
  if (!schema) return null;
  const out = {};
  for (const [k, t] of Object.entries(schema)) {
    const v = props?.[k];
    if (v == null) continue;
    if (t === 's' && typeof v === 'string') out[k] = v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);
    else if (t === 'n' && Number.isFinite(Number(v))) out[k] = Math.round(Number(v) * 100) / 100;
    else if (t === 'b') out[k] = Boolean(v);
    else if (t === 'c' && CODE.test(String(v))) out[k] = String(v);
  }
  return out;
}

// 단순 결정적 해시(FNV-1a). 실험 배정과 샘플링에 쓴다.
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
export function variantFor(exp, vid) {
  const vs = EXPERIMENTS[exp];
  return vs ? vs[hash(`${exp}:${vid}`) % vs.length] : null;
}
