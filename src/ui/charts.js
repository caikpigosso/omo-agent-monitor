import { el, t, f, fin } from './core.js';

const NS = 'http://www.w3.org/2000/svg';
export const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c8)', 'var(--c7)'];
export const OTHER = 'var(--c-other)';

function s(tag, attrs = {}, style) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (style) n.setAttribute('style', style);
  return n;
}
function text(x, y, str, anchor = 'start') {
  const n = s('text', { x, y, 'text-anchor': anchor }); n.textContent = str; return n;
}
export function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(v => v >= raw) || raw;
  const out = []; for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

/* Charts are drawn at the host's real width by drawCharts(), which app.js runs in a microtask after each
   render (hosts are in the DOM, nothing painted yet) and on window resize. A second pass absorbs a
   scrollbar appearing after the first draw. When the minimum width exceeds the card, the host scrolls;
   scroll offsets survive re-renders (default: scrolled to the latest data). */
const scrollMem = new Map();
let hosts = [];
function host(key, minW, draw, label) {
  const h = el('div', 'x-scroll chart'); h.dataset.key = key;
  h.setAttribute('role', 'img'); h.setAttribute('aria-label', label);
  h.addEventListener('scroll', () => scrollMem.set(key, h.scrollLeft), { passive: true });
  hosts.push({ h, key, minW, draw, last: 0 });
  return h;
}
export function drawCharts() {
  hosts = hosts.filter(x => x.h.isConnected);
  for (let pass = 0; pass < 2; pass++) for (const x of hosts) {
    const cs = getComputedStyle(x.h);
    const w = Math.max(Math.floor(x.h.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)), x.minW);
    if (Math.abs(w - x.last) < 1) continue;
    x.last = w; x.h.replaceChildren(x.draw(w));
    x.h.scrollLeft = scrollMem.get(x.key) ?? x.h.scrollWidth;
  }
}
addEventListener('resize', drawCharts);

let tipNode = null;
function tip(evt, title, rows) {
  if (!tipNode) { tipNode = el('div', 'tip'); tipNode.setAttribute('aria-hidden', 'true'); document.body.append(tipNode); }
  if (!title) { tipNode.hidden = true; return; }
  tipNode.hidden = false;
  tipNode.replaceChildren(el('strong', '', title), ...rows.map(([k, v, c]) => {
    const r = el('div', 'row'), l = el('span', '');
    if (c) { const sw = el('span', 'sw'); sw.style.color = c; sw.style.display = 'inline-block'; sw.style.marginRight = '6px'; l.append(sw); }
    l.append(k); r.append(l, el('span', '', v)); return r;
  }));
  const pad = 14, w = tipNode.offsetWidth, h = tipNode.offsetHeight;
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + w > innerWidth - 8) x = evt.clientX - w - pad;
  if (y + h > innerHeight - 8) y = evt.clientY - h - pad;
  tipNode.style.left = Math.max(8, x) + 'px'; tipNode.style.top = Math.max(8, y) + 'px';
}
export const hideTip = () => tip(null);

function xLabels(n, width) {
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(width / 84))));
  return i => i % every === 0;
}

/* Stacked bars per time bucket. series: [{label, color, values[]}] aligned with buckets[] (ms). */
export function stackedBars({ key, buckets, series, fmtV, fmtX, fmtTip, label, height = 220, minBar = 12 }) {
  const n = buckets.length, M = { l: 52, r: 12, t: 12, b: 26 };
  const totals = buckets.map((_, i) => series.reduce((a, sr) => a + (sr.values[i] || 0), 0));
  const ticks = niceTicks(Math.max(...totals, 0));
  const top = ticks[ticks.length - 1] || 1;
  return host(key, M.l + M.r + n * minBar, w => {
    const svg = s('svg', { width: w, height, viewBox: `0 0 ${w} ${height}` });
    const iw = w - M.l - M.r, ih = height - M.t - M.b, bw = iw / Math.max(n, 1);
    const y = v => M.t + ih - (v / top) * ih;
    for (const v of ticks) { svg.append(s('line', { class: 'gl', x1: M.l, x2: w - M.r, y1: y(v), y2: y(v) }), text(M.l - 6, y(v) + 4, fmtV(v), 'end')); }
    const show = xLabels(n, iw);
    buckets.forEach((b, i) => {
      let acc = 0; const x = M.l + i * bw + bw * 0.14, ww = Math.max(1, bw * 0.72);
      for (const sr of series) {
        const v = sr.values[i] || 0; if (!v) continue;
        const y0 = y(acc), y1 = y(acc + v); acc += v;
        svg.append(s('rect', { class: 'bar', x, y: y1, width: ww, height: Math.max(0.5, y0 - y1), rx: 1.5 }, `fill:${sr.color}`));
      }
      if (show(i)) svg.append(text(M.l + i * bw + bw / 2, height - 8, fmtX(b), 'middle'));
      const hit = s('rect', { x: M.l + i * bw, y: M.t, width: bw, height: ih, fill: 'transparent' });
      hit.addEventListener('pointermove', e => tip(e, fmtTip ? fmtTip(b) : fmtX(b), [
        ...series.filter(sr => sr.values[i]).map(sr => [sr.label, fmtV(sr.values[i]), sr.color]),
        ...(series.length > 1 ? [[t('ui.total'), fmtV(totals[i])]] : [])]));
      hit.addEventListener('pointerleave', hideTip);
      svg.append(hit);
    });
    svg.append(s('line', { class: 'axis', x1: M.l, x2: w - M.r, y1: M.t + ih, y2: M.t + ih }));
    return svg;
  }, label);
}

