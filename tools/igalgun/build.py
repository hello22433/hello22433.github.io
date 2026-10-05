import json, re, sys, os
HERE=os.path.dirname(os.path.abspath(__file__))
D=os.path.join(HERE,'data') if os.path.isdir(os.path.join(HERE,'data')) else os.path.dirname(HERE)
regs=json.load(open(f'{D}/regions.json')); geo=json.load(open(f'{D}/mapgeo.json'))
def clean_item(it):
    if not it: return None
    url=it.get('url') or ''
    if not url.startswith('http'): return None
    out={'url':url.split(' ')[0],'year':it.get('year')}
    for k in ('amount','desc','first','third'):
        if it.get(k) is not None: out[k]=it[k]
    return out
for r in regs:
    i=r.get('inc')
    if i:
        r['inc']={k:clean_item(i.get(k)) for k in ('youth','farm','housing','birth','transfer')}
        hp=i.get('homepage'); r['inc']['homepage']=hp if hp and hp.startswith('http') else None
signals=[
 {'v':'41.3만 명','t':'2025년 귀촌인. 30대 가구주가 23.2%로 가장 많음','s':'2025 귀농어·귀촌인 통계 (2026.6)'},
 {'v':'51.3%','t':'귀농·귀촌을 고려한다는 도시민 비율','s':'농촌경제연구원 국민의식조사 (2026.1)'},
 {'v':'2,382만','t':'89곳의 월평균 생활인구. 체류인구가 등록인구의 4.3배','s':'행정안전부·국가데이터처 2026 1분기'},
 {'v':'8.3%','t':'최근 5년 귀촌인 중 다시 도시로 돌아간 비율. 정보 부족이 큰 원인','s':'2025 귀농어·귀촌인 통계'},
 {'v':'948만 명','t':'은퇴를 시작한 2차 베이비부머(1964~74년생)','s':'2025 귀농어·귀촌인 통계 보도'},
 {'v':'35곳','t':'2027년 농어촌 기본소득 확대 예정 지역 수 (예산안 1조 1,658억 원)','s':'2027 정부 예산안 (2026.9)'},
]
matrix=[
 {'name':'인구감소지역 이주·정착 비교','comp':2,'need':4,'ds':158,'who':'그린대로(귀농 중심), 블로그·지자체별 공고. 89곳을 나란히 비교하는 곳 없음','pick':True},
 {'name':'사망 후 행정·상속 안내','comp':4,'need':2,'ds':1151,'who':'정부24 안심상속, 홈택스 계산기, 무료 체크리스트 사이트, 상속 플랫폼'},
 {'name':'장례식장 가격 비교','comp':4,'need':2,'ds':1151,'who':'피스플러스, 고이, 지역 장례 포털 다수'},
 {'name':'요양시설 비교·본인부담금','comp':5,'need':2,'ds':296,'who':'장기요양보험 누리집, 케어 플랫폼 여럿, 금융사 서비스'},
 {'name':'체류외국인 생활행정','comp':4,'need':3,'ds':239,'who':'하이코리아, 비자 대행 스타트업 다수'},
 {'name':'지자체 출산·육아 지원금 비교','comp':4,'need':3,'ds':860,'who':'정부24 행복출산, 복지로, 계산기 앱 여럿'},
 {'name':'반려동물 장례','comp':4,'need':2,'ds':398,'who':'예약·비교 플랫폼 여럿'},
]
data={'regions':regs,'map':geo,'signals':signals,'matrix':matrix}
tpl=open(f'{HERE}/template.html').read()
blob=json.dumps(data,ensure_ascii=False,separators=(',',':')).replace('</','<\\/')
page=tpl.replace('/*__DATA__*/null',blob)
open(os.path.join(sys.argv[2] if len(sys.argv)>2 else HERE,'artifact.html'),'w').write(page)
# standalone document for GitHub Pages
head_end=page.index('</style>')+len('</style>')
doc=('<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
     +page[:head_end]+'\n</head>\n<body>\n'+page[head_end:]+'\n</body>\n</html>\n')
os.makedirs(sys.argv[1],exist_ok=True)
open(os.path.join(sys.argv[1],'index.html'),'w').write(doc)
print('ok', len(page)//1024,'KB', sum(1 for r in regs if r.get('inc')),'regions with incentives')
