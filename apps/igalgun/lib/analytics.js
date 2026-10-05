// 관리 화면·주간 메일이 함께 쓰는 "기간 지표 + 인사이트" 조립.
import { exec, store } from './store.js';
import { readMetrics, dayRange } from './metrics.js';
import { buildInsights } from './insights.js';
import { kstDay } from './aggregate.js';
import { REGIONS } from './validate.js';

export function rangeFrom(params) {
  const to = /^\d{4}-\d{2}-\d{2}$/.test(params.get('to') || '') ? params.get('to') : kstDay();
  let from = params.get('from');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '')) {
    const days = Math.min(Math.max(Number(params.get('days') || 7), 1), 90);
    const d = new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - days + 1);
    from = d.toISOString().slice(0, 10);
  }
  return dayRange(from, to);
}

export async function analyticsFor(days) {
  const metrics = await readMetrics(exec, days);
  const subs = await store.list('subscribers', 5000);
  const truth = {
    leads: await store.count('leads'),
    partners: await store.count('partners'),
    orders: await store.count('orders'),
    subscribers: subs.length,
    waitlist: subs.filter((s) => s.topic === 'report_launch').length,
  };
  const insights = buildInsights(metrics, { regions: REGIONS, truth });
  return { metrics, insights, truth };
}
