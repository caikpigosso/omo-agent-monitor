import { O, t, el, icon, num, badge, countdown, ago, fullTime, ms, panel, repaint } from './core.js';

const drafts = new Map();
const resolved = new Map();
let focusPid = null;

export const pendingOf = st => (Array.isArray(st?.questions) ? st.questions : []).filter(q => q && q.requestId);
export function questionCount(p, st) {
  const live = st ? pendingOf(st).length : null;
  return live ?? (Number.isFinite(p?.counts?.questions) ? p.counts.questions : 0);
}

export function questionBadge(count, opts = {}) {
  if (!count) return null;
  const label = t('q.badgeAria', { count });
  const b = el(opts.button ? 'button' : 'span', 'qbadge' + (opts.small ? ' sm' : ''));
  b.dataset.tone = 'warning';
  if (opts.button) { b.type = 'button'; b.dataset.key = opts.key || 'qbadge'; }
  b.title = label; b.setAttribute('aria-label', label);
  const dot = el('span', 'dot'); dot.dataset.live = '';
  b.append(dot, el('span', 'qb-t', t('q.badge')), el('span', 'qb-n', num(count)));
  if (opts.onClick) b.addEventListener('click', opts.onClick);
  return b;
}

export function focusQuestions(pid) {
  focusPid = pid;
  if (O.app.route.pid !== pid || O.app.route.page) O.navigate({ pid, tab: O.app.route.pid === pid ? O.app.route.tab : 'flow', target: O.app.route.pid === pid ? O.app.route.target : null });
  else repaint();
}

function draftOf(id) {
  if (!drafts.has(id)) drafts.set(id, { sel: {}, other: {}, comment: '', busy: null, confirm: false, note: null });
  return drafts.get(id);
}
const hasContent = d => d.comment.trim() || Object.values(d.sel).some(v => v.length) || Object.values(d.other).some(v => v.trim());

// Drafts whose question disappeared without our own submit were closed elsewhere (terminal, timeout).
export function syncDrafts(pid, st) {
  const live = new Set(pendingOf(st).map(q => q.requestId));
  for (const [id, d] of drafts) {
    if (d.pid !== pid || live.has(id)) continue;
    drafts.delete(id);
    if (!d.busy && hasContent(d)) addResolved(pid, { key: 'q.closedElsewhere', tone: 'info' });
  }
}
function addResolved(pid, note) {
  const list = resolved.get(pid) || [];
  list.push({ id: Math.random().toString(36).slice(2), ...note });
  resolved.set(pid, list.slice(-3));
}

export function questionsPanel(pid, st) {
  const qs = pendingOf(st), notes = resolved.get(pid) || [];
  if (!qs.length && !notes.length) return [];
  const sec = panel(t('q.panel'), { id: 'questions-' + pid, cls: 'qpanel',
    tags: qs.length ? [badge(num(qs.length), 'warning', t('q.badgeAria', { count: qs.length }))] : [],
    note: qs.length ? t('q.panelNote', { count: qs.reduce((a, q) => a + (q.questions?.length || 0), 0) }) : null });
  sec.dataset.key = 'qpanel';
  sec.id = 'qpanel-' + pid;
  for (const n of notes) {
    const row = O.notice(t(n.key), n.tone); row.classList.add('qnote');
    if (n.tone === 'success') row.querySelector('svg')?.replaceWith(icon('check'));
    const x = el('button', 'icon-btn'); x.type = 'button'; x.dataset.key = 'qnote:' + n.id;
    x.setAttribute('aria-label', t('q.close')); x.append(icon('x', 'sm'));
    x.addEventListener('click', () => { resolved.set(pid, (resolved.get(pid) || []).filter(m => m.id !== n.id)); repaint(); });
    row.append(x); sec.append(row);
  }
  for (const q of qs) sec.append(questionCard(pid, q));
  if (focusPid === pid) {
    focusPid = null;
    queueMicrotask(() => {
      const h = document.getElementById(sec.getAttribute('aria-labelledby'));
      sec.scrollIntoView({ block: 'start', behavior: 'auto' });
      if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
    });
  }
  return [sec];
}

