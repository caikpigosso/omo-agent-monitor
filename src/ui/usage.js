import { O, t, el, num, compact, f, fin, usd, ago, inferred, panel, seg, select, vs, load, loadState, rangeOf, qs, seriesLabel, kpi, DAY } from './core.js';
import { stackedBars, legend, PALETTE, OTHER } from './charts.js';
import { dataTable, tableToggle } from './table.js';
import { overviewSections, projectSections } from './rankings.js';

export const METRICS = { tokens: m => m.totalTokens || 0, cost: m => m.costUsd || 0, messages: m => m.messages || 0 };
export const fmtMetric = metric => metric === 'cost' ? usd : metric === 'messages' ? num : compact;
const GROUPS = ['provider', 'model', 'project', 'agent', 'session', 'account'];
const RANGES = ['24h', '7d', '30d'];

export const usageUrl = (range, groupBy) => { const r = rangeOf(range); return `/api/usage?${qs({ from: r.from, to: r.to, bucket: r.bucket, groupBy })}`; };

function buckets(report, step) {
  const out = [], from = Math.floor(Date.parse(report.from) / step) * step, to = Date.parse(report.to);
  for (let v = from; v < to; v += step) out.push(v);
  return out;
}
function seriesFor(report, metric, step, groupBy, onlyKey) {
  const bs = buckets(report, step), idx = new Map(bs.map((b, i) => [b, i]));
  let list = (report.series || []).filter(s => !onlyKey || s.key === onlyKey).map(s => {
    const values = new Array(bs.length).fill(0);
    for (const p of s.points || []) { const i = idx.get(Math.floor(Date.parse(p.t) / step) * step); if (i != null) values[i] += METRICS[metric](p); }
    return { key: s.key, label: seriesLabel(groupBy, s), inferred: s.inferred, values, total: values.reduce((a, b) => a + b, 0), raw: s };
  }).filter(s => s.total > 0).sort((a, b) => b.total - a.total);
  if (list.length > 8) {
    const rest = list.slice(7), other = { key: '__other', label: t('usage.other', { count: rest.length }), values: bs.map((_, i) => rest.reduce((a, s) => a + s.values[i], 0)) };
    other.total = other.values.reduce((a, b) => a + b, 0); other.raw = { points: rest.flatMap(s => s.raw.points || []) };
    list = [...list.slice(0, 7), other];
  }
  list.forEach((s, i) => { s.color = s.key === '__other' ? OTHER : PALETTE[i % PALETTE.length]; });
  return { bs, list };
}
const sumPoints = (points = [], from = -Infinity) => points.reduce((m, p) => {
  if (Date.parse(p.t) < from) return m;
  for (const k of ['messages', 'totalTokens', 'costUsd']) m[k] += p[k] || 0;
  return m;
}, { messages: 0, totalTokens: 0, costUsd: 0 });

/* Today / 7d / 30d totals from two cached reports; onlyKey restricts to one series (a project). */
export function periodTotals(prefix, groupBy, onlyKey) {
  const h = load(prefix + 'k24', usageUrl('24h', groupBy)), d = load(prefix + 'k30', usageUrl('30d', groupBy));
  const pick = j => (j.data?.series || []).filter(s => !onlyKey || s.key === onlyKey).flatMap(s => s.points || []);
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  return {
    ready: !!(h.data && d.data), error: h.error || d.error, coverage: d.data?.coverage,
    today: h.data ? sumPoints(pick(h), midnight.getTime()) : null,
    d7: d.data ? sumPoints(pick(d), Date.now() - 7 * DAY) : null,
    d30: d.data ? sumPoints(pick(d)) : null,
  };
}
export function periodKpis(p) {
  const v = (k, fmt) => p.today ? fmt(p.today[k]) : '—';
  const sub = (k, fmt) => p.d7 ? `${t('usage.d7')} ${fmt(p.d7[k])} · ${t('usage.d30')} ${fmt(p.d30[k])}` : t('ui.loadingData');
  return [
    kpi(t('usage.tokensToday'), v('totalTokens', compact), sub('totalTokens', compact)),
    kpi(t('usage.costToday'), v('costUsd', usd), sub('costUsd', usd), { title: t('ui.costTip') }),
    kpi(t('usage.msgsToday'), v('messages', num), sub('messages', num)),
  ];
}

