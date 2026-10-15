import { O, t, el, icon, chip, num, compact, ms, f, fin, usd, pct, timeNode, inferred, badge, panel, select, linkBtn, vs, repaint } from './core.js';
import { dataTable } from './table.js';
import { healthBadge, healthState, healthLabel, FLAGGED } from './health.js';

const startOf = x => ms(x.startedAt) ?? ms(x.createdAt);
function endOf(x) {
  const e = ms(x.endedAt);
  if (e != null) return e;
  const s = startOf(x);
  if (O.TERMINAL.has(x.status)) return s != null && fin(x.stats?.runtimeMs) ? s + x.stats.runtimeMs : s;
  return Date.now();
}
const runtime = x => fin(x.stats?.runtimeMs) ? x.stats.runtimeMs : (startOf(x) != null ? endOf(x) - startOf(x) : NaN);
const tokensOf = x => x.stats?.totalTokens ?? x.tokens;
const toolsOf = x => x.stats?.toolCalls ?? x.toolCount;
const modelOf = x => x.effectiveModel || [x.provider, x.model].filter(Boolean).join('/') || '';
const sum = (rows, get) => rows.reduce((a, r) => a + (fin(get(r)) ? get(r) : 0), 0);

export const openTask = (pid, id, tab = 'tasks') => O.navigate({ pid, tab, target: { kind: 'task', id } });

function treeOrder(tasks) {
  const ids = new Set(tasks.map(x => x.id)), kids = new Map();
  const sorted = [...tasks].sort((a, b) => (startOf(a) ?? 0) - (startOf(b) ?? 0));
  for (const x of sorted) { const p = ids.has(x.parentId) && x.parentId !== x.id ? x.parentId : ''; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(x); }
  const out = [], seen = new Set();
  const walk = (p, d) => { for (const x of kids.get(p) || []) { if (seen.has(x.id)) continue; seen.add(x.id); out.push([x, d]); walk(x.id, d + 1); } };
  walk('', 0);
  for (const x of sorted) if (!seen.has(x.id)) out.push([x, 0]);
  return out;
}
export function phaseRanges(plan) {
  const out = [];
  for (const ph of plan?.phases || []) {
    const items = ph.items || [], starts = items.map(i => ms(i.startedAt)).filter(v => v != null);
    if (!starts.length) continue;
    const live = items.some(i => i.status === 'in_progress');
    const ends = items.map(i => ms(i.completedAt) ?? ms(i.droppedAt)).filter(v => v != null);
    const to = live ? Date.now() : Math.max(...ends, ...starts);
    out.push({ name: ph.name, from: Math.min(...starts), to });
  }
  return out;
}

export function tasksTab(pid, st) {
  const tasks = Array.isArray(st.tasks) ? st.tasks : [];
  const s = vs('tasks:' + pid, () => ({ sort: { id: 'started', dir: 'desc' }, q: '', status: 'all', agent: 'all', sel: null }));
  if (!tasks.length) return [O.stateBox(t('tasks.none'), t('tasks.noneText'))];
  const sel = s.sel;
  const q = s.q.trim().toLowerCase();
  const rows = tasks.filter(x => (s.status === 'all' || x.status === s.status) && (s.agent === 'all' || (x.agent || '') === s.agent)
    && (!q || [x.name, x.agent, modelOf(x), x.planItem?.content, x.id].some(v => String(v || '').toLowerCase().includes(q)))
    && (!sel || (startOf(x) != null && startOf(x) <= sel.to && endOf(x) >= sel.from)));
  return [gantt(pid, st, tasks, s, new Set(rows.map(r => r.id))), table(pid, tasks, rows, s)];
}

