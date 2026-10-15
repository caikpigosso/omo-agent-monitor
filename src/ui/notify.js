import { O, t, el } from './core.js';

const KEY = 'omo-monitor-notify';
const supported = () => typeof window.Notification === 'function';
const permission = () => supported() ? Notification.permission : 'unsupported';
let wanted = false;
try { wanted = localStorage.getItem(KEY) === '1'; } catch {}
const active = () => wanted && permission() === 'granted';

function save(on) {
  wanted = on;
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch {}
  paint();
}
function paint() {
  const b = document.getElementById('notify-toggle');
  if (!b) return;
  const perm = permission(), key = perm === 'unsupported' ? 'ntf.unsupported' : perm === 'denied' ? 'ntf.denied' : active() ? 'ntf.on' : 'ntf.off';
  const s = b.querySelector('span');
  s.dataset.i18n = key; s.textContent = t(key);
  b.setAttribute('aria-checked', String(active()));
  b.disabled = perm === 'unsupported' || perm === 'denied';
}

export function mountNotifyToggle() {
  const foot = document.querySelector('.side-foot');
  if (!foot || document.getElementById('notify-toggle')) return;
  const lab = el('label', '', t('ntf.label')); lab.htmlFor = 'notify-toggle'; lab.dataset.i18n = 'ntf.label';
  const b = el('button', 'switch'); b.type = 'button'; b.id = 'notify-toggle'; b.setAttribute('role', 'switch');
  b.dataset.i18nAria = 'ntf.aria'; b.setAttribute('aria-label', t('ntf.aria'));
  b.append(el('i', 'knob'), el('span'));
  b.addEventListener('click', async () => {
    if (active()) { save(false); return; }
    if (permission() === 'default') {
      try { await Notification.requestPermission(); } catch (error) { console.warn('[agent-monitor-ui] notification permission failed', error); }
    }
    save(permission() === 'granted');
  });
  foot.append(lab, b);
  paint();
}

function show(title, body, tag, route) {
  if (!active() || (!document.hidden && document.hasFocus())) return;
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => { window.focus(); O.navigate(route); n.close(); };
  } catch (error) {
    console.warn('[agent-monitor-ui] notification failed', error);
  }
}

export function notifyEvent(type, m) {
  if (!m?.projectId) return;
  const p = O.project(m.projectId), project = p?.name || m.projectId;
  if (type === 'question' && m.kind === 'asked') {
    show(t('ntf.question', { project }), t('ntf.questionBody'), 'q:' + m.requestId, { pid: m.projectId, target: null });
  } else if (type === 'watchdog' && ['stalled', 'cancelled'].includes(m.health?.state)) {
    const task = O.taskOf(m.projectId, m.taskId)?.name || m.taskId;
    const reason = m.health.reason && O.has('wd.reason.' + m.health.reason) ? t('wd.reason.' + m.health.reason) : '';
    show(t(m.health.state === 'stalled' ? 'ntf.stalled' : 'ntf.cancelled', { project, task }), reason, `wd:${m.taskId}:${m.health.state}`, { pid: m.projectId, target: { kind: 'task', id: m.taskId } });
  }
}
export const repaintNotifyToggle = paint;
