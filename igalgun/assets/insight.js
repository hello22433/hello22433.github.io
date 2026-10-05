// 인사이트: 89곳 12개월 인구 변화율 막대그래프.
import { loadData, $, esc, pct } from './common.js';

const { regions: R } = await loadData();
const el = $('#barchart');
const W = 640, H = 280, pl = 36, pr = 8, pt = 14, pb = 24;
el.setAttribute('viewBox', `0 0 ${W} ${H}`);
const rs = [...R].sort((a, b) => b.chg12m - a.chg12m);
const mx = Math.ceil(Math.max(...rs.map((r) => r.chg12m)));
const mn = Math.floor(Math.min(...rs.map((r) => r.chg12m)));
const Y = (v) => pt + ((mx - v) / (mx - mn)) * (H - pt - pb);
const bw = (W - pl - pr) / rs.length;
let s = '';
for (let t = mn; t <= mx; t += 2) {
  s += `<line class="ax" x1="${pl}" x2="${W - pr}" y1="${Y(t)}" y2="${Y(t)}" stroke-dasharray="${t ? '2 3' : ''}"/><text x="${pl - 6}" y="${Y(t) + 3}" text-anchor="end">${t > 0 ? '+' : ''}${t}%</text>`;
}
rs.forEach((r, i) => {
  const x = pl + i * bw + 1;
  const y0 = Y(0);
  const y1 = Y(r.chg12m);
  s += `<rect x="${x.toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${Math.max(1, Math.abs(y1 - y0)).toFixed(1)}" rx="1.5" fill="var(${r.basic_income ? '--s1' : '--s2'})"><title>${esc(r.sido)} ${esc(r.name)} ${pct(r.chg12m, 2)}${r.basic_income ? ' · 기본소득' : ''}</title></rect>`;
});
s += `<line class="zero" x1="${pl}" x2="${W - pr}" y1="${Y(0)}" y2="${Y(0)}"/>`;
const first = rs[0], last = rs[rs.length - 1];
s += `<text x="${pl + bw + 4}" y="${Y(first.chg12m) + 4}">${esc(first.name)} ${pct(first.chg12m)}</text>`;
s += `<text x="${W - pr - bw - 4}" y="${Y(last.chg12m) + 4}" text-anchor="end">${esc(last.name)} ${pct(last.chg12m)}</text>`;
s += `<text x="${pl}" y="${H - 6}">증가율 높은 순 →</text>`;
el.innerHTML = s;
