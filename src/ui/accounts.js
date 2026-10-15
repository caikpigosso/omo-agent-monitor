import { O, t, el, num, compact, ms, f, fin, ago, dateTime, timeNode, countdown, inferred, badge, statusChip, panel, seg, vs, load, loadState, qs, providerName, accountLabel, kpi, DAY, HOUR } from './core.js';
import { quotaChart, ring, legend, PALETTE } from './charts.js';
import { dataTable, tableToggle } from './table.js';

const RANGES = { '24h': DAY, '7d': 7 * DAY };
function windowRange(range) {
  const to = Math.ceil(Date.now() / 60000) * 60000, from = Math.floor((to - RANGES[range]) / HOUR) * HOUR + HOUR;
  return { from, to, q: qs({ from: new Date(from).toISOString(), to: new Date(to).toISOString() }) };
}

export function accountsPage() {
  const s = vs('acc:view', { range: '24h' });
  const w = windowRange(s.range);
  const acc = load('acc:accounts', '/api/accounts');
  const hist = load('acc:qh', `/api/quota-history?${w.q}`);
  const usage = load('acc:usage', `/api/usage?${w.q}&bucket=hour&groupBy=account`);
  const ins = load('acc:ins', `/api/insights?${w.q}`);
  const head = el('header', 'vhead'), hl = el('div');
  hl.append(el('h1', '', t('nav.accounts')), el('p', '', t('acc.subtitle')));
  head.append(hl, seg(t('usage.range'), 'acc:range', Object.keys(RANGES).map(r => [r, t('usage.r.' + r)]), s.range, v => { s.range = v; O.renderMain(); }));
  const wait = loadState(acc);
  if (wait) return [head, wait];
  const rep = acc.data, accounts = rep.accounts || [], now = Date.now();
  const blocked = accounts.filter(a => (ms(a.blockedUntil) ?? 0) > now).length;
  const k = el('section', 'kpis'); k.setAttribute('aria-label', t('acc.kpis'));
  k.append(kpi(t('acc.total'), num(rep.counts?.total ?? accounts.length), t('acc.activeN', { count: accounts.filter(a => a.active).length })));
  for (const [p, n] of Object.entries(rep.counts?.byProvider || {})) k.append(kpi(providerName(p), num(n), el('p', 'm-sub mono', p)));
  k.append(kpi(t('acc.blockedNow'), num(blocked), null, { tone: blocked ? 'danger' : null }));
  const out = [head, k];
  for (const j of [hist, usage, ins]) if (j.error) out.push(O.notice(t('ui.loadFailed') + ': ' + O.errMsg(j.error), 'danger'));
  const ctx = { w, samples: hist.data?.samples || [], series: usage.data?.series || [], burn: ins.data?.burn || [], loading: !hist.data || !usage.data };
  for (const a of accounts) out.push(accountCard(a, (rep.quotas || []).find(q => q.provider === a.provider && q.account === a.name), ctx));
  const orphan = (rep.quotas || []).filter(q => !accounts.some(a => a.provider === q.provider && a.name === q.account));
  for (const q of orphan) out.push(accountCard({ id: `${q.provider}:${q.account || ''}`, provider: q.provider, name: q.account || providerName(q.provider) }, q, ctx));
  const un = ctx.series.filter(x => /:unknown$/.test(x.key));
  if (un.length) out.push(unattributed(un, s.range));
  if (!accounts.length && !orphan.length) out.push(O.stateBox(t('acc.none'), t('acc.noneText')));
  return out;
}

