import { O, t, el, icon, num, badge, timeNode, fullTime, ms } from './core.js';

const TONE = { stalled: 'warning', steered: 'info', cancelled: 'danger', recovered: 'success' };
export const FLAGGED = new Set(['stalled', 'steered', 'cancelled']);
export const healthState = task => task?.health?.state && task.health.state !== 'ok' ? task.health.state : null;

export function healthLabel(task) {
  const h = task?.health, state = healthState(task);
  if (!state) return '';
  const name = t('wd.state.' + state), since = h.since ? fullTime(h.since) : '—';
  return h.reason && O.has('wd.reason.' + h.reason)
    ? t('wd.tip', { state: name, reason: t('wd.reason.' + h.reason), since })
    : t('wd.tipBare', { state: name, since });
}

export function healthBadge(task, short = false) {
  const state = healthState(task);
  if (!state || !O.has('wd.state.' + state)) return null;
  const label = healthLabel(task);
  const b = badge('', TONE[state] || 'neutral', label);
  b.classList.add('hbadge');
  b.append(el('span', 'hb-t', t((short ? 'wd.short.' : 'wd.state.') + state)));
  b.prepend(icon(state === 'recovered' ? 'check' : 'alert', 'xs'));
  b.setAttribute('aria-label', label);
  return b;
}

export function modeLine(snap) {
  const w = snap?.watchdog;
  if (!w || typeof w.mode !== 'string') return null;
  const box = el('div', 'wd-mode');
  const mode = O.has('wd.mode.' + w.mode) ? t('wd.mode.' + w.mode) : w.mode;
  const head = el('p', 'wd-mode-h'); head.append(icon('clock', 'sm'), el('strong', '', t('wd.mode', { mode })));
  box.append(head);
  if (O.has('wd.explain.' + w.mode)) {
    const dec = O.fmt().dec;
    box.append(el('p', 'note', t('wd.explain.' + w.mode, { errors: num(w.stallErrors), minutes: dec.format(w.stallMinutes), grace: dec.format(w.graceMinutes) })));
  }
  box.append(el('p', 'note', t('wd.howToSet')));
  return box;
}

export function watchdogSection(task) {
  const h = task?.health;
  if (!h || (h.state === 'ok' && !(h.actions || []).length)) return [];
  const sec = el('section', 'wd-sec'); sec.setAttribute('aria-label', t('wd.title'));
  const head = el('div', 'wd-head'); head.append(el('h3', '', t('wd.title')));
  const b = healthBadge(task); if (b) head.append(b);
  sec.append(head);
  const kv = el('dl', 'kv');
  const row = (k, v) => { if (v == null || v === '') return; kv.append(el('dt', '', k)); const dd = el('dd'); dd.append(v); kv.append(dd); };
  if (h.reason) row(t('wd.reason'), O.has('wd.reason.' + h.reason) ? t('wd.reason.' + h.reason) : h.reason);
  if (h.since) row(t('wd.since'), timeNode(h.since));
  if (Number.isFinite(h.consecutiveErrors) && h.consecutiveErrors > 0) row(t('wd.errors'), num(h.consecutiveErrors));
  if (h.waitingOnModelSince) row(t('wd.waitingSince'), timeNode(h.waitingOnModelSince));
  if (h.lastProgressAt) row(t('wd.lastProgress'), timeNode(h.lastProgressAt));
  if (h.lastWriteAt) row(t('wd.lastWrite'), timeNode(h.lastWriteAt));
  if (kv.childElementCount) sec.append(kv);
  const acts = [...(h.actions || [])].sort((a, b) => (ms(a.at) ?? 0) - (ms(b.at) ?? 0));
  sec.append(el('h4', 'wd-sub', t('wd.actions')));
  if (!acts.length) sec.append(el('p', 'note', t('wd.noActions')));
  else {
    const ol = el('ol', 'wd-acts');
    for (const a of acts) {
      const li = el('li', 'wd-act'); li.dataset.kind = a.kind;
      const top = el('div', 'wd-act-top');
      top.append(el('span', 'wd-dot'), timeNode(a.at), el('span', 'wd-act-k', O.has('wd.kind.' + a.kind) ? t('wd.kind.' + a.kind) : a.kind));
      li.append(top);
      if (a.detail) li.append(el('p', 'wd-act-d', a.detail));
      ol.append(li);
    }
    sec.append(ol);
  }
  const m = modeLine(O.app.projects); if (m) sec.append(m);
  return [sec];
}
