# 이사갈군 데이터 파이프라인

`/igalgun/index.html`(GitHub Pages)을 만드는 스크립트와 가공 데이터입니다. `tools/`는 Jekyll 빌드에서 제외됩니다.

## 다시 빌드하기

```bash
python3 tools/igalgun/build.py igalgun /tmp
```

`data/regions.json`, `data/mapgeo.json`을 `template.html`에 넣어 `igalgun/index.html`을 만듭니다.

## 데이터를 처음부터 갱신하기

원본 파일은 용량이 커서 저장소에 넣지 않았습니다. 작업 폴더에서 아래 순서로 받습니다.

| 파일 | 출처 | 받는 법 |
|---|---|---|
| `popyear.csv`, `popmonth.csv` | 행안부 주민등록 인구통계 | jumin.mois.go.kr `downloadCsv.do` (전체 시군구, 연간 2015~2025 / 월간) |
| `pop.csv` | 행안부 행정동 연령별 인구 | `./dl.sh 15097972 pop.bin` 후 cp949 → utf-8 |
| `rail.csv` | 국가철도공단 철도역 정보 | `./dl.sh 15067652 rail.bin` |
| `medical.csv` | 심평원 전국 병의원 및 약국 현황 2026.6 | opendata.hira.or.kr (sno=11925), 시군구별 집계 |
| `geo.json` | 시·군·구청 좌표 | OpenStreetMap Nominatim |
| `prov.json` → `mapgeo.json` | 시도 경계 | southkorea/southkorea-maps (KOSTAT 2013) |

그다음 `build_core.py` → `merge.py` → `build.py` 순서로 실행합니다.

`data/research/`의 지역별 지원 정책은 2026년 10월 시·군 누리집, 조례, 언론 보도를 조사한 결과입니다. 항목마다 원문 URL이 있습니다. 금액은 조건부 최대치이고, 일부는 2024~2025년 자료입니다.
