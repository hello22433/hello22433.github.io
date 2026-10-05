# 이사갈군 (Vercel 앱)

인구감소지역 89곳의 인구·의료·교통·정착 지원을 비교하고, 상담 연결·유료 리포트·지자체 파트너로 수익을 내는 서비스입니다.

- `public/` 정적 사이트 (빌드 결과물을 커밋. Vercel은 빌드 없이 그대로 배포)
- `api/` Vercel 서버리스 함수 (Node 20+, Web `Request`/`Response` 시그니처)
- `lib/` 서버 공용 코드, `public/assets/score.js`는 브라우저·서버 공용 점수 계산
- `templates/` + `scripts/build.py` 정적 페이지 생성기 (89개 지역 SEO 페이지 포함)
- `data/` 가공 데이터 (원천과 수집 방법은 저장소의 `tools/igalgun/README.md`)

## Vercel에 배포하기

1. Vercel → **Add New → Project → Import** `hello22433/hello22433.github.io`
2. **Root Directory**: `apps/igalgun` · Framework Preset: **Other** · Build Command 비움 · Output Directory `public` (vercel.json에 이미 지정)
3. **Storage → Marketplace → Upstash for Redis** 를 프로젝트에 연결 (`KV_REST_API_URL`, `KV_REST_API_TOKEN` 자동 주입). 없으면 상담·구독·결제 API가 503을 돌려줍니다.
4. 환경변수

| 이름 | 필수 | 설명 |
|---|---|---|
| `ADMIN_TOKEN` | 예 | 16자 이상 임의 문자열. `/admin` 로그인과 CSV 내보내기에 사용 |
| `IGG_SALT` | 권장 | 요청 제한용 IP 해시 솔트 |
| `TOSS_CLIENT_KEY`, `TOSS_SECRET_KEY` | 결제 시 | 토스페이먼츠 **결제위젯** 키 (테스트: 개발자센터의 `test_gck_…`/`test_gsk_…`) |
| `REPORT_SECRET` | 결제 시 | 리포트 열람 링크 서명용 임의 문자열 |
| `REPORT_PRICE_ONE`, `REPORT_PRICE_MULTI` | 아니오 | 기본 9900 / 19900 |
| `RESEND_API_KEY`, `NOTIFY_EMAIL`, `NOTIFY_FROM` | 아니오 | 새 신청·결제 알림과 주간 인사이트 메일 |
| `CRON_SECRET` | 권장 | 주간 인사이트 크론 호출 인증 (Vercel이 자동으로 붙여 보냄) |
| `ALLOWED_ORIGINS` | 아니오 | API를 부를 수 있는 추가 출처(쉼표 구분). `https://hello22433.github.io`는 기본 허용 |

5. 배포 후 `https://<도메인>/api/health` 에서 `store`, `payments`, `admin`이 `true`인지 확인합니다.
6. 도메인이 정해지면 `python3 scripts/build.py --site-url https://<도메인>` 으로 다시 빌드해 canonical·sitemap 주소를 맞추고 커밋합니다.

> Vercel **Hobby 플랜은 비상업용**입니다. 결제나 유료 제휴를 시작하면 Pro 플랜으로 바꿔야 합니다.

## 로그 통계 시스템

행동 로그로 "무엇을 고쳐야 하는지"를 자동으로 뽑습니다.

```
브라우저 track.js ──(묶음, sendBeacon)──▶ /api/collect ──▶ Upstash
  익명 방문자·세션 ID, A/B 배정,            스키마 검증(events.js)      a:{일}:{차원}  해시 카운트
  페이지뷰·스크롤·웹 성능·오류 자동 수집     봇·요청 제한                 u:{일}:{지표}  HyperLogLog 고유 방문자
                                                                         raw:{일}       원본 90일
/admin ◀── /api/admin/analytics ◀── lib/metrics.js(기간 합산) ◀── lib/insights.js(규칙 엔진)
주간 메일 ◀── /api/cron/digest (매주 월 09:00 KST)
로컬 분석 ◀── node scripts/analyze.mjs events.ndjson
```

