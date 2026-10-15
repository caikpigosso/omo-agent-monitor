import { el, icon, t, repaint } from './core.js';

const cmp = (a, b) => {
  const na = a == null || a === '' || Number.isNaN(a), nb = b == null || b === '' || Number.isNaN(b);
  if (na || nb) return na === nb ? 0 : na ? 1 : -1;
  return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
};

/* columns: [{ id, label, num, get(row) -> sort value, cell(row) -> Node|string, total(rows) -> string, title }]
   sort: { id, dir: 'asc'|'desc' } held by the caller and mutated in place on header clicks. */
export function dataTable({ key, columns, rows, sort, rowKey, onRow, selected, caption, totals }) {
  const wrap = el('div', 'x-scroll'); wrap.dataset.key = key + ':scroll';
  const table = el('table', 'dt');
  if (caption) table.append(el('caption', 'sr-only', caption));
  const thead = el('thead'), hr = el('tr');
  for (const c of columns) {
    const th = el('th', c.num ? 'num' : ''); th.scope = 'col';
    if (c.title) th.title = c.title;
    if (sort && c.get) {
      const b = el('button', 'sort-btn'); b.type = 'button'; b.dataset.key = `${key}:sort:${c.id}`;
      b.append(el('span', '', c.label), icon('chevronDown', 'sm'));
      if (sort.id === c.id) th.setAttribute('aria-sort', sort.dir === 'asc' ? 'ascending' : 'descending');
      b.addEventListener('click', () => {
        if (sort.id === c.id) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
        else { sort.id = c.id; sort.dir = c.num ? 'desc' : 'asc'; }
        repaint();
      });
      th.append(b);
    } else th.textContent = c.label;
    hr.append(th);
  }
  thead.append(hr); table.append(thead);
  let list = rows;
  const sc = sort && columns.find(c => c.id === sort.id && c.get);
  if (sc) list = [...rows].sort((a, b) => { const r = cmp(sc.get(a), sc.get(b)); return sort.dir === 'asc' ? r : -r; });
  const tbody = el('tbody');
  for (const r of list) {
    const tr = el('tr');
    if (onRow) {
      tr.dataset.click = '';
      tr.addEventListener('click', e => { if (!e.target.closest('button,a,select,input')) onRow(r); });
    }
    if (selected && rowKey && selected === rowKey(r)) tr.setAttribute('aria-selected', 'true');
    for (const c of columns) {
      const td = el('td', c.num ? 'num' : '');
      const v = c.cell ? c.cell(r) : c.get?.(r);
      if (v instanceof Node) td.append(v); else td.textContent = v ?? '—';
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  if (totals && list.length) {
    const tf = el('tfoot'), tr = el('tr');
    columns.forEach((c, i) => tr.append(el('td', c.num ? 'num' : '', i === 0 ? t('ui.total') : c.total ? c.total(list) : '')));
    tf.append(tr); table.append(tf);
  }
  wrap.append(table);
  return wrap;
}

export function tableToggle(st, key) {
  const b = el('button', 'btn', st.table ? t('ui.showChart') : t('ui.showTable'));
  b.type = 'button'; b.dataset.key = key + ':toggle';
  b.setAttribute('aria-pressed', String(!!st.table));
  b.addEventListener('click', () => { st.table = !st.table; repaint(); });
  return b;
}
