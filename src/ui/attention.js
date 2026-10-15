import { O, t, el, icon, num, badge, countdown, ago, fullTime, ms, panel, load, rangeOf, qs, timeNode } from './core.js';
import { pendingOf, questionBadge, focusQuestions } from './questions.js';
import { healthBadge, healthState, healthLabel, FLAGGED, modeLine } from './health.js';

const firstLine = s => String(s || '').split('\n').find(l => l.trim())?.trim() || '';

function gather() {
  const qRows = [], aRows = [];
  for (const p of O.app.projects?.projects || []) {
    const st = O.stateOf(p.id), c = p.counts || {};
    if (st) {
      for (const q of pendingOf(st)) qRows.push({ p, q });
      for (const task of st.tasks || []) if (FLAGGED.has(healthState(task))) aRows.push({ p, task });
    } else {
      if (c.questions > 0) qRows.push({ p, count: c.questions });
      if (c.stalled > 0) aRows.push({ p, count: c.stalled });
    }
  }
  qRows.sort((a, b) => (ms(a.q?.askedAt) ?? 0) - (ms(b.q?.askedAt) ?? 0));
  aRows.sort((a, b) => (ms(b.task?.health?.since) ?? 0) - (ms(a.task?.health?.since) ?? 0));
  return { qRows, aRows };
}

export function attentionSignature() {
  const { qRows, aRows } = gather();
  return JSON.stringify([qRows.map(r => r.q?.requestId ?? `${r.p.id}:${r.count}`), aRows.map(r => r.task ? `${r.task.id}:${r.task.health.state}` : `${r.p.id}:${r.count}`)]);
}

function row(kind, onOpen, main, sub, side, key) {
  const b = el('button', 'att-row'); b.type = 'button'; b.dataset.key = key; b.dataset.kind = kind;
  const ic = el('span', 'att-ic'); ic.append(icon(kind === 'q' ? 'user' : 'alert', 'sm'));
  const txt = el('span', 'att-txt');
  txt.append(main);
  if (sub) txt.append(sub);
  const end = el('span', 'att-side'); end.append(...side.filter(Boolean), icon('chevronRight', 'sm'));
  b.append(ic, txt, end);
  b.addEventListener('click', onOpen);
  return b;
}
function mainLine(project, title) {
  const m = el('span', 'att-main');
  m.append(el('span', 'att-p', project), el('span', 'att-sep', '·'), el('span', 'att-title', title));
  m.title = `${project} · ${title}`;
  return m;
}

function questionRow({ p, q, count }) {
  const name = p.name || p.id;
  if (!q) return row('q', () => focusQuestions(p.id), mainLine(name, t('att.pendingCount', { count })), el('span', 'att-sub', p.online ? t('att.loadingState') : t('q.offline')), [], 'att:qc:' + p.id);
  const first = q.questions?.[0] || {}, title = first.header || firstLine(first.question) || t('q.badge');
  const sub = el('span', 'att-sub', firstLine(first.question));
  const extra = (q.questions?.length || 0) > 1 ? badge('+' + num(q.questions.length - 1)) : null;
  const left = ms(q.deadlineAt);
  const dl = left != null && left > Date.now() ? countdown(q.deadlineAt) : null;
  const ask = el('span', 'note', ago(q.askedAt)); ask.title = fullTime(q.askedAt);
  const ro = q.answerable === false ? badge(t('q.readOnly'), 'neutral') : null;
  return row('q', () => focusQuestions(p.id), mainLine(name, title), sub, [extra, ro, dl || ask], 'att:q:' + q.requestId);
}

function agentRow({ p, task, count }) {
  const name = p.name || p.id;
  if (!task) return row('a', () => O.navigate({ pid: p.id, tab: 'tasks', target: null }), mainLine(name, t('att.stalledCount', { count })), null, [], 'att:ac:' + p.id);
  const r = task.health.reason;
  const sub = r && O.has('wd.reason.' + r) ? el('span', 'att-sub', t('wd.reason.' + r)) : null;
  if (sub) sub.title = healthLabel(task);
  const since = el('span', 'note', ago(task.health.since)); since.title = fullTime(task.health.since);
  return row('a', () => O.navigate({ pid: p.id, target: { kind: 'task', id: task.id } }), mainLine(name, task.name || task.id), sub, [healthBadge(task), since], 'att:a:' + p.id + ':' + task.id);
}

function recentActions() {
  const r = rangeOf('24h');
  const j = load('ov:wd', '/api/watchdog?' + qs({ from: r.from, to: r.to }));
  const box = el('div', 'att-recent');
  box.append(el('h3', 'att-h', t('att.recent')));
  if (!j.data) {
    box.append(el('p', 'note', j.error ? `${t('ui.loadFailed')}: ${O.errMsg(j.error)}` : t('ui.loadingData')));
    return box;
  }
  const evs = [...(j.data.events || [])].sort((a, b) => (ms(b.at) ?? 0) - (ms(a.at) ?? 0)).slice(0, 8);
  if (!evs.length) { box.append(el('p', 'note', t('att.recentNone'))); return box; }
  const ol = el('ol', 'att-log');
  for (const e of evs) {
    const li = el('li'), open = O.project(e.projectId);
    const what = O.has('wd.kind.' + e.kind) ? t('wd.kind.' + e.kind) : e.kind;
    const label = el(open && e.taskId ? 'a' : 'span', 'att-log-t', e.taskName || e.taskId || '—');
    if (open && e.taskId) label.href = O.hashFor({ pid: e.projectId, target: { kind: 'task', id: e.taskId } });
    const st = e.state && O.has('wd.state.' + e.state) ? healthBadge({ health: { state: e.state, reason: e.reason, since: e.at } }) : null;
    li.append(timeNode(e.at), el('span', 'att-p', e.project || e.projectId || ''), label, el('span', 'att-what', what));
    if (st) li.append(st);
    if (e.detail) li.title = e.detail;
    ol.append(li);
  }
  box.append(ol);
  return box;
}

export function attentionCard() {
  const { qRows, aRows } = gather();
  const total = qRows.reduce((a, r) => a + (r.q ? 1 : r.count), 0);
  const sec = panel(t('att.title'), { id: 'attention', cls: 'att', tags: [questionBadge(total, { small: true })].filter(Boolean) });
  const body = el('div', 'pbody');
  if (!qRows.length && !aRows.length) {
    const e = el('div', 'att-empty'); e.append(icon('check', 'sm'), el('strong', '', t('att.none')), el('span', 'note', t('att.noneText')));
    body.append(e);
  }
  if (qRows.length) {
    const g = el('div', 'att-group'); g.append(el('h3', 'att-h', t('att.questions')));
    const list = el('div', 'att-list'); list.append(...qRows.map(questionRow)); g.append(list); body.append(g);
  }
  if (aRows.length) {
    const g = el('div', 'att-group'); g.append(el('h3', 'att-h', t('att.agents')));
    const list = el('div', 'att-list'); list.append(...aRows.map(agentRow)); g.append(list); body.append(g);
  }
  body.append(recentActions());
  const m = modeLine(O.app.projects); if (m) body.append(m);
  sec.append(body);
  return sec;
}