/* Percent lines (0-100, left axis) over usage bars (right axis) on one time axis [from, to]. */
export function quotaChart({ key, from, to, lines, bars, fmtBar, label, height = 230 }) {
  const M = { l: 40, r: 52, t: 12, b: 26 }, span = Math.max(1, to - from);
  const barTicks = niceTicks(Math.max(0, ...bars.values));
  const btop = barTicks[barTicks.length - 1] || 1;
  return host(key, 520, w => {
    const svg = s('svg', { width: w, height, viewBox: `0 0 ${w} ${height}` });
    const iw = w - M.l - M.r, ih = height - M.t - M.b;
    const x = tms => M.l + ((tms - from) / span) * iw, y = p => M.t + ih - (Math.min(100, Math.max(0, p)) / 100) * ih;
    for (const p of [0, 25, 50, 75, 100]) svg.append(s('line', { class: 'gl', x1: M.l, x2: w - M.r, y1: y(p), y2: y(p) }), text(M.l - 6, y(p) + 4, p + '%', 'end'));
    barTicks.forEach(v => svg.append(text(w - M.r + 6, M.t + ih - (v / btop) * ih + 4, fmtBar(v))));
    const bw = (bars.step / span) * iw;
    bars.buckets.forEach((b, i) => {
      const v = bars.values[i]; if (!v) return;
      const h = (v / btop) * ih;
      const r = s('rect', { class: 'bar', x: x(b) + bw * 0.12, y: M.t + ih - h, width: Math.max(1, bw * 0.76), height: h, rx: 1.5 }, `fill:${bars.color};opacity:.55`);
      r.addEventListener('pointermove', e => tip(e, f().dateTime.format(b), [[bars.label, fmtBar(v), bars.color]]));
      r.addEventListener('pointerleave', hideTip);
      svg.append(r);
    });
    for (const ln of lines) {
      const pts = ln.points.filter(p => p.t >= from && p.t <= to);
      if (!pts.length) continue;
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
      svg.append(s('path', { class: 'ln', d }, `stroke:${ln.color}`));
      for (const p of pts) {
        const c = s('circle', { cx: x(p.t), cy: y(p.v), r: pts.length > 40 ? 1.5 : 3 }, `fill:${ln.color}`);
        svg.append(c);
      }
      const hit = s('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': 14 });
      hit.addEventListener('pointermove', e => {
        const tx = from + ((e.offsetX - M.l) / iw) * span;
        const near = pts.reduce((a, p) => Math.abs(p.t - tx) < Math.abs(a.t - tx) ? p : a, pts[0]);
        tip(e, f().dateTime.format(near.t), [[ln.label, near.v + '%', ln.color]]);
      });
      hit.addEventListener('pointerleave', hideTip);
      svg.append(hit);
    }
    const nowX = x(Date.now());
    if (nowX > M.l && nowX <= w - M.r + 1) svg.append(s('line', { x1: nowX, x2: nowX, y1: M.t, y2: M.t + ih, 'stroke-dasharray': '3 3' }, 'stroke:var(--info)'));
    const nt = Math.max(2, Math.floor(iw / 110));
    for (let i = 0; i <= nt; i++) {
      const tv = from + (span * i) / nt;
      svg.append(text(x(tv), height - 8, span > 2 * 864e5 ? f().dateTime.format(tv) : f().hm.format(tv), i === 0 ? 'start' : i === nt ? 'end' : 'middle'));
    }
    svg.append(s('line', { class: 'axis', x1: M.l, x2: w - M.r, y1: M.t + ih, y2: M.t + ih }));
    return svg;
  }, label);
}