function kvList(rows) {
  const kv = el('dl', 'kv');
  for (const [k, v] of rows) { kv.append(el('dt', '', k)); const dd = el('dd'); for (const x of [v].flat()) if (x != null) dd.append(x); kv.append(dd); }
  return kv;
}
function blockLine(a) {
  const until = ms(a.blockedUntil), reason = a.blockReason ? el('span', 'note', ` · ${a.blockReason}`) : null;
  if (until == null) return [el('span', '', t('acc.notBlocked'))];
  if (until > Date.now()) {
    const c = el('span', 'cell-sub'); c.append(statusChip('blocked', 'acc.blocked'), el('span', '', t('acc.until') + ' '), timeNode(a.blockedUntil), el('span', '', ' · '), countdown(a.blockedUntil));
    return [c, reason];
  }
  const c = el('span', 'muted', t('acc.blockExpired', { when: ago(a.blockedUntil) })); c.title = dateTime(a.blockedUntil);
  return [c, reason];
}
function expiry(a) {
  const x = ms(a.expiresAt);
  if (x == null) return ['—'];
  const n = el('span', '', `${dateTime(a.expiresAt)} (${ago(a.expiresAt)})`);
  return x < Date.now() ? [n, ' ', badge(t('acc.expired'), 'warning', t('acc.expiredTip'))] : [n];
}

function accountCard(a, quota, ctx) {
  const tags = [];
  if (a.active) tags.push(badge(t('acc.active'), 'success'));
  if (a.pinned) tags.push(badge(t('acc.pinned'), 'info'));
  if (a.state) tags.push(statusChip(a.state, O.has('acc.state.' + a.state) ? 'acc.state.' + a.state : null));
  if (quota?.plan) tags.push(badge(quota.plan));
  const p = panel(`${providerName(a.provider)} · ${a.name}`, { id: 'acc-' + a.id, tags });
  const body = el('div', 'acc-body');
  const info = el('div', 'acc-info');
  info.append(kvList([
    [t('acc.block'), blockLine(a)],
    [t('acc.expires'), expiry(a)],
    [t('acc.lastSuccess'), a.lastSuccessAt ? [timeNode(a.lastSuccessAt, ago(a.lastSuccessAt))] : ['—']],
    [t('acc.failures'), [el('span', a.failureCount ? 'warn-ink' : '', fin(a.failureCount) ? num(a.failureCount) : '0')]],
    [t('acc.id'), [el('span', 'mono note', a.provider)]],
  ]));
  body.append(info);
  const gauges = el('div', 'gauges');
  if (quota?.windows?.length) {
    for (const wnd of quota.windows) gauges.append(gauge(a, quota, wnd, ctx.burn));
  } else gauges.append(el('p', 'empty', t('acc.noQuota')));
  body.append(gauges);
  p.append(body);
  if (quota) {
    const meta = el('p', 'cov acc-upd'); meta.append(el('span', '', t('acc.quotaUpdated', { when: ago(quota.updatedAt) })));
    p.append(meta);
  }
  p.append(historyBlock(a, ctx));
  return p;
}

function gauge(a, quota, wnd, burnList) {
  const g = el('div', 'gauge');
  g.append(ring(wnd.percent, t('acc.gaugeAria', { window: wnd.label, percent: Math.round(wnd.percent) })));
  const txt = el('div', 'g-txt');
  txt.append(el('strong', '', wnd.label));
  const reset = el('span', 'note'); reset.append(t('acc.resetsIn') + ' ', countdown(wnd.resetsAt)); txt.append(reset);
  const b = burnList.find(x => x.provider === a.provider && (x.account ?? '') === (quota.account ?? '') && x.window === wnd.label);
  const burn = el('span', 'note');
  if (b && fin(b.percentPerHour)) {
    burn.append(t('acc.burn', { rate: f().dec.format(b.percentPerHour) }));
    const ex = ms(b.projectedExhaustAt), rs = ms(wnd.resetsAt);
    if (ex != null) burn.append(' · ', ex < (rs ?? Infinity) ? t('acc.exhaust', { when: dateTime(b.projectedExhaustAt) }) : t('acc.resetFirst'));
    else if (b.percentPerHour <= 0) burn.append(' · ', t('acc.flat'));
  } else burn.append(t('acc.burnLabel') + ' ' + t('ui.collecting'));
  burn.append(' ', inferred('acc.burnTip'));
  txt.append(burn);
  g.append(txt);
  return g;
}