function table(pid, tasks, rows, s) {
  const statuses = [...new Set(tasks.map(x => x.status))], agents = [...new Set(tasks.map(x => x.agent || ''))];
  const search = el('input', 'field'); search.type = 'search'; search.value = s.q; search.dataset.key = 'tasks:q';
  search.placeholder = t('tasks.search'); search.setAttribute('aria-label', t('tasks.search'));
  search.addEventListener('input', () => { s.q = search.value; repaint(); });
  const p = panel(t('tasks.table'), { id: 'tasks-table', note: rows.length === tasks.length ? t('tasks.count', { count: tasks.length }) : t('tasks.countOf', { shown: num(rows.length), total: num(tasks.length) }),
    tools: [search,
      select(t('tasks.status'), 'tasks:status', [['all', t('tasks.allStatuses')], ...statuses.map(v => [v, O.has('status.' + v) ? t('status.' + v) : v])], s.status, v => { s.status = v; repaint(); }),
      select(t('tasks.agent'), 'tasks:agent', [['all', t('tasks.allAgents')], ...agents.map(v => [v, v || '—'])], s.agent, v => { s.agent = v; repaint(); })] });
  const open = O.app.route.target?.kind === 'task' ? O.app.route.target.id : null;
  const cols = [
    { id: 'name', label: t('tasks.col.name'), get: x => x.name || x.id, cell: x => {
      const b = el('button', 'rowlink', x.name || x.id); b.type = 'button'; b.dataset.key = 't:' + x.id; b.title = x.name || x.id;
      b.style.paddingLeft = Math.max(0, (x.depth || 1) - 1) * 14 + 'px';
      b.addEventListener('click', () => openTask(pid, x.id)); return b; } },
    { id: 'agent', label: t('tasks.col.agent'), get: x => x.agent || '' },
    { id: 'status', label: t('tasks.col.status'), get: x => x.status, cell: x => {
      const hb = healthBadge(x);
      if (!hb) return chip(x.status);
      const c = el('span', 'cell-sub'); c.append(chip(x.status), hb); return c; } },
    { id: 'model', label: t('tasks.col.model'), get: modelOf, cell: x => {
      const c = el('span', 'cell-sub'), m = el('span', 't mono', modelOf(x).split('/').pop() || t('common.noModel')); m.title = modelOf(x);
      c.append(m);
      if (x.fallbackUsed) c.append(badge(t('tasks.fallback'), 'warning', t('tasks.fallbackTip', { requested: x.requestedModel || '—', effective: x.effectiveModel || '—' })));
      return c; } },
    { id: 'started', label: t('tasks.col.started'), get: startOf, cell: x => timeNode(x.startedAt || x.createdAt) },
    { id: 'dur', label: t('tasks.col.duration'), num: true, get: runtime, cell: x => fin(runtime(x)) ? O.durShort(runtime(x)) : '—', total: r => O.durShort(sum(r, runtime)) },
    { id: 'tools', label: t('tasks.col.tools'), num: true, get: toolsOf, cell: x => num(toolsOf(x)), total: r => num(sum(r, toolsOf)) },
    { id: 'tokens', label: t('tasks.col.tokens'), num: true, get: tokensOf, cell: x => { const v = el('span', '', compact(tokensOf(x))); if (fin(tokensOf(x))) v.title = num(tokensOf(x)); return v; }, total: r => compact(sum(r, tokensOf)) },
    { id: 'cost', label: t('tasks.col.cost'), title: t('ui.costTip'), num: true, get: x => x.stats?.costUsd, cell: x => usd(x.stats?.costUsd), total: r => usd(sum(r, x => x.stats?.costUsd)) },
    { id: 'cache', label: t('tasks.col.cache'), num: true, get: x => x.stats?.cacheHitRate, cell: x => {
      const r = x.stats?.cacheHitRate, c = el('span', '', pct(r));
      if (fin(r)) { const m = el('span', 'meter'); m.dataset.tone = 'success'; const b = el('span'); b.style.width = Math.round(r * 100) + '%'; m.append(b); c.append(m); }
      return c; }, total: r => { const w = sum(r, x => fin(x.stats?.cacheHitRate) ? tokensOf(x) : NaN); return w ? pct(sum(r, x => fin(x.stats?.cacheHitRate) ? x.stats.cacheHitRate * (tokensOf(x) || 0) : NaN) / w) : '—'; } },
    { id: 'plan', label: t('tasks.col.plan'), get: x => x.planItem?.content || '', cell: x => {
      if (!x.planItem) return '—';
      const c = el('span', 'cell-sub'), v = el('span', 't', x.planItem.content); v.title = `${x.planItem.phase} · ${x.planItem.content}`;
      c.append(v, inferred('tasks.planTip')); return c; } },
  ];
  const body = rows.length
    ? dataTable({ key: 'tasks', columns: cols, rows, sort: s.sort, rowKey: x => x.id, onRow: x => openTask(pid, x.id), selected: open, caption: t('tasks.table'), totals: true })
    : el('p', 'empty', t('tasks.noMatch'));
  p.append(body);
  return p;
}