- **이벤트 스키마**: `public/assets/events.js` 한 곳에서 정의합니다. 정의에 없는 이벤트·속성은 서버가 버리고, 이름·연락처는 들어갈 자리가 없습니다.
- **퍼널**: 방문 → 탐색(지역 열람·진단 완료) → 비교함 → 전환 의도(상담 열기·리포트 미리보기) → 전환(상담·결제·구독). 기기·유입경로·실험 변형별로 나눠 봅니다.
- **자동 개선 과제** (`lib/insights.js`): 가장 큰 퍼널 이탈, 진단 문항별 이탈, 검색 실패어(관심지역 확장 수요), 모바일·데스크톱 격차, 유입 채널별 전환, A/B 실험 판정(z-검정, 필요 표본 계산), 웹 성능 p75, 스크립트·입력 오류, 지역별 수요와 **지자체 영업 우선순위**, 리포트 결제 퍼널, 상담 리드 품질.
- **A/B 실험**: `hero_cta`(첫 화면 주 버튼), `lead_cta`(상담 버튼 문구). 방문자 ID 해시로 고정 배정됩니다. 새 실험은 `EXPERIMENTS`에 추가하고 `variant('이름')`으로 읽습니다.
- **검증**: `node scripts/simulate.mjs --visitors 3000 --out sim.ndjson` 으로 약점을 심은 가상 트래픽을 만들고, `node scripts/analyze.mjs sim.ndjson` 이 그 약점을 모두 찾는지 테스트합니다(`tests/analytics.test.mjs`).
- **수집 거부**: 사이트 하단 "통계 수집 거부", Do Not Track, Global Privacy Control을 따릅니다.

## 수익 구조

| 흐름 | 고객 | 가격 | 구현 |
|---|---|---|---|
| 지자체 연간 플랜 (핵심) | 인구감소지역 시·군 | 정보 인증 300만 / 유치 파트너 900만 / 캠페인 1,800만 원 (연, VAT 별도) | `/partners` 문의 폼 → `api/partner` |
| 상담 리드 | 플랜 없는 시·군, 민간 제휴 | 동의 리드 1건 2만 원 (민간 5천~1.5만 원) | 지역 페이지 상담 신청 → `api/lead` (지역별 제3자 제공 별도 동의) |
| 맞춤 이주 리포트 | 이주 희망자 | 1곳 9,900원 / 2~3곳 19,900원 | `/report` 미리보기 → 토스 결제 → `api/payments/*` → `api/report` |
| 관심도 데이터 | 파트너 시·군 | 플랜에 포함 | `api/collect` 행동 로그 → `/admin` 지역·영업 탭, 월간 리포트 |

가격 근거: 귀농귀촌 박람회 부스 1회 150만~350만 원, 고흥군 박람회 연 10회 2,800만 원·정보 홈페이지 운영 700만 원(2026 계획), 소액 수의계약 상한 2천만 원, DB 리드 평균 1만 원. 상세는 `data/monetization-research.md`.

## 결제 시작 전 할 일

- 사업자등록, 토스페이먼츠 가맹 계약, (해당 시) 통신판매업 신고
- 사이트 하단에 사업자 정보 표시, 개인정보처리방침의 문의 이메일 기재
- 지자체에 리드를 넘기기 전 해당 시·군과 개인정보 제공 협의

## GitHub Pages 정적 배포 (현재 운영 중)

`https://hello22433.github.io/igalgun/` 은 API 없이 동작하는 정적 판입니다. 지역 비교·상세·인사이트는 모두 되고, 상담·구독·결제·로그 수집은 꺼져 있습니다.
Vercel을 배포한 뒤 아래처럼 다시 빌드하면 정적 판도 Vercel API로 접수와 로그 수집을 합니다.

```bash
python3 scripts/build.py --site-url https://hello22433.github.io --base /igalgun --api https://<vercel-도메인>/api --out ../../igalgun
```

## 로컬 개발

```bash
python3 scripts/build.py                     # public/ 다시 생성
IGG_MEMORY_STORE=1 node scripts/dev.mjs 3000 # 정적 + API (메모리 저장소)
npm test                                     # API·로그 통계 테스트 (17건)
```
