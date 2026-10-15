import { O, t, el, num, compact, fin, usd, pct, badge, panel, vs, load, loadState, rangeOf, qs, providerName } from './core.js';
import { dataTable } from './table.js';
import { openTask } from './tasks.js';

function bar(value, max, tone) {
  const m = el('span', 'meter'); if (tone) m.dataset.tone = tone;
  const b = el('span'); b.style.width = (max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0) + '%'; m.append(b);
  return m;
}
const withBar = (text, value, max, tone) => { const c = el('span'); c.append(text, bar(value, max, tone)); return c; };
const errRate = x => x.calls ? x.errors / x.calls : NaN;
function nameCell(text, sub) {
  const c = el('span', 'cell-sub'), n = el('span', 't', text); n.title = text; c.append(n);
  if (sub) c.append(sub);
  return c;
}
const openProject = name => O.app.projects?.projects?.find(p => p.name === name);

const TOOL_ROWS = 12;
function toolsTable(key, all) {
  const s = vs(key, { sort: { id: 'calls', dir: 'desc' }, all: false });
  const rows = s.all ? all : [...all].sort((a, b) => b.calls - a.calls).slice(0, TOOL_ROWS);
  const maxCalls = Math.max(0, ...rows.map(r => r.calls));
  const box = el('div');
  box.append(dataTable({ key, caption: t('rk.tools'), rows, sort: s.sort, totals: s.all || all.length <= TOOL_ROWS, columns: [
    { id: 'name', label: t('rk.tool'), get: r => r.name, cell: r => el('span', 'mono', r.name) },
    { id: 'calls', label: t('rk.calls'), num: true, get: r => r.calls, cell: r => withBar(num(r.calls), r.calls, maxCalls), total: rs => num(rs.reduce((a, r) => a + r.calls, 0)) },
    { id: 'errors', label: t('rk.errors'), num: true, get: r => r.errors, cell: r => num(r.errors), total: rs => num(rs.reduce((a, r) => a + r.errors, 0)) },
    { id: 'rate', label: t('rk.errorRate'), num: true, get: errRate, cell: r => { const v = errRate(r); const c = el('span', '', pct(v)); if (v > 0) c.dataset.tone = v >= 0.1 ? 'danger' : 'warning', c.style.color = 'var(--tone)'; return c; },
      total: rs => { const c = rs.reduce((a, r) => a + r.calls, 0); return c ? pct(rs.reduce((a, r) => a + r.errors, 0) / c) : '—'; } },
  ] }));
  if (all.length > TOOL_ROWS) {
    const b = el('button', 'linkish', s.all ? t('rk.showTop', { count: TOOL_ROWS }) : t('rk.showAll', { count: all.length }));
    b.type = 'button'; b.dataset.key = key + ':all'; b.style.margin = '0 var(--s4) var(--s2)';
    b.addEventListener('click', () => { s.all = !s.all; O.renderMain(); });
    box.append(b);
  }
  return box;
}
function modelsTable(key, rows, extra = []) {
  const s = vs(key, { sort: { id: 'cost', dir: 'desc' } });
  const maxCost = Math.max(0, ...rows.map(r => r.costUsd || 0));
  return dataTable({ key, caption: t('rk.models'), rows, sort: s.sort, totals: true, columns: [
    { id: 'model', label: t('tasks.col.model'), get: r => r.model, cell: r => nameCell(r.model, r.provider ? el('span', 'note', providerName(r.provider)) : null) },
    ...extra,
    { id: 'tokens', label: t('tasks.col.tokens'), num: true, get: r => r.totalTokens, cell: r => compact(r.totalTokens), total: rs => compact(rs.reduce((a, r) => a + (r.totalTokens || 0), 0)) },
    { id: 'cost', label: t('ui.cost'), title: t('ui.costTip'), num: true, get: r => r.costUsd, cell: r => withBar(usd(r.costUsd), r.costUsd || 0, maxCost), total: rs => usd(rs.reduce((a, r) => a + (r.costUsd || 0), 0)) },
    { id: 'fallback', label: t('rk.fallbacks'), num: true, title: t('rk.fallbackTip'), get: r => r.fallbackCount, cell: r => r.fallbackCount ? badge(num(r.fallbackCount), 'warning') : '0', total: rs => num(rs.reduce((a, r) => a + (r.fallbackCount || 0), 0)) },
  ] });
}
function topTasksTable(key, rows, onOpen) {
  const s = vs(key, { sort: { id: 'cost', dir: 'desc' } });
  const maxCost = Math.max(0, ...rows.map(r => r.costUsd || 0));
  return dataTable({ key, caption: t('rk.topTasks'), rows, sort: s.sort, onRow: r => onOpen(r), columns: [
    { id: 'name', label: t('tasks.col.name'), get: r => r.name, cell: r => {
      const b = el('button', 'rowlink', r.name || r.taskId); b.type = 'button'; b.dataset.key = 'top:' + r.taskId; b.title = r.name || r.taskId;
      if (!r.canOpen) { b.disabled = true; b.title += ' · ' + t('rk.notOpen'); }
      b.addEventListener('click', () => onOpen(r));
      return b; } },
    { id: 'project', label: t('usage.g.project'), get: r => r.project },
    { id: 'agent', label: t('tasks.col.agent'), get: r => r.agent || '' },
    { id: 'status', label: t('tasks.col.status'), get: r => r.status, cell: r => O.chip(r.status) },
    { id: 'model', label: t('tasks.col.model'), get: r => r.model || '', cell: r => el('span', 'mono', r.model || '—') },
    { id: 'tokens', label: t('tasks.col.tokens'), num: true, get: r => r.totalTokens, cell: r => compact(r.totalTokens) },
    { id: 'dur', label: t('tasks.col.duration'), num: true, get: r => r.runtimeMs, cell: r => fin(r.runtimeMs) ? O.durShort(r.runtimeMs) : '—' },
    { id: 'cost', label: t('ui.cost'), title: t('ui.costTip'), num: true, get: r => r.costUsd, cell: r => withBar(usd(r.costUsd), r.costUsd || 0, maxCost) },
  ] });
}
function card(title, id, body, opts = {}) {
  const p = panel(title, { id, note: opts.note, tags: opts.tags });
  p.append(body);
  return p;
}