export function coverageNote(cov) {
  if (!cov) return null;
  const n = el('p', 'cov');
  n.append(el('span', '', t('usage.coverage', { count: cov.files, when: ago(cov.indexedAt) })));
  if (cov.partial) n.append(O.tag(t('usage.partial'), 'warning'));
  return n;
}

/* The stacked usage card. opts.project pins groupBy=project to one series (the project tab). */
export function usageCard(prefix, opts = {}) {
  const s = vs(prefix + 'chart', { range: '7d', groupBy: opts.project ? 'project' : 'provider', metric: 'tokens', table: false });
  const groupBy = opts.project ? 'project' : s.groupBy;
  const j = load(prefix + 'usage', usageUrl(s.range, groupBy));
  const tools = [
    seg(t('usage.range'), prefix + 'range', RANGES.map(r => [r, t('usage.r.' + r)]), s.range, v => { s.range = v; O.renderMain(); }),
    !opts.project && select(t('usage.groupBy'), prefix + 'group', GROUPS.map(g => [g, t('usage.g.' + g)]), s.groupBy, v => { s.groupBy = v; O.renderMain(); }),
    seg(t('usage.metric'), prefix + 'metric', [['tokens', t('usage.m.tokens')], ['cost', t('usage.m.cost')], ['messages', t('usage.m.messages')]], s.metric, v => { s.metric = v; O.renderMain(); }),
    tableToggle(s, prefix + 'chart'),
  ];
  const p = panel(opts.title || t('usage.title'), { id: prefix + 'usage', tools, tags: groupBy === 'account' ? [inferred('usage.accountTip')] : [] });
  const wait = loadState(j);
  if (wait) { p.append(wait); return p; }
  const r = j.data, step = r.bucket === 'hour' ? 36e5 : DAY;
  const { bs, list } = seriesFor(r, s.metric, step, groupBy, opts.project);
  const fmtV = fmtMetric(s.metric);
  const fmtX = r.bucket === 'hour' ? v => f().hm.format(v) : v => f().day.format(v);
  const fmtTip = r.bucket === 'hour' ? v => f().dateTime.format(v) : v => f().day.format(v);
  if (!list.length) { p.append(el('p', 'empty', t('usage.empty'))); }
  else if (s.table) {
    const totals = list.map(x => ({ ...x, m: sumPoints(x.raw.points) }));
    p.append(dataTable({ key: prefix + 'utable', caption: t('usage.title'), rows: totals, sort: s.sort ??= { id: 'tokens', dir: 'desc' }, totals: true, columns: [
      { id: 'label', label: t('usage.g.' + groupBy), get: x => x.label, cell: x => { const c = el('span', 'cell-sub'); c.append(el('span', 't', x.label)); if (x.inferred) c.append(inferred('usage.accountTip')); return c; } },
      { id: 'messages', label: t('usage.m.messages'), num: true, get: x => x.m.messages, cell: x => num(x.m.messages), total: rs => num(rs.reduce((a, x) => a + x.m.messages, 0)) },
      { id: 'tokens', label: t('usage.m.tokens'), num: true, get: x => x.m.totalTokens, cell: x => compact(x.m.totalTokens), total: rs => compact(rs.reduce((a, x) => a + x.m.totalTokens, 0)) },
      { id: 'cost', label: t('ui.cost'), title: t('ui.costTip'), num: true, get: x => x.m.costUsd, cell: x => usd(x.m.costUsd), total: rs => usd(rs.reduce((a, x) => a + x.m.costUsd, 0)) },
    ] }));
  } else {
    const total = list.reduce((a, x) => a + x.total, 0);
    const wrap = el('div', 'chart-wrap');
    wrap.append(stackedBars({ key: prefix + 'bars', buckets: bs, series: list, fmtV, fmtX, fmtTip,
      label: t('usage.aria', { metric: t('usage.m.' + s.metric), range: t('usage.r.' + s.range), total: fmtV(total), groups: list.map(x => x.label).join(', ') }) }));
    p.append(wrap, legend(list.map(x => ({ label: `${x.label} · ${fmtV(x.total)}`, color: x.color, tag: x.inferred ? inferred('usage.accountTip') : null }))));
  }
  const foot = el('div', 'chart-foot'), cov = coverageNote(r.coverage);
  if (cov) foot.append(cov);
  if (s.metric === 'cost') foot.append(el('span', 'note', t('ui.costTip')));
  if (opts.note) foot.append(el('span', 'note', opts.note));
  p.append(foot);
  return p;
}

