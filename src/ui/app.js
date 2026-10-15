import { O, t, el, ms, span, refresh, repaint } from './core.js';
import { EN, PT } from './i18n.js';
import { hideTip, drawCharts } from './charts.js';
import { tasksTab } from './tasks.js';
import { planTab } from './plan.js';
import { usageTab, overviewPage } from './usage.js';
import { accountsPage } from './accounts.js';

Object.assign(O.I18N.en, EN);
Object.assign(O.I18N['pt-BR'], PT);

let ticker = null;
function syncTicker() {
  const live = document.querySelector('#view [data-countdown]');
  if (live && !ticker) ticker = setInterval(tick, 1000);
  else if (!live && ticker) { clearInterval(ticker); ticker = null; }
}
function tick() {
  const nodes = document.querySelectorAll('#view [data-countdown]');
  if (!nodes.length) { syncTicker(); return; }
  let crossed = false;
  for (const n of nodes) {
    const left = (ms(n.dataset.countdown) ?? NaN) - Date.now();
    if (left <= 0) crossed = true;
    n.textContent = span(left);
  }
  if (crossed) repaint();
}

function afterRender() {
  drawCharts();
  syncTicker();
  const a = document.activeElement;
  if (a?.matches?.('#view input[type="search"]')) a.setSelectionRange(a.value.length, a.value.length);
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

const prefix = () => {
  const r = O.app.route;
  if (r.page === 'overview') return 'ov:';
  if (r.page === 'accounts') return 'acc:';
  if (r.pid && r.tab === 'usage') return `pu:${r.pid}:`;
  return '\u0000';
};
const SOURCES = {
  usage: k => /^(ov|acc|pu):/.test(k),
  accounts: k => /^(ov|acc):(accounts|qh|ins)/.test(k),
  state: k => /:ins/.test(k),
};

window.OMOUI = {
  page: name => guard(() => name === 'accounts' ? accountsPage() : overviewPage()),
  tab: (name, pid, st) => guard(() => name === 'tasks' ? tasksTab(pid, st) : name === 'plan' ? planTab(pid, st) : usageTab(pid, st)),
  onEvent(type, data) {
    const match = SOURCES[type];
    if (!match) return;
    refresh(match, prefix());
  },
};
document.documentElement.dataset.ui = 'ready';
O.rerender();