function historyBlock(a, ctx) {
  const s = vs('acc:hist:' + a.id, { table: false });
  const box = el('div', 'acc-hist');
  const head = el('div', 'acc-hist-head');
  head.append(el('h3', '', t('acc.history')), inferred('acc.historyTip'), el('span', 'tb-gap'), tableToggle(s, 'acc:hist:' + a.id));
  box.append(head);
  if (ctx.loading) { box.append(el('p', 'empty', t('ui.loadingData'))); return box; }
  const samples = ctx.samples.filter(x => x.provider === a.provider && (x.account ?? '') === (a.name ?? ''));
  const key = `${a.provider}:${a.name}`;
  const series = ctx.series.find(x => x.key === key);
  const labels = [...new Set(samples.flatMap(x => (x.windows || []).map(wd => wd.label)))];
  const lines = labels.map((label, i) => ({ label, color: PALETTE[i % PALETTE.length], points: samples.map(x => ({ t: Date.parse(x.at), v: x.windows.find(wd => wd.label === label)?.percent })).filter(p => fin(p.v) && fin(p.t)) }));
  const bs = [], vals = [];
  for (let v = ctx.w.from; v < ctx.w.to; v += HOUR) { bs.push(v); vals.push(0); }
  for (const pt of series?.points || []) { const i = Math.floor((Date.parse(pt.t) - ctx.w.from) / HOUR); if (i >= 0 && i < vals.length) vals[i] += pt.totalTokens || 0; }
  if (!samples.length && !vals.some(Boolean)) { box.append(el('p', 'empty', t('acc.noHistory'))); return box; }
  if (s.table) {
    box.append(dataTable({ key: 'acc:ht:' + a.id, caption: t('acc.history'), rows: [...samples].reverse(), columns: [
      { id: 'at', label: t('plan.when'), cell: x => timeNode(x.at) },
      ...labels.map(l => ({ id: l, label: l, num: true, cell: x => { const v = x.windows.find(wd => wd.label === l)?.percent; return fin(v) ? v + '%' : '—'; } }))] }));
    if (series) box.append(el('p', 'note', t('acc.usageInRange', { tokens: compact(vals.reduce((x, y) => x + y, 0)) })));
    return box;
  }
  const barLabel = t('acc.tokensBar');
  box.append(quotaChart({ key: 'acc:qc:' + a.id, from: ctx.w.from, to: ctx.w.to, lines, bars: { buckets: bs, values: vals, step: HOUR, color: 'var(--c7)', label: barLabel }, fmtBar: compact,
    label: t('acc.chartAria', { account: accountLabel(key), count: samples.length }) }));
  box.append(legend([...lines.map(l => ({ label: l.label, color: l.color, line: true })), { label: barLabel, color: 'var(--c7)', tag: inferred('usage.accountTip') }]));
  if (samples.length < 2) box.append(el('p', 'note', t('acc.historyStarts')));
  return box;
}

function unattributed(list, range) {
  const p = panel(t('acc.unattributedTitle'), { id: 'acc-unknown', tags: [inferred('acc.unknownTip')] });
  const body = el('div', 'pbody');
  for (const x of list) {
    const tot = (x.points || []).reduce((a, pt) => ({ tokens: a.tokens + (pt.totalTokens || 0), msgs: a.msgs + (pt.messages || 0) }), { tokens: 0, msgs: 0 });
    body.append(el('p', '', t('acc.unknownLine', { account: accountLabel(x.key), tokens: compact(tot.tokens), messages: num(tot.msgs), range: t('usage.r.' + range) })));
  }
  body.append(el('p', 'note', t('acc.unknownTip')));
  p.append(body);
  return p;
}
