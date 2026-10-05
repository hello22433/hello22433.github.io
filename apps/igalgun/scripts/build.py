"""정적 페이지 생성기.

data/ 의 가공 데이터로 public/ 아래 HTML·JSON을 만든다.
    python3 scripts/build.py [--site-url https://example.com]
"""
import argparse
import json
import math
import os
import shutil
from datetime import date

from jinja2 import Environment, FileSystemLoader, select_autoescape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
PUB = os.path.join(ROOT, 'public')

BI_MONTHLY = {'구례군': 200_000, '보성군': 200_000, '청송군': 200_000, '보은군': 160_000}
AS_OF = '2026-10-05'

SIGNALS = [
    {'v': '41.3만 명', 't': '2025년 귀촌인. 30대 가구주가 23.2%로 가장 많음', 's': '2025 귀농어·귀촌인 통계 (2026.6)'},
    {'v': '51.3%', 't': '귀농·귀촌을 고려한다는 도시민 비율', 's': '농촌경제연구원 국민의식조사 (2026.1)'},
    {'v': '2,382만', 't': '89곳의 월평균 생활인구. 체류인구가 등록인구의 4.3배', 's': '행정안전부·국가데이터처 2026 1분기'},
    {'v': '8.3%', 't': '최근 5년 귀촌인 중 다시 도시로 돌아간 비율', 's': '2025 귀농어·귀촌인 통계'},
    {'v': '948만 명', 't': '은퇴를 시작한 2차 베이비부머(1964~74년생)', 's': '2025 귀농어·귀촌인 통계 보도'},
    {'v': '35곳', 't': '2027년 농어촌 기본소득 확대 예정 지역 (예산안 1조 1,658억 원)', 's': '2027 정부 예산안 (2026.9)'},
]
MATRIX = [
    {'name': '인구감소지역 이주·정착 비교', 'comp': 2, 'need': 4, 'ds': 158, 'who': '그린대로(귀농 중심), 지자체별 공고, 블로그. 89곳을 나란히 비교하는 곳 없음', 'pick': True},
    {'name': '사망 후 행정·상속 안내', 'comp': 4, 'need': 2, 'ds': 1151, 'who': '정부24 안심상속, 홈택스 계산기, 무료 체크리스트 사이트, 상속 플랫폼'},
    {'name': '장례식장 가격 비교', 'comp': 4, 'need': 2, 'ds': 1151, 'who': '피스플러스, 고이, 지역 장례 포털 다수'},
    {'name': '요양시설 비교·본인부담금', 'comp': 5, 'need': 2, 'ds': 296, 'who': '장기요양보험 누리집, 케어 플랫폼 여럿, 금융사 서비스'},
    {'name': '체류외국인 생활행정', 'comp': 4, 'need': 3, 'ds': 239, 'who': '하이코리아, 비자 대행 스타트업 다수'},
    {'name': '지자체 출산·육아 지원금 비교', 'comp': 4, 'need': 3, 'ds': 860, 'who': '정부24 행복출산, 복지로, 계산기 앱 여럿'},
    {'name': '반려동물 장례', 'comp': 4, 'need': 2, 'ds': 398, 'who': '예약·비교 플랫폼 여럿'},
]
PLANS = [
    {'id': 'basic', 'name': '정보 인증', 'price': 3_000_000, 'who': '정책 정보를 정확히 알리고 싶은 시·군',
     'features': ['공식 인증 배지와 담당 부서 연락처 표시', '정착 지원 정책을 직접 등록·수정 (48시간 내 반영)', '월간 관심도 리포트 (조회, 비교함 담기, 상담 신청)', '상담 신청 리드 월 20건까지 전달']},
    {'id': 'partner', 'name': '유치 파트너', 'price': 9_000_000, 'who': '이주 희망자를 직접 만나고 싶은 시·군', 'featured': True,
     'features': ['정보 인증의 모든 기능', '상담 신청 리드 무제한, 접수 즉시 전달', '지역 페이지 상단 "공식 안내"와 살아보기·박람회 모집 배너', '비슷한 조건의 경쟁 지역 대비 분기 분석 보고']},
    {'id': 'campaign', 'name': '캠페인', 'price': 18_000_000, 'who': '연간 인구 유입 목표가 있는 시·군',
     'features': ['유치 파트너의 모든 기능', '수신 동의한 관심자에게 정책·행사 안내 발송 (연 4회)', '맞춤 데이터 분석 보고서 (전입자 유형, 유출 요인)', '귀농귀촌 박람회·살아보기 프로그램 연계 운영']},
]


def won(n):
    if n is None:
        return ''
    if n >= 1e8:
        v = n / 1e8
        return f"{v:.1f}억 원".replace('.0억', '억') if n % 1e8 else f"{int(v)}억 원"
    if n >= 1e4:
        return f"{round(n / 1e4):,}만 원"
    return f"{n:,}원"


def pct(v, d=1):
    return f"{'+' if v > 0 else ''}{v:.{d}f}%"