export function overviewPage() {
  const prefix = 'ov:';
  const snap = O.app.projects, projects = snap?.projects || [];
  const acc = load(prefix + 'accounts', '/api/accounts');
  const per = periodTotals(prefix, 'provider');
  const head = el('header', 'vhead'), hl = el('div');
  hl.append(el('h1', '', t('nav.overview')), el('p', '', t('ov.subtitle')));
  head.append(hl);
  const k = el('section', 'kpis'); k.setAttribute('aria-label', t('ov.kpis'));
  const running = projects.reduce((a, p) => a + (p.counts?.running || 0), 0);
  const counts = acc.data?.counts;
  k.append(...periodKpis(per),
    kpi(t('ov.sessions'), num(projects.length), t('ov.online', { count: projects.filter(p => p.online).length })),
    kpi(t('ov.running'), num(running), null, { tone: running ? 'info' : null }),
    kpi(t('nav.accounts'), counts ? num(counts.total) : '—', counts ? Object.entries(counts.byProvider || {}).map(([p, n]) => `${seriesLabel('provider', { key: p })} ${num(n)}`).join(' · ') : null));
  const out = [head];
  if (per.error) out.push(O.notice(t('ui.loadFailed') + ': ' + O.errMsg(per.error), 'danger'));
  out.push(k, usageCard(prefix));
  out.push(...overviewSections(prefix, vs(prefix + 'chart', {}).range || '7d'));
  return out;
}

export function usageTab(pid, st) {
  const p = O.project(pid), prefix = `pu:${pid}:`, name = p?.name || '';
  const per = periodTotals(prefix, 'project', name);
  const tasks = Array.isArray(st.tasks) ? st.tasks : [], cs = st.coordinatorStats || {};
  const sessionCost = (cs.costUsd || 0) + tasks.reduce((a, x) => a + (x.stats?.costUsd || 0), 0);
  const sessionTokens = (cs.totalTokens || 0) + tasks.reduce((a, x) => a + (x.stats?.totalTokens ?? x.tokens ?? 0), 0);
  const running = tasks.filter(x => x.status === 'running').length;
  const k = el('section', 'kpis'); k.setAttribute('aria-label', t('ov.kpis'));
  k.append(...periodKpis(per),
    kpi(t('pu.session'), usd(sessionCost), t('pu.sessionSub', { tokens: compact(sessionTokens) }), { title: t('ui.costTip') }),
    kpi(t('ov.running'), num(running), t('pu.ofTasks', { count: tasks.length }), { tone: running ? 'info' : null }));
  const out = [];
  if (per.error) out.push(O.notice(t('ui.loadFailed') + ': ' + O.errMsg(per.error), 'danger'));
  out.push(k, usageCard(prefix, { project: name, title: t('pu.chart'), note: t('pu.chartNote', { name }) }), ...projectSections(pid, st));
  return out;
}