export function overviewSections(prefix, range) {
  const r = rangeOf(range);
  const j = load(prefix + 'ins', `/api/insights?${qs({ from: r.from, to: r.to })}`);
  const wait = loadState(j);
  if (wait) return [wait];
  const ins = j.data, rangeNote = t('rk.inRange', { range: t('usage.r.' + range) });
  const projects = [...(ins.projects || [])].map(p => ({ ...p, open: openProject(p.project) }));
  const s = vs(prefix + 'proj', { sort: { id: 'cost', dir: 'desc' } });
  const maxCost = Math.max(0, ...projects.map(p => p.costUsd || 0));
  const projTable = projects.length ? dataTable({ key: prefix + 'proj', caption: t('rk.projects'), rows: projects, sort: s.sort, totals: true,
    onRow: p => p.open && O.navigate({ pid: p.open.id, tab: 'usage', target: null }), columns: [
      { id: 'project', label: t('usage.g.project'), get: p => p.project, cell: p => {
        if (!p.open) return nameCell(p.project);
        const a = el('a', 'rowlink', p.project); a.href = O.hashFor({ pid: p.open.id, tab: 'usage' }); a.dataset.key = 'proj:' + p.project; return a; } },
      { id: 'sessions', label: t('rk.sessions'), num: true, get: p => p.sessions, cell: p => num(p.sessions), total: rs => num(rs.reduce((a, p) => a + (p.sessions || 0), 0)) },
      { id: 'tasks', label: t('ptab.tasks'), num: true, get: p => p.tasks, cell: p => num(p.tasks), total: rs => num(rs.reduce((a, p) => a + (p.tasks || 0), 0)) },
      { id: 'tokens', label: t('tasks.col.tokens'), num: true, get: p => p.totalTokens, cell: p => compact(p.totalTokens), total: rs => compact(rs.reduce((a, p) => a + (p.totalTokens || 0), 0)) },
      { id: 'cost', label: t('ui.cost'), title: t('ui.costTip'), num: true, get: p => p.costUsd, cell: p => withBar(usd(p.costUsd), p.costUsd || 0, maxCost), total: rs => usd(rs.reduce((a, p) => a + (p.costUsd || 0), 0)) },
    ] }) : el('p', 'empty', t('ui.none'));
  const models = ins.models || [], tools = ins.tools || [];
  const top = (ins.topTasks || []).slice(0, 15).map(x => ({ ...x, canOpen: !!x.projectId && (!O.stateOf(x.projectId) || !!O.taskOf(x.projectId, x.taskId)) }));
  const grid = el('div', 'grid2');
  grid.append(card(t('rk.projects'), prefix + 'rk-proj', projTable, { note: rangeNote }),
    card(t('rk.tools'), prefix + 'rk-tools', tools.length ? toolsTable(prefix + 'tools', tools) : el('p', 'empty', t('ui.none')), { note: t('rk.toolsNote') }));
  return [grid,
    card(t('rk.models'), prefix + 'rk-models', models.length ? modelsTable(prefix + 'models', models, [
      { id: 'messages', label: t('usage.m.messages'), num: true, get: r => r.messages, cell: r => num(r.messages), total: rs => num(rs.reduce((a, r) => a + (r.messages || 0), 0)) }]) : el('p', 'empty', t('ui.none')), { note: rangeNote }),
    card(t('rk.topTasks'), prefix + 'rk-top', top.length ? topTasksTable(prefix + 'top', top, x => x.canOpen && openTask(x.projectId, x.taskId, 'tasks')) : el('p', 'empty', t('ui.none')), { note: rangeNote })];
}

