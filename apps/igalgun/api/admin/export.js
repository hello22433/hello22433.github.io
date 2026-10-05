// 관리자 내보내기. Authorization: Bearer <ADMIN_TOKEN>
//   ?type=leads|partners|subscribers|orders&format=csv|json
import { store } from '../../lib/store.js';
import { handle, json, fail, requireAdmin } from '../../lib/http.js';

const TYPES = ['leads', 'partners', 'subscribers', 'orders'];

function flatten(o, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? v.join(' ') : v;
  }
  return out;
}

function toCsv(rows) {
  const flat = rows.map((r) => flatten(r));
  const cols = [...new Set(flat.flatMap((r) => Object.keys(r)))];
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // 스프레드시트 수식 주입 방지
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.join(','), ...flat.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}

export const GET = handle(async (request) => {
  requireAdmin(request);
  const q = new URL(request.url).searchParams;
  const type = q.get('type') || 'leads';
  if (!TYPES.includes(type)) return fail(400, '알 수 없는 종류입니다');
  const rows = await store.list(type);
  await store.push('admin_log', { at: new Date().toISOString(), action: 'export', type, count: rows.length });
  if (q.get('format') === 'json') return json({ ok: true, type, rows });
  return new Response(toCsv(rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="igalgun-${type}-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
});
