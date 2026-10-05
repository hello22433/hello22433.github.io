import pandas as pd, json, re, warnings; warnings.filterwarnings('ignore')
REG = {
 '부산':['동구','서구','영도구'],'대구':['남구','서구','군위군'],'인천':['강화군','옹진군'],'경기':['가평군','연천군'],
 '강원':['고성군','삼척시','양구군','양양군','영월군','정선군','철원군','태백시','평창군','홍천군','화천군','횡성군'],
 '충북':['괴산군','단양군','보은군','영동군','옥천군','제천시'],
 '충남':['공주시','금산군','논산시','보령시','부여군','서천군','예산군','청양군','태안군'],
 '전북':['고창군','김제시','남원시','무주군','부안군','순창군','임실군','장수군','정읍시','진안군'],
 '전남':['강진군','고흥군','곡성군','구례군','담양군','보성군','신안군','영광군','영암군','완도군','장성군','장흥군','진도군','함평군','해남군','화순군'],
 '경북':['고령군','문경시','봉화군','상주시','성주군','안동시','영덕군','영양군','영주시','영천시','울릉군','울진군','의성군','청도군','청송군'],
 '경남':['거창군','고성군','남해군','밀양시','산청군','의령군','창녕군','하동군','함안군','함양군','합천군']}
SIDO = {'부산':'부산광역시','대구':'대구광역시','인천':'인천광역시','경기':'경기도','강원':'강원특별자치도','충북':'충청북도','충남':'충청남도','전북':'전북특별자치도','전남':'전남광주통합특별시','경북':'경상북도','경남':'경상남도'}
OLD_SIDO={'강원':['강원도','강원특별자치도'],'전북':['전라북도','전북특별자치도'],'전남':['전라남도','전남광주통합특별시']}
regions=[(s,n) for s,l in REG.items() for n in l]
assert len(regions)==89

def load_jumin(f):
    df=pd.read_csv(f,encoding='cp949',thousands=',')
    df['name']=df['행정구역'].str.replace(r'\s*\(\d+\)','',regex=True).str.strip()
    df['code']=df['행정구역'].str.extract(r'\((\d+)\)')[0]
    return df
yr=load_jumin('popyear.csv'); mo=load_jumin('popmonth.csv')
def find(df,s,n):
    names=[SIDO[s]]+OLD_SIDO.get(s,[])+(['경상북도'] if n=='군위군' else [])
    rows=[df[df.name==f'{sn} {n}'] for sn in names]
    rows=[r.iloc[0] for r in rows if len(r)]
    if not rows: raise KeyError((s,n))
    out=rows[0].copy()
    for r in rows[1:]:
        out=out.fillna(r)
    return out
    # yearly file uses current names; 군위군 moved from 경북 to 대구 in 2023 — handled by current-name code
    for sn in names:
        m=df[df.name==f'{sn} {n}']
        if len(m): return m.iloc[0]
    raise KeyError((s,n))
# age structure from pop.csv (행정동, 2026-08)
p=pd.read_csv('pop.csv',encoding='utf-8')
agecols=[c for c in p.columns if re.match(r'^\d+세(남자|여자)$',c) or c.startswith('110세이상')]
def agesum(df,lo,hi):
    cs=[c for c in agecols if lo<=int(re.match(r'(\d+)',c).group(1))<=hi]
    return df[cs].sum(axis=1)
p['a0_9']=agesum(p,0,9); p['a20_39']=agesum(p,20,39); p['a65']=agesum(p,65,200); p['tot']=p['계']
g=p.groupby(['시도명','시군구명'])[['tot','a0_9','a20_39','a65']].sum().reset_index()
out=[]
for s,n in regions:
    y=find(yr,s,n); m=find(mo,s,n)
    gg=g[(g['시도명']==SIDO[s])&(g['시군구명']==n)]
    assert len(gg)==1,(s,n,len(gg))
    gg=gg.iloc[0]
    py={int(c[:4]):int(y[c]) for c in yr.columns if c.endswith('_총인구수') and y[c]==y[c]}
    pm={c[:8]:int(m[c]) for c in mo.columns if c.endswith('_총인구수')}
    out.append(dict(sido=s,name=n,code=y['code'],pop=pm['2026년09월'],pop_series={k:v for k,v in py.items()},
        pop_monthly=list(pm.values()),
        chg10=round((py[2025]/py[2015]-1)*100,1), chg12m=round((pm['2026년09월']/pm['2025년09월']-1)*100,2),
        old=round(gg.a65/gg.tot*100,1), young=round(gg.a20_39/gg.tot*100,1), kids=round(gg.a0_9/gg.tot*100,1)))
# national reference
for nm in ['전국']:
    pass
json.dump(out,open('core.json','w'),ensure_ascii=False)
df=pd.DataFrame(out)
print(df[['sido','name','pop','chg10','chg12m','old','young','kids']].sort_values('chg12m',ascending=False).to_string())