function gantt(pid, st, tasks, s, visible) {
  const order = treeOrder(tasks), phases = phaseRanges(st.plan);
  const starts = tasks.map(startOf).filter(v => v != null);
  const p = panel(t('tasks.timeline'), { id: 'tasks-gantt', note: t('tasks.timelineNote') });
  if (!starts.length) { p.append(el('p', 'empty', t('tasks.noTimes'))); return p; }
  let from = Math.min(...starts), to = Math.max(...tasks.map(endOf).filter(v => v != null), from + 60000);
  const pad = (to - from) * 0.02; from -= pad; to += pad;
  const span = to - from, X = v => ((v - from) / span) * 100;
  const fmtT = span > 864e5 ? v => f().dateTime.format(v) : v => f().hm.format(v);
  const box = el('div', 'gantt');
  const head = el('div', 'g-head'), axis = el('div', 'g-axis');
  const n = matchMedia('(max-width:760px)').matches ? 3 : 6;
  for (let i = 0; i <= n; i++) { const v = from + (span * i) / n, l = el('span', i === 0 ? 'first' : i === n ? 'last' : '', fmtT(v)); l.style.left = (i * 100) / n + '%'; axis.append(l); }
  head.append(el('span', 'note', t('tasks.col.name')), axis);
  const body = el('div', 'g-body'), layer = el('div', 'g-layer');
  for (const ph of phases) {
    const a = Math.max(from, ph.from), b = Math.min(to, ph.to);
    if (b <= a) continue;
    const band = el('div', 'g-band'); band.style.left = X(a) + '%'; band.style.width = `max(3px, ${X(b) - X(a)}%)`; band.title = ph.name;
    band.append(el('span', '', ph.name)); layer.append(band);
  }
  const now = Date.now();
  if (now > from && now < to) { const nl = el('div', 'g-now'); nl.style.left = X(now) + '%'; layer.append(nl); }
  let selBox = null;
  if (s.sel) { selBox = el('div', 'g-sel'); selBox.style.left = X(Math.max(from, s.sel.from)) + '%'; selBox.style.width = Math.max(0.3, X(Math.min(to, s.sel.to)) - X(Math.max(from, s.sel.from))) + '%'; layer.append(selBox); }
  body.append(layer);
  const open = O.app.route.target?.kind === 'task' ? O.app.route.target.id : null;
  for (const [x, depth] of order) {
    const row = el('div', 'g-row'), lab = el('div', 'g-label'), track = el('div', 'g-track');
    lab.style.paddingLeft = depth * 12 + 'px';
    if (depth) lab.append(icon('corner', 'sm'));
    const nm = el('span', 't', x.name || x.id); nm.title = x.name || x.id; lab.append(nm);
    const a = startOf(x), b = endOf(x);
    if (a != null) {
      const bar = el('button', 'g-bar'); bar.type = 'button'; bar.dataset.key = 'g:' + x.id;
      bar.dataset.tone = O.STATUS_TONE[x.status] || 'neutral';
      if (!O.TERMINAL.has(x.status)) bar.dataset.live = '';
      if (!visible.has(x.id)) bar.classList.add('g-dim');
      bar.style.left = X(a) + '%'; bar.style.width = Math.max(0, X(b ?? a) - X(a)) + '%';
      bar.setAttribute('aria-pressed', String(open === x.id));
      const hs = healthState(x), since = ms(x.health?.since);
      if (hs) bar.dataset.health = hs;
      const lbl = `${x.name || x.id} · ${O.has('status.' + x.status) ? t('status.' + x.status) : x.status}${hs ? ' · ' + healthLabel(x) : ''} · ${fmtT(a)}–${fmtT(b ?? a)} · ${fin(runtime(x)) ? O.durShort(runtime(x)) : '—'}`;
      if (FLAGGED.has(hs) && since != null && since >= from && since <= to) {
        const mk = el('span', 'g-mark'); mk.dataset.health = hs; mk.style.left = X(since) + '%';
        mk.title = t('wd.gantt', { time: fmtT(since) }); mk.setAttribute('aria-hidden', 'true');
        track.append(mk);
      }
      bar.title = lbl; bar.setAttribute('aria-label', lbl);
      bar.addEventListener('click', () => openTask(pid, x.id));
      track.append(bar);
    }
    row.append(lab, track); body.append(row);
  }
  brush(body, layer, from, span, s);
  box.append(head, body);
  p.append(box, ganttFoot(s, phases, fmtT));
  return p;
}

