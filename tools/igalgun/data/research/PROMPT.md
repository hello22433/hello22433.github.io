You are researching Korean local-government relocation/settlement incentives for a public comparison website ("이사갈군" – helps people decide which 인구감소지역 to move to). Today is 2026-10-05. Use WebSearch and WebFetch (Korean queries; official 시·군청 sites, 조례 on elis.go.kr / law.go.kr 자치법규, korea.kr, 지역 언론, 그린대로 greendaero.go.kr, 온통청년). Prefer 2026 information; accept 2025 if 2026 not found and note the year.

For EACH region in your list, find (only what you can actually find evidence for — never guess numbers):
1. youth: 청년 전입/정착 지원 (e.g. 청년 정착장려금, 전입지원금, 청년 월세지원, 청년 창업) — headline amount in KRW (total max per person/household), short Korean description (≤60자), source URL, year.
2. farm: 귀농귀촌 지원 (정착지원금, 이사비, 주택수리비, 귀농인의 집, 농업창업) — same fields.
3. housing: 주거 지원 (빈집 리모델링, 주택 구입/신축 지원, 공공임대, 체류형 쉼터/귀촌 주택, 청년·신혼 임대) — same fields.
4. birth: 출산지원금 for the FIRST child and for the THIRD child (KRW totals across years, local only, excluding national 첫만남이용권), source URL.
5. transfer: 일반 전입 지원 (전입축하금, 종량제봉투, 지역화폐 등) if any — same fields.
6. highlight: one standout fact (≤60자) e.g. "농어촌 기본소득 시범지역", "KTX 정차", "청년마을 조성", "반값 임대주택".
Also give `seat`: the 시·군청 주소's 읍/면/동 (for geocoding), and `homepage`.

Output: write a JSON array to the file path given below with the Write tool, schema per region:
{"sido":"강원","name":"화천군","seat":"화천읍","homepage":"https://...","youth":{"amount":5000000,"desc":"...","url":"...","year":2026}|null,"farm":{...}|null,"housing":{...}|null,"birth":{"first":1000000,"third":10000000,"url":"...","year":2026}|null,"transfer":{...}|null,"highlight":"...","notes":"anything uncertain"}
`amount` is an integer KRW (null if no fixed amount). Keep desc concise, factual Korean. Every non-null item MUST have a real URL you visited or saw in search results. If unsure, set the item null and explain in notes. Aim to spend ~2-4 searches per region; breadth over depth. Finish by writing the file, then reply with a 3-line summary (how many regions done, how many items null, any concerns).