function questionCard(pid, q) {
  const d = draftOf(q.requestId); d.pid = pid;
  const p = O.project(pid), id = q.requestId;
  const canSend = q.answerable !== false && p?.online && O.streamLive() && !!O.app.projects?.controlToken;
  const form = el('form', 'qcard'); form.noValidate = true; form.dataset.key = 'qform:' + id;
  const meta = el('div', 'q-meta');
  const asked = el('span', 'note', t('q.asked', { when: ago(q.askedAt) })); asked.title = fullTime(q.askedAt);
  meta.append(asked);
  if (q.blocking) meta.append(badge(t('q.blocking'), 'warning', t('q.blockingTip')));
  if (q.deadlineAt) {
    const left = (ms(q.deadlineAt) ?? 0) - Date.now(), dl = el('span', 'q-dl');
    if (left > 0) dl.append(icon('clock', 'sm'), el('span', '', t('q.deadline') + ' '), countdown(q.deadlineAt));
    else { dl.dataset.tone = 'danger'; dl.append(icon('clock', 'sm'), el('span', '', t('q.expired'))); }
    meta.append(dl);
  }
  form.append(meta);
  if (q.answerable === false) {
    const ro = el('div', 'q-ro'); ro.append(icon('terminal', 'sm'), el('strong', '', t('q.readOnly')), el('span', '', t('q.readOnlyText')));
    form.append(ro);
  }
  const disabled = q.answerable === false || !!d.busy;
  (q.questions || []).forEach((item, i) => form.append(questionField(id, item, i, d, disabled)));
  if (q.answerable === false) return form;
  const cid = `qc-${domId(id)}`;
  const cl = el('label', 'q-label', t('q.comment')); cl.htmlFor = cid;
  const ta = el('textarea', 'field'); ta.id = cid; ta.rows = 2; ta.value = d.comment; ta.placeholder = t('q.commentPh');
  ta.dataset.key = 'qc:' + id; ta.disabled = disabled; ta.maxLength = 32000;
  ta.addEventListener('input', () => { d.comment = ta.value; clearNote(d, form); });
  form.append(cl, ta);
  if (d.confirm) {
    const c = el('div', 'confirm');
    const no = btn(t('q.keep'), 'btn', 'qno:' + id, () => { d.confirm = false; repaint(); queueMicrotask(() => focusKey('qdis:' + id)); });
    const yes = btn(t('q.dismissYes'), 'btn danger-solid', 'qyes:' + id, () => send(pid, q, true));
    c.append(el('p', '', t('q.dismissAsk')), no, yes);
    form.append(c);
    queueMicrotask(() => { if (!document.activeElement?.closest?.('.confirm')) no.focus({ preventScroll: true }); });
  }
  const row = el('div', 'q-actions');
  const hint = el('span', 'c-hint', !p?.online ? t('q.offline') : !O.streamLive() ? t('q.needLive') : '');
  const dis = btn(d.busy === 'cancel' ? t('q.dismissing') : t('q.dismiss'), 'btn danger', 'qdis:' + id, () => { d.confirm = true; repaint(); });
  const sub = el('button', 'btn primary', d.busy === 'answer' ? t('q.submitting') : t('q.submit')); sub.type = 'submit'; sub.dataset.key = 'qsub:' + id;
  dis.disabled = sub.disabled = !canSend || !!d.busy || d.confirm;
  const acts = el('div', 'c-actions'); acts.append(dis, sub);
  row.append(hint, acts);
  form.append(row);
  const note = el('p', 'c-note'); note.setAttribute('role', 'status'); note.dataset.qnote = '';
  if (d.busy) note.textContent = t('q.waiting');
  else if (d.note) { note.textContent = d.note.text(); note.dataset.tone = d.note.tone; }
  form.append(note);
  form.addEventListener('submit', e => { e.preventDefault(); send(pid, q, false); });
  return form;
}