def clean_item(it):
    if not it:
        return None
    url = (it.get('url') or '').split(' ')[0]
    if not url.startswith('http'):
        return None
    # 모든 출처는 HTTPS로 연결한다(2026-10 확인: 아래 언론사 모두 HTTPS 응답)
    url = 'https://' + url[len('http://'):].replace(':8080/', '/') if url.startswith('http://') else url
    out = {'url': url, 'year': it.get('year')}
    for k in ('amount', 'desc', 'first', 'third'):
        if it.get(k) is not None:
            out[k] = it[k]
    return out


def load_regions():
    regs = json.load(open(os.path.join(DATA, 'regions.json')))
    codes = json.load(open(os.path.join(DATA, 'codes.json')))
    out = []
    for r in regs:
        r = dict(r)
        r['code'] = codes[f"{r['sido']}-{r['name']}"]
        inc = r.get('inc') or {}
        r['inc'] = {k: clean_item(inc.get(k)) for k in ('youth', 'farm', 'housing', 'birth', 'transfer')}
        hp = inc.get('homepage')
        r['inc']['homepage'] = ('https://' + hp[len('http://'):] if hp.startswith('http://') else hp) if hp and hp.startswith('http') else None
        r['bi_monthly'] = BI_MONTHLY.get(r['name'], 150_000) if r.get('basic_income') else None
        r.pop('id', None)
        out.append(r)
    return out


def spark_svg(r):
    ys = sorted(int(y) for y in r['pop_series'])
    vals = [r['pop_series'][str(y)] for y in ys]
    W, H, pl, pr, pt, pb = 320, 120, 4, 46, 12, 20
    mn, mx = min(vals), max(vals)
    pad = (mx - mn) * 0.15 or 1
    X = lambda i: pl + i * (W - pl - pr) / (len(vals) - 1)
    Y = lambda v: pt + (mx + pad - v) / ((mx + pad) - (mn - pad)) * (H - pt - pb)
    d = ''.join(('L' if i else 'M') + f"{X(i):.1f},{Y(v):.1f}" for i, v in enumerate(vals))
    last = len(vals) - 1
    return (f'<svg class="spark" viewBox="0 0 {W} {H}" role="img" aria-label="{r["name"]} {ys[0]}~{ys[-1]}년 연말 주민등록 인구 추이">'
            f'<line class="gd" x1="{pl}" x2="{W-pr}" y1="{H-pb}" y2="{H-pb}"/>'
            f'<path class="ar" d="{d}L{X(last):.1f},{H-pb}L{X(0):.1f},{H-pb}Z"/><path class="ln" d="{d}"/>'
            f'<circle class="dot" cx="{X(0):.1f}" cy="{Y(vals[0]):.1f}" r="3"/><circle class="dot" cx="{X(last):.1f}" cy="{Y(vals[last]):.1f}" r="4"/>'
            f'<text x="{X(0)+6:.1f}" y="{Y(vals[0])-6:.1f}">{vals[0]/1e4:.1f}만</text>'
            f'<text x="{X(last)+7:.1f}" y="{Y(vals[last])+4:.1f}">{vals[last]/1e4:.1f}만</text>'
            f'<text x="{pl}" y="{H-5}">{ys[0]}</text><text x="{W-pr}" y="{H-5}" text-anchor="end">{ys[-1]}</text></svg>')


def percentiles(regions):
    """서버 렌더링용 단순 백분위(인구 활력·의료·교통). 화면의 점수는 score.js가 다시 계산한다."""
    def rank(vals):
        order = sorted(range(len(vals)), key=lambda i: vals[i])
        out = [0.0] * len(vals)
        for pos, i in enumerate(order):
            out[i] = pos / (len(vals) - 1)
        return out
    return {
        'chg12m': rank([r['chg12m'] for r in regions]),
        'young': rank([r['young'] for r in regions]),
        'med': rank([r['clinic_per10k'] for r in regions]),
        'ktx': rank([-r['ktx_km'] for r in regions]),
    }


def related(r, regions):
    same = [x for x in regions if x['sido'] == r['sido'] and x['code'] != r['code']]
    dist = lambda x: math.hypot(x['lat'] - r['lat'], (x['lon'] - r['lon']) * 0.8)
    near = sorted([x for x in regions if x['code'] != r['code']], key=dist)[:4]
    seen, out = set(), []
    for x in near + same:
        if x['code'] not in seen:
            seen.add(x['code'])
            out.append(x)
    return out[:6]


def second_home(r):
    if r['sido'] not in ('부산', '대구', '인천', '경기'):
        return 'yes'
    return 'check' if r['name'] in ('군위군', '강화군', '옹진군', '연천군') else 'no'