function mergeTools(...maps) {
  const out = new Map();
  for (const m of maps) for (const [name, v] of Object.entries(m || {})) {
    const o = out.get(name) || { name, calls: 0, errors: 0 };
    o.calls += v.calls || 0; o.errors += v.errors || 0; out.set(name, o);
  }
  return [...out.values()];
}
export function projectSections(pid, st) {
  const tasks = Array.isArray(st.tasks) ? st.tasks : [], cs = st.coordinatorStats || {}, coord = st.parents?.[0] || {};
  const byModel = new Map(), byAgent = new Map();
  const add = (map, key, init, x) => { const o = map.get(key) || { ...init, tasks: 0, totalTokens: 0, costUsd: 0, fallbackCount: 0, runtimeMs: 0 };
    o.tasks += x.task ? 1 : 0; o.totalTokens += x.tokens || 0; o.costUsd += x.cost || 0; o.fallbackCount += x.fallback ? 1 : 0; o.runtimeMs += x.runtime || 0; map.set(key, o); };
  if (cs.totalTokens || cs.costUsd) {
    const m = coord.model || t('common.noModel');
    add(byModel, m, { model: m }, { tokens: cs.totalTokens, cost: cs.costUsd });
    add(byAgent, 'coordinator', { agent: t('common.coordinator') }, { tokens: cs.totalTokens, cost: cs.costUsd });
  }
  for (const x of tasks) {
    const m = x.effectiveModel || [x.provider, x.model].filter(Boolean).join('/') || t('common.noModel');
    const v = { task: true, tokens: x.stats?.totalTokens ?? x.tokens, cost: x.stats?.costUsd, fallback: x.fallbackUsed, runtime: x.stats?.runtimeMs };
    add(byModel, m, { model: m }, v);
    add(byAgent, x.agent || '—', { agent: x.agent || '—' }, v);
  }
  const tasksCol = { id: 'tasks', label: t('ptab.tasks'), num: true, get: r => r.tasks, cell: r => num(r.tasks), total: rs => num(rs.reduce((a, r) => a + r.tasks, 0)) };
  const sa = vs('pu:' + pid + ':agents', { sort: { id: 'cost', dir: 'desc' } });
  const agents = [...byAgent.values()], maxA = Math.max(0, ...agents.map(a => a.costUsd));
  const agentTable = dataTable({ key: 'pu:' + pid + ':agents', caption: t('rk.agents'), rows: agents, sort: sa.sort, totals: true, columns: [
    { id: 'agent', label: t('tasks.col.agent'), get: r => r.agent }, tasksCol,
    { id: 'tokens', label: t('tasks.col.tokens'), num: true, get: r => r.totalTokens, cell: r => compact(r.totalTokens), total: rs => compact(rs.reduce((a, r) => a + r.totalTokens, 0)) },
    { id: 'avg', label: t('rk.avgRuntime'), num: true, get: r => r.tasks ? r.runtimeMs / r.tasks : NaN, cell: r => r.tasks && r.runtimeMs ? O.durShort(r.runtimeMs / r.tasks) : '—' },
    { id: 'cost', label: t('ui.cost'), title: t('ui.costTip'), num: true, get: r => r.costUsd, cell: r => withBar(usd(r.costUsd), r.costUsd, maxA), total: rs => usd(rs.reduce((a, r) => a + r.costUsd, 0)) },
  ] });
  const top = tasks.filter(x => fin(x.stats?.costUsd)).map(x => ({ taskId: x.id, name: x.name, project: O.project(pid)?.name, agent: x.agent, status: x.status,
    model: x.effectiveModel || x.model, costUsd: x.stats.costUsd, totalTokens: x.stats.totalTokens ?? x.tokens, runtimeMs: x.stats.runtimeMs, canOpen: true }))
    .sort((a, b) => b.costUsd - a.costUsd).slice(0, 10);
  const tools = mergeTools(cs.toolBreakdown, ...tasks.map(x => x.toolBreakdown));
  const grid = el('div', 'grid2'), note = t('pu.sessionNote');
  grid.append(card(t('rk.agents'), 'pu-agents', agentTable, { note }),
    card(t('rk.tools'), 'pu-tools', tools.length ? toolsTable('pu:' + pid + ':tools', tools) : el('p', 'empty', t('ui.none')), { note }));
  return [card(t('rk.models'), 'pu-models', modelsTable('pu:' + pid + ':models', [...byModel.values()], [tasksCol]), { note }), grid,
    card(t('rk.topTasks'), 'pu-top', top.length ? topTasksTable('pu:' + pid + ':top', top, x => openTask(pid, x.taskId, 'usage')) : el('p', 'empty', t('ui.none')), { note })];
}
