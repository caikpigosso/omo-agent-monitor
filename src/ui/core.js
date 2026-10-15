export const O = window.OMO;
export const t = (key, vars) => O.t(key, vars);
export const { el, icon, chip, num, compact, ms } = O;

let fmtLang = null, F = null;
export function f() {
  const lang = O.lang();
  if (lang === fmtLang) return F;
  const loc = lang === 'pt-BR' ? 'pt-BR' : 'en-US';
  fmtLang = lang;
  F = {
    loc,
    usd: new Intl.NumberFormat(loc, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    usdBig: new Intl.NumberFormat(loc, { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }),
    pct: new Intl.NumberFormat(loc, { style: 'percent', maximumFractionDigits: 0 }),
    pct1: new Intl.NumberFormat(loc, { style: 'percent', maximumFractionDigits: 1 }),
    dec: new Intl.NumberFormat(loc, { maximumFractionDigits: 1 }),
    dateTime: new Intl.DateTimeFormat(loc, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    full: new Intl.DateTimeFormat(loc, { dateStyle: 'medium', timeStyle: 'medium' }),
    hm: new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit' }),
    day: new Intl.DateTimeFormat(loc, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    rel: new Intl.RelativeTimeFormat(loc, { numeric: 'auto', style: 'short' }),
    durf: typeof Intl.DurationFormat === 'function' ? new Intl.DurationFormat(loc, { style: 'narrow' }) : null,
  };
  return F;
}

export const fin = v => Number.isFinite(v);
export const usd = v => !fin(v) ? '—' : v > 0 && v < 0.005 ? '< ' + f().usd.format(0.01) : v >= 100000 ? f().usdBig.format(v) : f().usd.format(v);
export const pct = v => fin(v) ? f().pct.format(v) : '—';
export const pctPoints = v => fin(v) ? f().dec.format(v) + '%' : '—';
export const dateTime = iso => { const x = ms(iso); return x == null ? '—' : f().dateTime.format(x); };
export const fullTime = iso => { const x = ms(iso); return x == null ? '' : f().full.format(x); };

export function timeNode(iso, text) {
  const x = ms(iso);
  const n = el('time', '', text ?? dateTime(iso));
  if (x != null) { n.dateTime = new Date(x).toISOString(); n.title = fullTime(iso); }
  return n;
}

export function span(msAbs) {
  if (!fin(msAbs)) return '—';
  let s = Math.max(0, Math.round(msAbs / 1000));
  const days = Math.floor(s / 86400); s -= days * 86400;
  const hours = Math.floor(s / 3600); s -= hours * 3600;
  const minutes = Math.floor(s / 60); const seconds = s - minutes * 60;
  const parts = days ? { days, hours } : hours ? { hours, minutes } : minutes ? { minutes, seconds } : { seconds };
  const d = f().durf;
  if (d) return d.format(parts);
  return O.dur((days * 86400 + hours * 3600 + minutes * 60 + seconds) * 1000);
}
export function ago(iso) {
  const x = ms(iso);
  if (x == null) return '—';
  const diff = (x - Date.now()) / 1000, a = Math.abs(diff);
  const [v, u] = a < 60 ? [diff, 'second'] : a < 3600 ? [diff / 60, 'minute'] : a < 86400 ? [diff / 3600, 'hour'] : [diff / 86400, 'day'];
  return f().rel.format(Math.round(v), u);
}
// A live countdown; the 1s ticker in app.js refreshes every [data-countdown] while one is on screen.
export function countdown(iso) {
  const n = el('span', 'cd', span((ms(iso) ?? NaN) - Date.now()));
  n.dataset.countdown = iso; n.title = fullTime(iso);
  return n;
}

export function inferred(tipKey = 'ui.inferredTip') {
  const s = el('span', 'inf', t('ui.inferred'));
  s.title = t(tipKey); s.tabIndex = 0; s.setAttribute('aria-label', `${t('ui.inferred')}: ${t(tipKey)}`);
  return s;
}
export function badge(text, tone, title) {
  const b = el('span', 'badge', text);
  if (tone) b.dataset.tone = tone;
  if (title) b.title = title;
  return b;
}
const TONE_ALIASES = { in_progress: 'info', ok: 'success', active: 'success', expired: 'warning', blocked: 'danger', dropped: 'neutral', abandoned: 'neutral' };
export function statusChip(status, labelKey) {
  const known = O.has('status.' + status) || O.STATUS_TONE[status];
  if (!labelKey && known) return chip(status);
  const c = el('span', 'chip'); c.dataset.tone = O.STATUS_TONE[status] || TONE_ALIASES[status] || 'neutral';
  const dot = el('span', 'dot'); if (status === 'in_progress' || status === 'running') dot.dataset.live = '';
  c.append(dot, el('span', '', labelKey && O.has(labelKey) ? t(labelKey) : String(status ?? '—')));
  return c;
}

export function panel(title, opts = {}) {
  const sec = el('section', 'panel' + (opts.cls ? ' ' + opts.cls : ''));
  const head = el('div', 'panel-head'), ht = el('div', 'ph-title'), h = el('h2', '', title);
  h.id = 'h-' + (opts.id || Math.random().toString(36).slice(2));
  sec.setAttribute('aria-labelledby', h.id);
  ht.append(h, ...(opts.tags || []));
  head.append(ht);
  if (opts.note) head.append(el('span', 'panel-note', opts.note));
  if (opts.tools) { const tb = el('div', 'toolbar'); tb.append(...opts.tools.filter(Boolean)); head.append(tb); }
  sec.append(head);
  return sec;
}
export function kpi(label, value, sub, opts = {}) {
  const m = el('div', 'metric'), v = el('p', 'm-value' + (opts.small ? ' sm' : ''), value);
  if (opts.tone) v.dataset.tone = opts.tone;
  if (opts.title) m.title = opts.title;
  const l = el('p', 'm-label', label);
  if (opts.tag) l.append(' ', opts.tag);
  m.append(l, v);
  if (sub) m.append(typeof sub === 'string' ? el('p', 'm-sub', sub) : sub);
  return m;
}
export function seg(label, key, options, current, onPick) {
  const g = el('div', 'seg wrap'); g.setAttribute('role', 'group'); g.setAttribute('aria-label', label);
  for (const [value, text] of options) {
    const b = el('button', '', text); b.type = 'button'; b.dataset.key = `${key}:${value}`;
    b.setAttribute('aria-pressed', String(value === current));
    b.addEventListener('click', () => { if (value !== current) onPick(value); });
    g.append(b);
  }
  return g;
}
export function select(label, key, options, current, onPick) {
  const s = el('select', 'field'); s.dataset.key = key; s.setAttribute('aria-label', label);
  for (const [value, text] of options) { const o = el('option', '', text); o.value = value; o.selected = value === current; s.append(o); }
  s.addEventListener('change', () => onPick(s.value));
  return s;
}
export function linkBtn(text, key, onClick) {
  const b = el('button', 'linkish', text); b.type = 'button'; b.dataset.key = key;
  b.addEventListener('click', onClick);
  return b;
}

export const repaint = () => O.renderMain();
export const viewState = new Map();
export function vs(key, init) {
  if (!viewState.has(key)) viewState.set(key, typeof init === 'function' ? init() : { ...init });
  return viewState.get(key);
}

/* Fetch cache: one entry per logical key. A new URL aborts the stale request; a refresh while
   loading is coalesced into one follow-up request (no timers, no polling). */
const jobs = new Map();
export function load(key, url) {
  let j = jobs.get(key);
  if (j && j.url === url) return j;
  j?.ctrl?.abort();
  j = { key, url, data: j?.data ?? null, error: null, loading: false, dirty: false, ctrl: null };
  j.stale = j.data != null;
  jobs.set(key, j);
  run(j);
  return j;
}
async function run(j) {
  const ctrl = j.ctrl = new AbortController();
  j.loading = true; j.dirty = false;
  try {
    const res = await fetch(j.url, { signal: ctrl.signal, cache: 'no-store' });
    let data = {}; try { data = await res.json(); } catch {}
    if (!res.ok || data.error) throw O.apiError(data, ['err.http', { status: res.status }]);
    if (jobs.get(j.key) !== j) return;
    j.data = data; j.error = null; j.stale = false;
  } catch (error) {
    if (error.name === 'AbortError' || jobs.get(j.key) !== j) return;
    j.error = error;
  } finally {
    if (j.ctrl === ctrl) { j.loading = false; j.ctrl = null; }
  }
  if (jobs.get(j.key) !== j) return;
  if (j.dirty) run(j); else repaint();
}
export function refresh(match, visiblePrefix) {
  for (const j of [...jobs.values()]) {
    if (!match(j.key)) continue;
    if (!j.key.startsWith(visiblePrefix)) { j.ctrl?.abort(); jobs.delete(j.key); continue; }
    if (j.loading) j.dirty = true; else run(j);
  }
}
export function loadState(j, retryLabel) {
  if (j.data) return null;
  if (j.error) return O.stateBox(t('ui.loadFailed'), O.errMsg(j.error), { tone: 'danger', small: true, retry: () => { jobs.delete(j.key); repaint(); } });
  return O.stateBox(retryLabel || t('ui.loadingData'), '', { small: true });
}

export const DAY = 864e5, HOUR = 36e5;
export function rangeOf(range) {
  const to = Date.now(), span = range === '24h' ? DAY : range === '7d' ? 7 * DAY : 30 * DAY;
  // Snap "from" to the bucket start so the first bucket is complete and URLs stay stable for a minute.
  const step = range === '24h' ? HOUR : DAY;
  const from = Math.floor((to - span) / step) * step + step;
  const toMin = Math.ceil(to / 60000) * 60000;
  return { from: new Date(from).toISOString(), to: new Date(toMin).toISOString(), bucket: range === '24h' ? 'hour' : 'day', step };
}
export const qs = obj => new URLSearchParams(Object.entries(obj).filter(([, v]) => v != null)).toString();

const PROVIDERS = { 'anthropic-subscription': 'Anthropic', 'chatgpt-subscription': 'ChatGPT', anthropic: 'Anthropic', openai: 'OpenAI' };
export const providerName = p => PROVIDERS[p] || p || '—';
// Usage account keys are "<provider>:<account>"; "unknown" means no quota sample existed yet.
export function accountLabel(key) {
  const i = String(key).indexOf(':');
  if (i < 0) return String(key);
  const prov = key.slice(0, i), acc = key.slice(i + 1);
  return `${providerName(prov)} · ${acc === 'unknown' ? t('acc.unattributed') : acc}`;
}
export function seriesLabel(groupBy, s) {
  if (groupBy === 'account') return accountLabel(s.key);
  if (groupBy === 'provider') return providerName(s.key);
  if (groupBy === 'agent' && s.key === 'coordinator') return t('common.coordinator');
  return s.label || s.key;
}
export const costTitle = () => t('ui.costTip');