def region_summary(r, rank):
    bits = [f"{r['sido']} {r['name']}의 주민등록 인구는 {r['pop']:,}명(2026년 9월)으로, 최근 1년 {pct(r['chg12m'], 2)}, 10년간 {pct(r['chg10'])} 변했습니다."]
    if r.get('basic_income'):
        bits.append(f"농어촌 기본소득 시범지역으로 30일 이상 실거주하면 월 {won(r['bi_monthly'])}을 지역사랑상품권으로 받습니다.")
    bits.append(f"가장 가까운 KTX역은 {r['ktx_name']}(직선 {r['ktx_km']}km)이고, 인구 1만 명당 병·의원은 {r['clinic_per10k']}곳입니다.")
    return ' '.join(bits)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site-url', default=os.environ.get('SITE_URL', 'https://igalgun.vercel.app'))
    ap.add_argument('--base', default=os.environ.get('BASE_PATH', ''), help='하위 경로 배포 시 접두사, 예: /igalgun')
    ap.add_argument('--api', default=os.environ.get('API_BASE', '/api'), help="API 주소. 'none'이면 접수·수집 기능을 끈다")
    ap.add_argument('--out', default=PUB, help='출력 폴더')
    args = ap.parse_args()
    base = args.base.rstrip('/')
    api = None if args.api in ('', 'none') else args.api.rstrip('/')
    out_dir = os.path.abspath(args.out)
    site = args.site_url.rstrip('/') + base

    regions = load_regions()
    geo = json.load(open(os.path.join(DATA, 'mapgeo.json')))
    regions.sort(key=lambda r: (r['sido'], r['name']))

    if out_dir != PUB:
        shutil.rmtree(out_dir, ignore_errors=True)
        shutil.copytree(os.path.join(PUB, 'assets'), os.path.join(out_dir, 'assets'))
    os.makedirs(os.path.join(out_dir, 'data'), exist_ok=True)
    payload = {'asOf': AS_OF, 'regions': regions, 'map': geo, 'signals': SIGNALS, 'matrix': MATRIX}
    with open(os.path.join(out_dir, 'data', 'regions.json'), 'w') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))

    env = Environment(loader=FileSystemLoader(os.path.join(ROOT, 'templates')), autoescape=select_autoescape(['html']),
                      trim_blocks=True, lstrip_blocks=True)
    env.filters.update(won=won, pct=pct, comma=lambda n: f"{n:,}")
    common = {'site': site, 'base': base, 'api': api, 'as_of': AS_OF, 'year': date.fromisoformat(AS_OF).year, 'plans': PLANS,
              'region_count': len(regions), 'bi_count': sum(1 for r in regions if r.get('basic_income')),
              'signals': SIGNALS, 'matrix': MATRIX}

    def render(tpl, out, **ctx):
        path = os.path.join(out_dir, out)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        html = env.get_template(tpl).render(**common, **ctx)
        with open(path, 'w') as f:
            f.write(html)

    pop = sum(r['pop'] for r in regions)
    p15 = sum(r['pop_series']['2015'] for r in regions)
    p25 = sum(r['pop_series']['2025'] for r in regions)
    bi = [r for r in regions if r.get('basic_income')]
    ot = [r for r in regions if not r.get('basic_income')]
    g = lambda a: (sum(r['pop'] for r in a) / sum(r['pop_monthly'][0] for r in a) - 1) * 100
    facts = {'pop_total': pop, 'chg10': (p25 / p15 - 1) * 100, 'bi_chg': g(bi), 'ot_chg': g(ot),
             'bi_from': sum(r['pop_monthly'][0] for r in bi), 'bi_to': sum(r['pop'] for r in bi),
             'ot_from': sum(r['pop_monthly'][0] for r in ot), 'ot_to': sum(r['pop'] for r in ot)}

    render('index.html', 'index.html', page='home', facts=facts)
    render('insight.html', 'insight/index.html', page='insight', facts=facts)
    render('report.html', 'report/index.html', page='report')
    render('partners.html', 'partners/index.html', page='partners', regions=regions)
    render('privacy.html', 'privacy/index.html', page='privacy')
    render('terms.html', 'terms/index.html', page='terms')
    render('admin.html', 'admin/index.html', page='admin')
    render('404.html', '404.html', page='404')

    pc = percentiles(regions)
    shutil.rmtree(os.path.join(out_dir, 'region'), ignore_errors=True)
    for i, r in enumerate(regions):
        render('region.html', f"region/{r['code']}/index.html", page='region', r=r, spark=spark_svg(r),
               related=related(r, regions), second_home=second_home(r), summary=region_summary(r, i),
               pc={k: round(v[i] * 100) for k, v in pc.items()}, regions=regions)

    urls = ['/', '/insight/', '/report/', '/partners/', '/privacy/', '/terms/'] + [f"/region/{r['code']}/" for r in regions]
    with open(os.path.join(out_dir, 'sitemap.xml'), 'w') as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n')
        for u in urls:
            f.write(f"  <url><loc>{site}{u}</loc><lastmod>{AS_OF}</lastmod></url>\n")
        f.write('</urlset>\n')
    if not base:
        with open(os.path.join(out_dir, 'robots.txt'), 'w') as f:
            f.write(f"User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nSitemap: {site}/sitemap.xml\n")
    print(f"built {len(regions)} regions, {len(urls)} urls → {out_dir} (base={base or '/'}, api={api})")


if __name__ == '__main__':
    main()