function brush(body, layer, from, span, s) {
  let start = null, sel = null;
  const at = e => { const r = layer.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  body.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('.g-bar') || !e.target.closest('.g-track')) return;
    start = at(e); body.setPointerCapture(e.pointerId);
  });
  body.addEventListener('pointermove', e => {
    if (start == null) return;
    const x = at(e);
    if (!sel && Math.abs(x - start) * layer.clientWidth < 4) return;
    if (!sel) { layer.querySelector('.g-sel')?.remove(); sel = el('div', 'g-sel'); layer.append(sel); }
    sel.style.left = Math.min(x, start) * 100 + '%'; sel.style.width = Math.abs(x - start) * 100 + '%';
  });
  const end = e => {
    if (start == null) return;
    const x = at(e), a = Math.min(x, start), b = Math.max(x, start), dragged = !!sel;
    start = null; sel = null;
    if (dragged) { s.sel = { from: from + a * span, to: from + b * span }; repaint(); }
  };
  body.addEventListener('pointerup', end);
  body.addEventListener('pointercancel', () => { start = null; sel?.remove(); sel = null; });
}

function ganttFoot(s, phases, fmtT) {
  const foot = el('div', 'chart-foot');
  const line = el('div', 'g-sel-line');
  if (s.sel) {
    line.append(el('span', '', s.sel.phase ? t('tasks.selPhase', { phase: s.sel.phase }) : t('tasks.selRange', { from: fmtT(s.sel.from), to: fmtT(s.sel.to) })),
      linkBtn(t('tasks.clearSel'), 'tasks:clear', () => { s.sel = null; repaint(); }));
  } else line.append(el('span', 'note', t('tasks.brushHint')));
  foot.append(line);
  if (phases.length) {
    const g = el('div', 'g-phases'); g.setAttribute('role', 'group'); g.setAttribute('aria-label', t('tasks.byPhase'));
    g.append(el('span', 'note', t('tasks.byPhase')));
    for (const ph of phases) {
      const b = el('button', 'tchip'); b.type = 'button'; b.dataset.key = 'tasks:phase:' + ph.name;
      const on = s.sel?.phase === ph.name; b.setAttribute('aria-pressed', String(on));
      if (on) b.append(icon('check', 'sm'));
      b.append(el('span', 't', ph.name));
      b.addEventListener('click', () => { s.sel = on ? null : { from: ph.from, to: ph.to, phase: ph.name }; repaint(); });
      g.append(b);
    }
    foot.append(g);
  }
  return foot;
}
