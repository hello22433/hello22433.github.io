import json, math, glob, pandas as pd
core=json.load(open('core.json')); geo=json.load(open('geo.json')); nat=json.load(open('research/national.json'))
med=pd.read_csv('medical.csv')
SIDO={'부산':'부산광역시','대구':'대구광역시','인천':'인천광역시','경기':'경기도','강원':'강원특별자치도','충북':'충청북도','충남':'충청남도','전북':'전북특별자치도','전남':'전남광주통합특별시','경북':'경상북도','경남':'경상남도'}
rail=pd.read_csv('rail.csv').dropna(subset=['위도좌표','경도좌표'])
FIX=json.load(open('station_fix.json'))
ktx=[(r['역이름'],*FIX.get(r['역이름'],(float(r['위도좌표']),float(r['경도좌표'])))) for _,r in rail.iterrows() if '고속' in str(r['관련노선'])]
assert all(k[1]>33 and k[2]>125 for k in ktx)
ktx+= [('의성역',36.35336,128.693128),('영천역',35.9590454,128.9388909),('문경역',36.7202622,128.110201)]
def hav(a,b,c,d):
    R=6371; p=math.radians
    x=math.sin(p(c-a)/2)**2+math.cos(p(a))*math.cos(p(c))*math.sin(p(d-b)/2)**2
    return 2*R*math.asin(math.sqrt(x))
SEOUL=(37.5663,126.9779)
inc={}
for f in glob.glob('research/g*.json'):
    for r in json.load(open(f)): inc[(r['sido'],r['name'])]=r
special=set(nat['special_regions']); pref=set(nat['preferred_regions'])
bi={(r['sido'],r['name']):r for r in nat['basic_income']['regions']}
out=[]
for c in core:
    s,n=c['sido'],c['name']; key=f'{s} {n}'; g=geo[key]
    m=med[(med.sido==SIDO[s])&((med.sigungu_addr==n)|(med.sigungu==n)|(med.sigungu==s+n))]
    assert len(m)==1,(key,len(m)); m=m.iloc[0]
    near=min(ktx,key=lambda k:hav(g['lat'],g['lon'],k[1],k[2]))
    per10k=lambda v: round(v/c['pop']*10000,2)
    cls='특별' if key in special or f'{s} {n}' in special else ('우대' if key in pref else None)
    r=dict(id=f"{s}-{n}",sido=s,name=n,lat=round(g['lat'],4),lon=round(g['lon'],4),
        pop=c['pop'],pop_series=c['pop_series'],pop_monthly=c['pop_monthly'],chg10=c['chg10'],chg12m=c['chg12m'],
        old=c['old'],young=c['young'],kids=c['kids'],
        cls=cls, basic_income=(bi[(s,n)]['start'] if (s,n) in bi else None),
        ktx_name=near[0], ktx_km=round(hav(g['lat'],g['lon'],near[1],near[2]),1), seoul_km=round(hav(g['lat'],g['lon'],*SEOUL)),
        med=dict(gen=int(m.general_hosp),hosp=int(m.hosp),clinic=int(m.clinic),pharm=int(m.pharmacy),ped=int(m.pediatrics_specialist),obgyn=int(m.obgyn_specialist),ph=int(m.public_health)),
        clinic_per10k=per10k(m.clinic+m.hosp+m.general_hosp),
        inc=inc.get((s,n)))
    out.append(r)
print(len(out),'cls none:',[r['id'] for r in out if not r['cls']], 'inc missing:',[r['id'] for r in out if not r['inc']][:20])
json.dump(out,open('regions.json','w'),ensure_ascii=False)
df=pd.DataFrame(out); print(df[['id','ktx_name','ktx_km','seoul_km','clinic_per10k','cls']].sort_values('ktx_km').to_string())