function questionField(rid, item, i, d, disabled) {
  const qid = item.id ?? String(i), fs = el('fieldset', 'qfield'), multi = !!item.multiSelect;
  const name = `q-${domId(rid)}-${domId(qid)}`;
  const lg = el('legend', 'q-legend');
  if (item.header) lg.append(el('span', 'q-head', item.header));
  lg.append(el('span', 'q-text', item.question || ''));
  fs.append(lg, el('p', 'note', multi ? t('q.multi') : t('q.single')));
  const sel = d.sel[qid] || (d.sel[qid] = []);
  const opts = el('div', 'q-opts');
  const otherIn = el('input', 'field');
  (item.options || []).forEach((o, k) => {
    const lab = el('label', 'q-opt'), inp = el('input');
    inp.type = multi ? 'checkbox' : 'radio'; inp.name = name; inp.value = o.label; inp.disabled = disabled;
    inp.checked = sel.includes(o.label); inp.dataset.key = `qo:${rid}:${qid}:${k}`;
    inp.addEventListener('change', () => {
      if (multi) d.sel[qid] = [...opts.querySelectorAll('input:checked')].map(x => x.value);
      else { d.sel[qid] = [o.label]; d.other[qid] = ''; otherIn.value = ''; }
      clearNote(d, fs.form);
    });
    const txt = el('span', 'q-opt-t'); txt.append(el('span', 'q-opt-l', o.label));
    if (o.description) txt.append(el('span', 'q-opt-d', o.description));
    lab.append(inp, txt); opts.append(lab);
  });
  fs.append(opts);
  if (disabled && !d.busy) return fs;
  const oid = name + '-other';
  const ol = el('label', 'q-label', t('q.other')); ol.htmlFor = oid;
  otherIn.id = oid; otherIn.type = 'text'; otherIn.value = d.other[qid] || ''; otherIn.placeholder = t('q.otherPh');
  otherIn.disabled = disabled; otherIn.dataset.key = `qt:${rid}:${qid}`; otherIn.autocomplete = 'off';
  otherIn.addEventListener('input', () => {
    d.other[qid] = otherIn.value;
    if (!multi && otherIn.value.trim()) { d.sel[qid] = []; for (const r of opts.querySelectorAll('input')) r.checked = false; }
    clearNote(d, fs.form);
  });
  fs.append(ol, otherIn);
  return fs;
}

function clearNote(d, form) {
  if (!d.note) return;
  d.note = null;
  const n = form?.querySelector('[data-qnote]'); if (n) { n.textContent = ''; delete n.dataset.tone; }
}

async function send(pid, q, cancelled) {
  const d = draftOf(q.requestId);
  if (d.busy || !O.app.projects?.controlToken) return;
  let body;
  if (cancelled) body = { cancelled: true };
  else {
    const answers = {}, items = q.questions || [];
    let answered = 0;
    items.forEach((item, i) => {
      const qid = item.id ?? String(i), selected = d.sel[qid] || [], text = (d.other[qid] || '').trim();
      if (!selected.length && !text) return;
      answered++;
      answers[qid] = text ? { selected, text } : { selected };
    });
    const comment = d.comment.trim();
    if (answered < items.length && (answered || !comment)) {
      d.note = { text: () => t('q.needAll'), tone: 'danger' }; repaint(); return;
    }
    body = comment ? { answers, comment } : { answers };
  }
  d.busy = cancelled ? 'cancel' : 'answer'; d.confirm = false; d.note = null; repaint();
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(pid)}/questions/${encodeURIComponent(q.requestId)}/answer`, {
      method: 'POST', cache: 'no-store',
      headers: { 'X-OmO-Control': O.app.projects.controlToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = {}; try { data = await res.json(); } catch {}
    if (!res.ok || data.ok !== true) throw O.apiError(data, ['err.refused', { status: res.status }]);
    drafts.delete(q.requestId);
    const key = O.has('q.outcome.' + data.outcome) ? 'q.outcome.' + data.outcome : 'q.outcome.default';
    addResolved(pid, { key, tone: 'success' });
    O.fetchState?.(pid);
  } catch (error) {
    d.busy = null;
    d.note = { text: () => t('q.failed', { reason: O.errMsg(error) }), tone: 'danger' };
    if (['question_already_resolved', 'question_unknown'].includes(error.code)) O.fetchState?.(pid);
  } finally {
    if (drafts.get(q.requestId) === d) d.busy = null;
    repaint();
  }
}

const domId = s => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
function btn(text, cls, key, onClick) {
  const b = el('button', cls, text); b.type = 'button'; b.dataset.key = key; b.addEventListener('click', onClick);
  return b;
}
const focusKey = key => document.querySelector(`#view [data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