export function burnUp({ key, history, label, height = 200 }) {
  const pts = history.map(h => ({ t: Date.parse(h.at), done: h.done, total: h.total })).filter(p => fin(p.t)).sort((a, b) => a.t - b.t);
  const M = { l: 36, r: 12, t: 12, b: 26 };
  const from = pts[0]?.t ?? Date.now(), to = Math.max(Date.now(), pts[pts.length - 1]?.t ?? 0), span = Math.max(1, to - from);
  const ticks = niceTicks(Math.max(1, ...pts.map(p => p.total)), 4).filter(v => Number.isInteger(v));
  const top = ticks[ticks.length - 1] || 1;
  return host(key, 360, w => {
    const svg = s('svg', { width: w, height, viewBox: `0 0 ${w} ${height}` });
    const iw = w - M.l - M.r, ih = height - M.t - M.b;
    const x = v => M.l + ((v - from) / span) * iw, y = v => M.t + ih - (v / top) * ih;
    for (const v of ticks) svg.append(s('line', { class: 'gl', x1: M.l, x2: w - M.r, y1: y(v), y2: y(v) }), text(M.l - 6, y(v) + 4, String(v), 'end'));
    const step = k => pts.map((p, i) => `${i ? `H${x(p.t).toFixed(1)}V` : `M${x(p.t).toFixed(1)},`}${y(p[k]).toFixed(1)}`).join('') + `H${x(to).toFixed(1)}`;
    if (pts.length) {
      svg.append(s('path', { d: `${step('done')}V${y(0)}H${x(from)}Z` }, 'fill:var(--success);opacity:.16'));
      svg.append(s('path', { class: 'ln', d: step('done') }, 'stroke:var(--success)'));
      svg.append(s('path', { class: 'ln dash', d: step('total') }, 'stroke:var(--muted)'));
    }
    const nt = Math.max(2, Math.floor(iw / 110));
    for (let i = 0; i <= nt; i++) {
      const tv = from + (span * i) / nt;
      svg.append(text(x(tv), height - 8, span > 864e5 ? f().dateTime.format(tv) : f().hm.format(tv), i === 0 ? 'start' : i === nt ? 'end' : 'middle'));
    }
    const hit = s('rect', { x: M.l, y: M.t, width: iw, height: ih, fill: 'transparent' });
    hit.addEventListener('pointermove', e => {
      const tx = from + ((e.offsetX - M.l) / iw) * span;
      const p = [...pts].reverse().find(q => q.t <= tx) || pts[0];
      if (p) tip(e, f().dateTime.format(p.t), [[t('plan.done'), String(p.done), 'var(--success)'], [t('plan.total'), String(p.total), 'var(--muted)']]);
    });
    hit.addEventListener('pointerleave', hideTip);
    svg.append(hit, s('line', { class: 'axis', x1: M.l, x2: w - M.r, y1: M.t + ih, y2: M.t + ih }));
    return svg;
  }, label);
}

export function ring(percent, label) {
  const p = Math.min(100, Math.max(0, percent || 0)), r = 26, c = 2 * Math.PI * r;
  const tone = p >= 90 ? 'danger' : p >= 70 ? 'warning' : 'info';
  const svg = s('svg', { width: 64, height: 64, viewBox: '0 0 64 64', class: 'ring' });
  svg.setAttribute('role', 'meter'); svg.setAttribute('aria-valuemin', '0'); svg.setAttribute('aria-valuemax', '100');
  svg.setAttribute('aria-valuenow', String(p)); svg.setAttribute('aria-label', label);
  svg.dataset.tone = tone;
  svg.append(s('circle', { cx: 32, cy: 32, r, fill: 'none', 'stroke-width': 6 }, 'stroke:var(--wash)'));
  svg.append(s('circle', { cx: 32, cy: 32, r, fill: 'none', 'stroke-width': 6, 'stroke-linecap': 'round', 'stroke-dasharray': `${(p / 100) * c} ${c}`, transform: 'rotate(-90 32 32)' }, 'stroke:var(--tone)'));
  const tx = text(32, 37, Math.round(p) + '%', 'middle'); tx.setAttribute('class', 'ring-v'); svg.append(tx);
  return svg;
}

export function legend(items) {
  const lg = el('div', 'legend');
  for (const it of items) {
    const sp = el('span'), sw = el('span', 'sw' + (it.line ? ' line' : '')); sw.style.color = it.color;
    sp.append(sw, el('span', 't', it.label)); sp.title = it.label;
    if (it.tag) sp.append(it.tag);
    lg.append(sp);
  }
  return lg;
}
