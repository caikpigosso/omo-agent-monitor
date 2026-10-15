import { O, t, el, num, compact, ms, f, fin, timeNode, inferred, statusChip, panel, vs, kpi } from './core.js';
import { burnUp, legend } from './charts.js';
import { dataTable, tableToggle } from './table.js';
import { openTask } from './tasks.js';

const ITEM_DONE = new Set(['completed', 'done']);
const ITEM_DROPPED = new Set(['dropped', 'abandoned', 'cancelled']);
const planChip = s => statusChip(s, O.has('plan.st.' + s) ? 'plan.st.' + s : null);
function spent(item) {
  const a = ms(item.startedAt);
  if (a == null) return NaN;
  const b = ms(item.completedAt) ?? ms(item.droppedAt) ?? (item.status === 'in_progress' ? Date.now() : null);
  return b == null ? NaN : b - a;
}

export function planTab(pid, st) {
  const plan = st.plan, goal = st.goal;
  if (!plan && !goal) return [O.stateBox(t('plan.none'), t('plan.noneText'))];
  const out = [];
  const items = (plan?.phases || []).flatMap(p => p.items || []);
  const done = items.filter(i => ITEM_DONE.has(i.status)).length, dropped = items.filter(i => ITEM_DROPPED.has(i.status)).length;
  const active = items.filter(i => i.status === 'in_progress').length;
  if (plan) {
    const box = el('section', 'kpis'); box.setAttribute('aria-label', t('plan.summary'));
    box.append(kpi(t('plan.progress'), `${num(done)} / ${num(items.length - dropped)}`, progress(done, items.length - dropped)),
      kpi(t('plan.active'), num(active), null, { tone: active ? 'info' : null }),
      kpi(t('plan.phases'), num(plan.phases?.length || 0)),
      kpi(t('plan.updated'), plan.updatedAt ? f().dateTime.format(ms(plan.updatedAt)) : '—', null, { small: true }));
    out.push(box);
  }
  const top = el('div', 'grid2');
  if (plan?.ask) { const p = panel(t('plan.ask'), { id: 'plan-ask' }); p.append(el('p', 'ask', plan.ask)); top.append(p); }
  top.append(goalCard(goal));
  out.push(top);
  if (plan?.history?.length) out.push(burnCard(pid, plan));
  for (const [i, ph] of (plan?.phases || []).entries()) out.push(phaseCard(pid, st, ph, i));
  return out;
}

function progress(done, total) {
  const p = el('div', 'prog'); p.setAttribute('role', 'progressbar'); p.setAttribute('aria-valuemin', '0');
  p.setAttribute('aria-valuemax', String(total)); p.setAttribute('aria-valuenow', String(done)); p.setAttribute('aria-label', t('plan.progress'));
  const b = el('span'); b.style.width = total ? Math.round((done / total) * 100) + '%' : '0'; p.append(b);
  p.style.marginTop = '6px';
  return p;
}

function goalCard(goal) {
  const p = panel(t('plan.goal'), { id: 'plan-goal', tags: goal ? [planChip(goal.status)] : [] });
  if (!goal) { p.append(el('p', 'empty', t('plan.noGoal'))); return p; }
  const body = el('div', 'pbody');
  body.append(el('p', 'prose', goal.objective || '—'));
  const kv = el('dl', 'kv');
  const add = (k, v) => { kv.append(el('dt', '', k)); const dd = el('dd'); v instanceof Node ? dd.append(v) : (dd.textContent = v); kv.append(dd); };
  add(t('plan.created'), timeNode(goal.createdAt));
  add(t('plan.updated'), timeNode(goal.updatedAt));
  if (fin(goal.tokensUsed)) add(t('plan.tokensUsed'), `${compact(goal.tokensUsed)} (${num(goal.tokensUsed)})`);
  if (fin(goal.timeUsedSeconds)) add(t('plan.timeUsed'), O.dur(goal.timeUsedSeconds * 1000));
  body.append(kv);
  p.append(body);
  return p;
}

function burnCard(pid, plan) {
  const s = vs('plan:burn:' + pid, { table: false });
  const p = panel(t('plan.burnup'), { id: 'plan-burn', tools: [tableToggle(s, 'plan:burn')] });
  if (s.table) {
    p.append(dataTable({ key: 'plan:burn', caption: t('plan.burnup'), rows: plan.history, columns: [
      { id: 'at', label: t('plan.when'), cell: h => timeNode(h.at) },
      { id: 'done', label: t('plan.done'), num: true, cell: h => num(h.done) },
      { id: 'total', label: t('plan.total'), num: true, cell: h => num(h.total) }] }));
  } else {
    const last = plan.history[plan.history.length - 1];
    p.append(el('div', 'chart-wrap'));
    p.lastChild.append(burnUp({ key: 'plan:burn:' + pid, history: plan.history, label: t('plan.burnAria', { done: num(last.done), total: num(last.total), count: plan.history.length }) }));
    p.append(legend([{ label: t('plan.done'), color: 'var(--success)' }, { label: t('plan.total'), color: 'var(--muted)', line: true }]));
  }
  return p;
}

function phaseCard(pid, st, ph, index) {
  const items = ph.items || [];
  const done = items.filter(i => ITEM_DONE.has(i.status)).length;
  const p = panel(ph.name || t('plan.phaseN', { n: index + 1 }), { id: 'plan-ph-' + index, note: t('plan.phaseDone', { done: num(done), total: num(items.length) }) });
  const list = el('ol', 'items');
  const tasks = Array.isArray(st.tasks) ? st.tasks : [];
  for (const [j, it] of items.entries()) {
    const li = el('li', 'item');
    const title = el('div', 'item-title'); title.append(planChip(it.status), el('span', '', it.content || '—'));
    const sp = spent(it), right = el('span', 'item-spent', fin(sp) ? O.durShort(sp) : '—');
    right.title = t('plan.spent');
    const times = el('div', 'item-times');
    const stamp = (key, iso) => { if (!iso) return; const s = el('span', '', t(key) + ' '); s.append(timeNode(iso)); times.append(s); };
    stamp('plan.firstSeen', it.firstSeenAt); stamp('plan.started', it.startedAt);
    stamp('plan.completed', it.completedAt); stamp('plan.dropped', it.droppedAt);
    li.append(title, right, times);
    const ids = Array.isArray(it.taskIds) ? it.taskIds : [];
    if (ids.length) {
      const chips = el('div', 'chips'); chips.setAttribute('aria-label', t('plan.linked'));
      chips.append(el('span', 'note', t('plan.linked')));
      for (const id of ids) {
        const task = tasks.find(x => x.id === id);
        const b = el('button', 'tchip'); b.type = 'button'; b.dataset.key = `plan:t:${index}:${j}:${id}`;
        const dot = el('span', 'dot'); dot.dataset.tone = O.STATUS_TONE[task?.status] || 'neutral'; dot.style.color = 'var(--tone, var(--faint))';
        b.append(dot, el('span', 't', task?.name || id));
        b.title = task ? `${task.name || id} · ${O.has('status.' + task.status) ? t('status.' + task.status) : task.status}` : id;
        if (task) b.addEventListener('click', () => openTask(pid, id, 'plan')); else b.disabled = true;
        chips.append(b);
      }
      chips.append(inferred('plan.linkTip'));
      li.append(chips);
    }
    list.append(li);
  }
  if (!items.length) p.append(el('p', 'empty', t('plan.noItems'))); else p.append(list);
  return p;
}
