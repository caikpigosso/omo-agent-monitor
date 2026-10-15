import { O, t, el, ms, span, refresh, repaint } from './core.js';
import { EN, PT } from './i18n.js';
import { EN as EN13, PT as PT13 } from './i18n-v13.js';
import { hideTip, drawCharts } from './charts.js';
import { tasksTab } from './tasks.js';
import { planTab } from './plan.js';
import { usageTab, overviewPage } from './usage.js';
import { accountsPage } from './accounts.js';
import { questionsPanel, questionBadge, questionCount, pendingOf, focusQuestions, syncDrafts } from './questions.js';
import { healthBadge, watchdogSection } from './health.js';
import { attentionCard, attentionSignature } from './attention.js';
import { mountNotifyToggle, notifyEvent } from './notify.js';

Object.assign(O.I18N.en, EN, EN13);
Object.assign(O.I18N['pt-BR'], PT, PT13);

// One 1s ticker, alive only while a countdown is on screen and the page is visible.
let ticker = null;
function syncTicker() {
  const live = !document.hidden && document.querySelector('#view [data-countdown]');
  if (live && !ticker) ticker = setInterval(tick, 1000);
  else if (!live && ticker) { clearInterval(ticker); ticker = null; }
}
function tick() {
  const nodes = document.querySelectorAll('#view [data-countdown]');
  if (!nodes.length || document.hidden) { syncTicker(); return; }
  let crossed = false;
  for (const n of nodes) {
    const left = (ms(n.dataset.countdown) ?? NaN) - Date.now();
    if (left <= 0) crossed = true;
    n.textContent = span(left);
  }
  if (crossed) repaint();
}
document.addEventListener('visibilitychange', () => { syncTicker(); if (!document.hidden) tick(); });

function afterRender() {
  drawCharts();
  syncTicker();
  const a = document.activeElement;
  if (a?.matches?.('#view input[type="search"], #view .qcard input[type="text"], #view .qcard textarea')) a.setSelectionRange(a.value.length, a.value.length);
}
function guard(fn) {
  hideTip();
  queueMicrotask(afterRender);
  try { return fn(); }
  catch (error) {
    console.error('[agent-monitor-ui] view failed', error);
    return [O.notice(t('ui.viewError', { reason: error.message }), 'danger')];
  }
}
function safe(fn, fallback) {
  try { return fn(); }
  catch (error) { console.error('[agent-monitor-ui] v1.3 piece failed', error); return fallback; }
}

const prefix = () => {
  const r = O.app.route;
  if (r.page === 'overview') return 'ov:';
  if (r.page === 'accounts') return 'acc:';
  if (r.pid && r.tab === 'usage') return `pu:${r.pid}:`;
  return '\u0000';
};
const SOURCES = {
  usage: k => /^(ov|acc|pu):/.test(k) && k !== 'ov:wd',
  accounts: k => /^(ov|acc):(accounts|qh|ins)/.test(k),
  state: k => /:ins/.test(k),
  watchdog: k => k === 'ov:wd',
};

let attnSig = '';
const sideQ = new Map();
function overviewPageWithAttention() {
  const out = overviewPage();
  attnSig = attentionSignature();
  out.splice(1, 0, attentionCard());
  return out;
}
function repaintOverviewIfChanged() {
  if (O.app.route.page === 'overview' && attentionSignature() !== attnSig) repaint();
}
function onLive(type, data) {
  const pid = data?.projectId;
  if (type === 'state') {
    const st = O.stateOf(pid), n = pendingOf(st).length;
    syncDrafts(pid, st);
    if (sideQ.get(pid) !== n) { sideQ.set(pid, n); O.renderSidebar(); }
    repaintOverviewIfChanged();
    return;
  }
  if (type === 'question') {
    notifyEvent(type, data);
    if (pid && O.project(pid)) O.fetchState(pid);
    return;
  }
  if (type === 'watchdog') {
    const task = O.taskOf(pid, data.taskId);
    if (task && data.health && typeof data.health === 'object') task.health = data.health;
    notifyEvent(type, data);
    if (O.app.route.pid === pid && !O.app.route.page) { repaint(); O.refreshDetail?.(); }
    else repaintOverviewIfChanged();
  }
}

window.OMOUI = {
  page: name => guard(() => name === 'accounts' ? accountsPage() : overviewPageWithAttention()),
  tab: (name, pid, st) => guard(() => name === 'tasks' ? tasksTab(pid, st) : name === 'plan' ? planTab(pid, st) : usageTab(pid, st)),
  projectTop: (pid, st) => { queueMicrotask(afterRender); return safe(() => questionsPanel(pid, st), []); },
  projectMeta: p => safe(() => {
    const out = [], q = questionBadge(questionCount(p, O.stateOf(p.id)), { small: true });
    if (q) out.push(q);
    if (p.counts?.stalled > 0) out.push(O.tag(t('att.stalledCount', { count: p.counts.stalled }), 'warning'));
    return out;
  }, []),
  headBadges: (p, st) => safe(() => {
    const b = questionBadge(questionCount(p, st), { button: true, key: 'qbadge:head', onClick: () => focusQuestions(p.id) });
    return b ? [b] : [];
  }, []),
  coordBadge: st => safe(() => questionBadge(pendingOf(st).length, { small: true }), null),
  healthBadge: (task, short) => safe(() => healthBadge(task, short), null),
  watchdogSection: task => safe(() => watchdogSection(task), []),
  onEvent(type, data) {
    safe(() => onLive(type, data));
    const match = SOURCES[type];
    if (match) refresh(match, prefix());
  },
};
mountNotifyToggle();
document.documentElement.dataset.ui = 'ready';
O.rerender();
