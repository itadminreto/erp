// Vista de una aplicación: listado, formulario dinámico, papelera, historial, importación/exportación y envío de contraseñas.
import {
  api, h, clear, toast, toastErr, modal, confirmDlg, dropdown, fmtDate, fmtDateTime, debounce, download,
  genPassword, copy, sortable, ACTION_LABELS, state, ipMask,
} from './core.js';
import { printDoc, esc } from './print.js';

const MASK = '••••••••';
const META_COLS = {
  _center: { key: '_center', label: 'Centro', sortKey: 'center' },
  _id: { key: '_id', label: 'ID', sortKey: 'id' },
  _updated_at: { key: '_updated_at', label: 'Modificado', sortKey: 'updated_at' },
  _created_at: { key: '_created_at', label: 'Creado', sortKey: 'created_at' },
  _updated_by: { key: '_updated_by', label: 'Modificado por' },
};

export async function renderApp(root, key, onCountsChanged) {
  const meta = await api('/apps/' + key);
  const fieldsByKey = Object.fromEntries(meta.fields.map((f) => [f.key, f]));
  const usersById = Object.fromEntries(meta.users.map((u) => [u.id, u]));
  const P = meta.perms;
  const st = { q: '', center: '', trash: false, sort: '', dir: 'desc', page: 1, size: 50, selected: new Set(), rows: [], total: 0, filters: {}, view: 'list', calMonth: '', calField: '', colorField: '' };
  const persistKey = `view:${key}`;
  try { Object.assign(st, JSON.parse(sessionStorage.getItem(persistKey) || '{}'), { selected: new Set(), page: 1 }); } catch { /* sin estado previo */ }
  if (!P.view_trash) st.trash = false;
  const saveSt = () => { try { sessionStorage.setItem(persistKey, JSON.stringify({ q: st.q, center: st.center, trash: st.trash, sort: st.sort, dir: st.dir, size: st.size, filters: st.filters, view: st.view, calMonth: st.calMonth, calField: st.calField, colorField: st.colorField })); } catch { /* ignorar */ } };

  // ----- calendario: campos de fecha y de color disponibles -----
  const dateFields = meta.app.calendar ? meta.fields.filter((f) => ['date', 'datetime'].includes(f.type)) : [];
  const colorFields = meta.fields.filter((f) => f.type === 'select' && (f.options.choices || []).length);
  if (!dateFields.some((f) => f.key === st.calField)) st.calField = (dateFields.find((f) => /limite|vencim|proxim|fecha/.test(f.key)) || dateFields[0] || {}).key || '';
  if (st.colorField !== '-' && !colorFields.some((f) => f.key === st.colorField)) st.colorField = (colorFields.find((f) => f.key === 'prioridad') || colorFields.find((f) => f.key === 'estado') || colorFields[0] || {}).key || '-';
  if (!dateFields.length) st.view = 'list';
  if (!/^\d{4}-\d{2}$/.test(st.calMonth)) st.calMonth = new Date().toISOString().slice(0, 7);

  // ----- columnas (diseño por usuario) -----
  const defaultCols = () => ['_center', ...meta.fields.filter((f) => f.show_in_list).map((f) => f.key), '_updated_at'];
  const allColKeys = () => ['_id', '_center', ...meta.fields.map((f) => f.key), '_created_at', '_updated_at', '_updated_by'];
  let columns = (meta.layouts.list && meta.layouts.list.columns) || defaultCols();
  columns = columns.filter((c) => META_COLS[c] || fieldsByKey[c]);
  const colDef = (c) => META_COLS[c] || { key: c, label: fieldsByKey[c].label, sortKey: fieldsByKey[c].type === 'password' ? null : c, field: fieldsByKey[c] };
  const saveColumns = () => api(`/apps/${key}/layout/list`, { method: 'PUT', body: { columns } }).catch(toastErr);

  // ----- estructura -----
  const titleEl = h('div.title',
    h('div.app-ico', { style: { background: meta.app.color + '22', color: meta.app.color } }, meta.app.icon || '📁'),
    h('div', h('h1', meta.app.name), h('div.muted.small', meta.app.description || '')));
  const newBtn = P.create ? h('button.btn.primary', { onclick: () => openRecord(null) }, '＋ ', h('span.lbl', 'Nuevo')) : null;
  const searchInp = h('input', { type: 'search', placeholder: 'Buscar…', value: st.q, oninput: debounce((e) => { st.q = e.target.value; st.page = 1; load(); }, 300) });
  // el filtro guardado solo vale si el centro sigue siendo visible para este usuario
  if (st.center && st.center !== 'none' && !meta.centers.some((c) => String(c.id) === String(st.center))) st.center = '';
  if (st.center === 'none' && !meta.can_view_without_center) st.center = '';
  const centerSel = h('select', { style: { width: 'auto', maxWidth: '220px' }, onchange: (e) => { st.center = e.target.value; st.page = 1; load(); } },
    h('option', { value: '' }, 'Todos los centros'),
    meta.centers.map((c) => h('option', { value: c.id, selected: String(st.center) === String(c.id) }, `${c.code ? c.code + ' · ' : ''}${c.name}`)),
    meta.can_view_without_center ? h('option', { value: 'none', selected: st.center === 'none' }, '(Sin centro)') : null);
  const trashCb = h('input', { type: 'checkbox', checked: st.trash, onchange: (e) => { st.trash = e.target.checked; st.page = 1; trashLbl.classList.toggle('on', st.trash); load(); } });
  const trashLbl = h('label.check.trash-toggle', { class: st.trash ? 'on' : '', title: 'Mostrar también los registros borrados (en rojo)' }, trashCb, '🗑️ Ver papelera');

  const exportMenu = P.export ? dropdown(h('button.btn', '⬇ ', h('span.lbl', 'Exportar')), [
    { label: '📊 Excel (.xlsx) — vista actual', onclick: () => doExport('xlsx') },
    { label: '📄 CSV — vista actual', onclick: () => doExport('csv') },
    P.view_passwords ? '-' : null,
    P.view_passwords ? { label: '🔐 Excel con contraseñas', onclick: () => doExport('xlsx', true) } : null,
  ]) : null;
  const importBtn = P.import ? h('button.btn', { onclick: () => openImport() }, '⬆ ', h('span.lbl', 'Importar')) : null;
  const colsBtn = h('button.btn', { title: 'Columnas', onclick: () => openColumns() }, '☰ ', h('span.lbl', 'Columnas'));
  const printBtn = h('button.btn', { title: 'Imprimir', onclick: () => (st.view === 'calendar' ? printCalendar() : printList()) }, '🖨 ', h('span.lbl', 'Imprimir'));
  const viewBtns = dateFields.length ? h('div.seg', { role: 'tablist' },
    h('button', { class: st.view === 'list' ? 'on' : '', onclick: () => setView('list') }, '☰ Lista'),
    h('button', { class: st.view === 'calendar' ? 'on' : '', onclick: () => setView('calendar') }, '📅 Calendario')) : null;
  function setView(v) {
    st.view = v; st.selected.clear();
    [...viewBtns.children].forEach((b, i) => b.classList.toggle('on', (i === 0) === (v === 'list')));
    listCard.hidden = v !== 'list'; calCard.hidden = v !== 'calendar'; colsBtn.hidden = v !== 'list';
    trashLbl.hidden = v !== 'list';
    load();
  }

  const bulkBar = h('div.bulkbar', { hidden: true });
  const tableWrap = h('div.table-wrap.desktop-only');
  const mobileList = h('div.mobile-list');
  const pager = h('div.pager');
  const listCard = h('div.card', { hidden: st.view !== 'list' }, tableWrap, h('div.mobile-only', { style: { padding: '10px' } }, mobileList), pager);
  const calCard = h('div.card.cal-card', { hidden: st.view !== 'calendar' });
  colsBtn.hidden = st.view !== 'list'; trashLbl.hidden = st.view !== 'list';

  clear(root,
    h('div.page-head', titleEl, h('div.btn-group', importBtn, exportMenu, printBtn, newBtn)),
    h('div.toolbar', h('div.search', searchInp), meta.centers.length ? centerSel : null, P.view_trash ? trashLbl : null, h('div.spacer'), viewBtns, colsBtn),
    bulkBar, listCard, calCard);

  // ----- carga -----
  async function load() {
    saveSt();
    if (st.view === 'calendar') return loadCalendar();
    const qs = new URLSearchParams({ page: st.page, size: st.size });
    if (st.q) qs.set('q', st.q);
    if (st.center) qs.set('center', st.center);
    if (st.trash) qs.set('trash', '1');
    if (st.sort) { qs.set('sort', st.sort); qs.set('dir', st.dir); }
    for (const [k, v] of Object.entries(st.filters)) if (v !== '') qs.set('f_' + k, v);
    try {
      const r = await api(`/apps/${key}/records?${qs}`);
      st.rows = r.rows; st.total = r.total;
      draw();
    } catch (e) { toastErr(e); }
  }

  function cellText(r, c) {
    const f = fieldsByKey[c];
    if (f && f.type === 'password') return r.data[c] ? '••••••' : '';
    if (f && f.type === 'select') return r.data[c] || '';
    if (f && f.type === 'url') return r.data[c] || '';
    if (f && f.type === 'textarea') return r.data[c] || '';
    const v = cellValue(r, c, { reveal: false });
    return v instanceof Node ? v.textContent : String(v ?? '');
  }

  // ----- impresión -----
  function filterQS() {
    const qs = new URLSearchParams();
    if (st.q) qs.set('q', st.q);
    if (st.center) qs.set('center', st.center);
    for (const [k, v] of Object.entries(st.filters)) if (v !== '') qs.set('f_' + k, v);
    return qs;
  }
  function filterSummary() {
    const parts = [];
    if (st.center) { const c = meta.centers.find((x) => String(x.id) === String(st.center)); parts.push(c ? c.name : 'Sin centro'); }
    if (st.q) parts.push(`búsqueda «${st.q}»`);
    return parts.join(' · ');
  }
  async function printList() {
    try {
      const qs = filterQS();
      if (st.trash) qs.set('trash', '1');
      if (st.sort) { qs.set('sort', st.sort); qs.set('dir', st.dir); }
      qs.set('size', 1000);
      let rows = [], page = 1, total = 0;
      do { qs.set('page', page); const r = await api(`/apps/${key}/records?${qs}`); rows = rows.concat(r.rows); total = r.total; page++; } while (rows.length < total && page <= 10);
      if (st.selected.size) rows = rows.filter((r) => st.selected.has(r.id));
      const cols = columns.map(colDef);
      const body = `<table><thead><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>
        ${rows.map((r) => `<tr class="${r.deleted_at ? 'deleted' : ''}">${cols.map((c) => `<td>${esc(cellText(r, c.key))}</td>`).join('')}</tr>`).join('')}
        </tbody></table><footer>${rows.length} registro${rows.length === 1 ? '' : 's'}${st.selected.size ? ' seleccionados' : ''}</footer>`;
      printDoc({ title: meta.app.name, subtitle: filterSummary(), bodyHtml: body, landscape: cols.length > 6 });
    } catch (e) { toastErr(e); }
  }
  function printRecord(rec) {
    const rows = [['Centro', rec.center_name ? `${rec.center_code ? rec.center_code + ' · ' : ''}${rec.center_name}` : '—']];
    for (const g of formGroups().groups) {
      if (g.title) rows.push([null, g.title]);
      for (const k of g.keys) rows.push([fieldsByKey[k].label, cellText(rec, k) || '—']);
    }
    const firma = key === 'recados'
      ? '<div class="firma"><div>Entregado por</div><div>Recibido por</div><div>Fecha y firma de realización</div></div>' : '';
    const body = `<table class="ficha"><tbody>${rows.map(([l, v]) => (l === null ? `<tr><th colspan="2" class="sec">${esc(v)}</th></tr>` : `<tr><th>${esc(l)}</th><td>${esc(v)}</td></tr>`)).join('')}</tbody></table>
      <footer>#${rec.id} · Creado ${esc(fmtDateTime(rec.created_at))}${rec.created_by_name ? ' por ' + esc(rec.created_by_name) : ''} · Modificado ${esc(fmtDateTime(rec.updated_at))}${rec.deleted_at ? ' · EN LA PAPELERA' : ''}</footer>${firma}`;
    printDoc({ title: String(rec.data[meta.app.title_field] || `${meta.app.name} #${rec.id}`), subtitle: meta.app.name, bodyHtml: body });
  }

  // ----- calendario -----
  const PALETTE = ['#10b981', '#0ea5e9', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];
  const DOW = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function monthGrid() {
    const [y, m] = st.calMonth.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7)); // lunes anterior
    const days = [];
    for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); days.push(d); }
    while (days.length > 35 && days[days.length - 7].getMonth() !== m - 1) days.splice(-7); // quita semanas sobrantes
    return { y, m, days };
  }
  function colorOf(r) {
    if (st.colorField === '-') return meta.app.color || '#6366f1';
    const f = fieldsByKey[st.colorField]; const i = (f.options.choices || []).indexOf(r.data[st.colorField]);
    return i < 0 ? '#94a3b8' : PALETTE[i % PALETTE.length];
  }
  const titleOf = (r) => String(r.data[meta.app.title_field] || `#${r.id}`);
  let calRows = [];
  async function loadCalendar() {
    const { days } = monthGrid();
    const qs = filterQS();
    qs.set('date_field', st.calField); qs.set('from', iso(days[0])); qs.set('to', iso(days[days.length - 1]));
    qs.set('size', 1000); qs.set('sort', st.calField); qs.set('dir', 'asc');
    try { calRows = (await api(`/apps/${key}/records?${qs}`)).rows; drawCalendar(); } catch (e) { toastErr(e); }
  }
  function byDay() {
    const map = {};
    for (const r of calRows) { const d = String(r.data[st.calField] || '').slice(0, 10); (map[d] = map[d] || []).push(r); }
    return map;
  }
  function drawCalendar() {
    const { y, m, days } = monthGrid();
    const map = byDay();
    const today = iso(new Date());
    const monthName = new Date(y, m - 1, 1).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }).replace(/^./, (c) => c.toUpperCase());
    const shift = (n) => { const d = new Date(y, m - 1 + n, 1); st.calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; load(); };
    const dateSel = h('select', { onchange: (e) => { st.calField = e.target.value; load(); } }, dateFields.map((f) => h('option', { value: f.key, selected: f.key === st.calField }, f.label)));
    const colorSel = h('select', { onchange: (e) => { st.colorField = e.target.value; saveSt(); drawCalendar(); } },
      h('option', { value: '-' }, 'Sin color'), colorFields.map((f) => h('option', { value: f.key, selected: f.key === st.colorField }, f.label)));
    const chip = (r) => h('button.cal-ev', { style: { '--c': colorOf(r) }, title: titleOf(r), onclick: (e) => { e.stopPropagation(); openRecord(r); } }, titleOf(r));
    const MAX = 3;
    const grid = h('div.cal-grid',
      DOW.map((d) => h('div.cal-dow', d)),
      days.map((d) => {
        const k = iso(d); const list = map[k] || [];
        return h('div.cal-day', {
          class: [d.getMonth() !== m - 1 ? 'out' : '', k === today ? 'today' : '', d.getDay() % 6 === 0 ? 'we' : ''].join(' '),
          title: P.create ? 'Doble clic para crear' : '',
          ondblclick: () => P.create && openRecord(null, { [st.calField]: st.calField && fieldsByKey[st.calField].type === 'datetime' ? k + 'T09:00' : k }),
        }, h('div.cal-num', d.getDate()),
        list.slice(0, MAX).map(chip),
        list.length > MAX ? h('button.cal-more', { onclick: () => openDay(k, list) }, `+${list.length - MAX} más`) : null);
      }));
    // vista agenda (móvil)
    const daysWith = days.filter((d) => d.getMonth() === m - 1 && map[iso(d)]);
    const agenda = h('div.cal-agenda', daysWith.length ? daysWith.map((d) => h('div.cal-agenda-day',
      h('div.cal-agenda-date', { class: iso(d) === today ? 'today' : '' }, d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })),
      h('div', map[iso(d)].map(chip)))) : h('div.empty', 'Nada este mes'));
    const legend = st.colorField !== '-' ? h('div.cal-legend', (fieldsByKey[st.colorField].options.choices || []).map((c, i) => h('span', { style: { '--c': PALETTE[i % PALETTE.length] } }, c))) : null;
    clear(calCard,
      h('div.cal-head',
        h('div.row', h('button.btn.sm', { onclick: () => shift(-1) }, '‹'), h('button.btn.sm', { onclick: () => { st.calMonth = today.slice(0, 7); load(); } }, 'Hoy'), h('button.btn.sm', { onclick: () => shift(1) }, '›'),
          h('h2.cal-title', monthName)),
        h('div.row', h('label.small.muted', 'Fecha'), dateSel, colorFields.length ? [h('label.small.muted', 'Color'), colorSel] : null)),
      h('div.desktop-only', grid), h('div.mobile-only', agenda), legend,
      h('div.muted.small', { style: { padding: '0 14px 12px' } }, `${calRows.length} en el periodo${P.create ? ' · doble clic en un día para crear' : ''}`));
  }
  function openDay(k, list) {
    const m = modal({ title: fmtDate(k), size: 'sm', content: h('div.stack', { style: { gap: '6px' } }, list.map((r) => h('button.cal-ev', { style: { '--c': colorOf(r) }, onclick: () => { m.close(); openRecord(r); } }, titleOf(r)))) });
  }
  function printCalendar() {
    const { y, m, days } = monthGrid();
    const map = byDay();
    const weeks = []; for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
    const body = `<table class="cal"><thead><tr>${DOW.map((d) => `<th>${d}</th>`).join('')}</tr></thead><tbody>
      ${weeks.map((w) => `<tr>${w.map((d) => `<td class="${d.getMonth() !== m - 1 ? 'out' : ''}"><div class="d">${d.getDate()}</div>${(map[iso(d)] || []).map((r) => `<div class="ev" style="border-color:${colorOf(r)}">${esc(titleOf(r))}</div>`).join('')}</td>`).join('')}</tr>`).join('')}
      </tbody></table>
      ${st.colorField !== '-' ? `<div class="legend">${(fieldsByKey[st.colorField].options.choices || []).map((c, i) => `<span style="--c:${PALETTE[i % PALETTE.length]}">${esc(c)}</span>`).join('')}</div>` : ''}`;
    const title = `${meta.app.name} · ${new Date(y, m - 1, 1).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })}`;
    printDoc({ title, subtitle: [fieldsByKey[st.calField].label, filterSummary()].filter(Boolean).join(' · '), bodyHtml: body, landscape: true });
  }

  function cellValue(r, c, { reveal = true } = {}) {
    switch (c) {
      case '_center': return r.center_code || r.center_name || '—';
      case '_id': return '#' + r.id;
      case '_updated_at': return fmtDateTime(r.updated_at);
      case '_created_at': return fmtDateTime(r.created_at);
      case '_updated_by': return r.updated_by_name || '';
    }
    const f = fieldsByKey[c]; const v = r.data[c];
    if (v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length)) return '';
    switch (f.type) {
      case 'password': {
        const span = h('span.pw-mask', MASK);
        if (!reveal || !r.can.view_passwords) return span;
        return h('span', span, ' ', h('button.btn.ghost.sm', { title: 'Mostrar', onclick: async (e) => {
          e.stopPropagation();
          try { const { value } = await api(`/apps/${key}/records/${r.id}/password/${c}`); span.textContent = value; span.classList.remove('pw-mask'); e.target.replaceWith(h('button.btn.ghost.sm', { title: 'Copiar', onclick: (ev) => { ev.stopPropagation(); copy(value); } }, '📋')); } catch (err) { toastErr(err); }
        } }, '👁'));
      }
      case 'date': return fmtDate(v);
      case 'datetime': return fmtDateTime(v);
      case 'checkbox': return v ? '✔' : '—';
      case 'user': return usersById[v] ? usersById[v].name : `#${v}`;
      case 'multiselect': return v.join(', ');
      case 'select': return h('span.chip', v);
      case 'url': return h('a', { href: v, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, v.replace(/^https?:\/\//, ''));
      case 'email': return h('a', { href: 'mailto:' + v, onclick: (e) => e.stopPropagation() }, v);
      case 'phone': return h('a', { href: 'tel:' + v, onclick: (e) => e.stopPropagation() }, v);
      case 'color': return h('span.chip', h('span', { style: { width: '12px', height: '12px', borderRadius: '3px', background: v, display: 'inline-block' } }), v);
      case 'decimal': return Number(v).toLocaleString('es-ES', { maximumFractionDigits: 2 });
      case 'iban': return h('span.mono', String(v).replace(/(.{4})/g, '$1 ').trim());
      case 'ip': return h('span.mono', v);
      default: return String(v);
    }
  }

  function draw() {
    // tabla
    const cols = columns.map(colDef);
    const allSel = st.rows.length && st.rows.every((r) => st.selected.has(r.id));
    const headRow = h('tr',
      h('th.cb.nosort', h('input', { type: 'checkbox', checked: !!allSel, onchange: (e) => { st.rows.forEach((r) => (e.target.checked ? st.selected.add(r.id) : st.selected.delete(r.id))); draw(); } })),
      cols.map((c) => h('th', {
        dataset: { col: c.key }, class: c.sortKey ? '' : 'nosort', title: 'Arrastra para mover la columna',
        onclick: () => { if (!c.sortKey) return; if (st.sort === c.sortKey) st.dir = st.dir === 'asc' ? 'desc' : 'asc'; else { st.sort = c.sortKey; st.dir = 'asc'; } load(); },
      }, h('span.grip', '⋮⋮'), c.label, st.sort && st.sort === c.sortKey ? h('span.sort', st.dir === 'asc' ? '▲' : '▼') : null)),
      h('th.nosort', ''));
    const tbody = h('tbody', st.rows.map((r) => h('tr', { class: r.deleted_at ? 'deleted' : '', onclick: () => openRecord(r) },
      h('td.cb', { onclick: (e) => e.stopPropagation() }, h('input', { type: 'checkbox', checked: st.selected.has(r.id), onchange: (e) => { e.target.checked ? st.selected.add(r.id) : st.selected.delete(r.id); drawBulk(); } })),
      cols.map((c) => h('td', { title: typeof cellValue(r, c.key, { reveal: false }) === 'string' ? cellValue(r, c.key) : '' }, cellValue(r, c.key))),
      h('td.actions', { onclick: (e) => e.stopPropagation() }, rowActions(r)))));
    const table = h('table.data', h('thead', headRow), tbody);
    clear(tableWrap, st.rows.length ? table : emptyState());
    sortable(headRow, {
      filter: '.cb, th:last-child', preventOnFilter: false, draggable: 'th[data-col]',
      onEnd: () => { columns = [...headRow.querySelectorAll('th[data-col]')].map((th) => th.dataset.col); saveColumns(); draw(); },
    });

    // tarjetas (móvil)
    const titleKey = meta.app.title_field || (meta.fields[0] && meta.fields[0].key);
    clear(mobileList, st.rows.length ? st.rows.map((r) => h('div.card.rec-card', { class: r.deleted_at ? 'deleted' : '', onclick: () => openRecord(r) },
      h('div.t', r.deleted_at ? '🗑️' : null, h('span', { style: { flex: 1 } }, String(r.data[titleKey] || `#${r.id}`)), h('span.muted.small', r.center_code || r.center_name || '')),
      h('div.kv', columns.filter((c) => c !== titleKey && c !== '_center').slice(0, 5).map((c) => [h('span', colDef(c).label), h('span', cellValue(r, c, { reveal: false }) || '—')])),
      r.deleted_at && r.can.restore ? h('div', h('button.btn.sm.ok', { onclick: (e) => { e.stopPropagation(); restoreRec(r); } }, '↩ Restaurar')) : null,
    )) : emptyState());

    // paginación
    const pages = Math.max(1, Math.ceil(st.total / st.size));
    clear(pager,
      h('span.muted.small', `${st.total} registro${st.total === 1 ? '' : 's'}`),
      h('select', { style: { width: 'auto' }, onchange: (e) => { st.size = Number(e.target.value); st.page = 1; load(); } }, [25, 50, 100, 250].map((n) => h('option', { value: n, selected: n === st.size }, `${n} / pág.`))),
      h('button.btn.sm', { disabled: st.page <= 1, onclick: () => { st.page--; load(); } }, '‹'),
      h('span.small', `${st.page} / ${pages}`),
      h('button.btn.sm', { disabled: st.page >= pages, onclick: () => { st.page++; load(); } }, '›'));
    drawBulk();
  }

  function emptyState() {
    return h('div.empty', h('div.big', st.q || st.center ? '🔎' : meta.app.icon || '📁'),
      h('p', st.q || st.center ? 'No hay resultados con estos filtros.' : 'Todavía no hay registros.'),
      !st.q && P.create ? h('button.btn.primary', { onclick: () => openRecord(null) }, '＋ Crear el primero') : null);
  }

  function rowActions(r) {
    if (r.deleted_at) {
      return h('div.btn-group', { style: { flexWrap: 'nowrap' } },
        r.can.restore ? h('button.btn.sm.ok', { onclick: () => restoreRec(r) }, '↩ Restaurar') : null,
        r.can.purge ? h('button.btn.sm.danger', { title: 'Eliminar definitivamente', onclick: () => purgeRec(r) }, '✕') : null);
    }
    return r.can.delete ? h('button.btn.sm.ghost', { title: 'Enviar a la papelera', onclick: () => deleteRec(r) }, '🗑️') : null;
  }

  function drawBulk() {
    const ids = [...st.selected];
    bulkBar.hidden = !ids.length;
    if (!ids.length) return;
    const selRows = st.rows.filter((r) => st.selected.has(r.id));
    clear(bulkBar, h('strong', `${ids.length} seleccionado${ids.length > 1 ? 's' : ''}`),
      P.delete && selRows.some((r) => !r.deleted_at) ? h('button.btn.sm.danger', { onclick: () => bulk('delete') }, '🗑️ A la papelera') : null,
      P.restore && selRows.some((r) => r.deleted_at) ? h('button.btn.sm.ok', { onclick: () => bulk('restore') }, '↩ Restaurar') : null,
      P.purge && selRows.some((r) => r.deleted_at) ? h('button.btn.sm.danger', { onclick: () => bulk('purge') }, '✕ Eliminar definitivamente') : null,
      P.export ? h('button.btn.sm', { onclick: () => doExport('xlsx', false, ids) }, '⬇ Exportar selección') : null,
      h('button.btn.sm.ghost', { onclick: () => { st.selected.clear(); draw(); } }, 'Quitar selección'));
  }

  async function bulk(action) {
    const ids = [...st.selected];
    const txt = { delete: `¿Enviar ${ids.length} registro(s) a la papelera?`, restore: `¿Restaurar ${ids.length} registro(s)?`, purge: `¿Eliminar DEFINITIVAMENTE ${ids.length} registro(s) de la papelera? Esta acción no se puede deshacer.` }[action];
    if (!(await confirmDlg(txt, { danger: action !== 'restore' }))) return;
    try {
      const r = await api(`/apps/${key}/bulk`, { method: 'POST', body: { action, ids } });
      toast(`${r.ok} registro(s) procesados${r.errors.length ? ` · ${r.errors.length} con error` : ''}`, r.errors.length ? 'error' : 'ok');
      st.selected.clear(); load(); onCountsChanged && onCountsChanged();
    } catch (e) { toastErr(e); }
  }
  async function deleteRec(r, after) {
    if (!(await confirmDlg('El registro se enviará a la papelera y podrá recuperarse.', { ok: 'Enviar a la papelera', danger: true }))) return;
    try { await api(`/apps/${key}/records/${r.id}`, { method: 'DELETE' }); toast('Enviado a la papelera', 'ok'); load(); after && after(); onCountsChanged && onCountsChanged(); } catch (e) { toastErr(e); }
  }
  async function restoreRec(r, after) {
    try { await api(`/apps/${key}/records/${r.id}/restore`, { method: 'POST' }); toast('Registro restaurado', 'ok'); load(); after && after(); onCountsChanged && onCountsChanged(); } catch (e) { toastErr(e); }
  }
  async function purgeRec(r, after) {
    if (!(await confirmDlg('Se eliminará definitivamente. Quedará constancia en la auditoría pero no podrá recuperarse.', { ok: 'Eliminar definitivamente', danger: true }))) return;
    try { await api(`/apps/${key}/records/${r.id}/purge`, { method: 'DELETE' }); toast('Eliminado definitivamente', 'ok'); load(); after && after(); } catch (e) { toastErr(e); }
  }

  function doExport(format, passwords = false, ids = null) {
    const qs = new URLSearchParams({ format });
    if (st.q) qs.set('q', st.q);
    if (st.center) qs.set('center', st.center);
    if (st.trash) qs.set('trash', '1');
    if (st.sort) { qs.set('sort', st.sort); qs.set('dir', st.dir); }
    if (passwords) qs.set('passwords', '1');
    if (ids) qs.set('ids', ids.join(','));
    download(`/apps/${key}/export?${qs}`, `${key}.${format}`);
  }

  // ----- columnas -----
  function openColumns() {
    const order = [...columns, ...allColKeys().filter((c) => !columns.includes(c))];
    const list = h('div.sort-list', order.map((c) => h('div.sort-item', { dataset: { col: c } },
      h('span.grip', '⋮⋮'), h('label.check.grow', h('input', { type: 'checkbox', checked: columns.includes(c) }), colDef(c).label))));
    sortable(list, { handle: '.grip' });
    const m = modal({
      title: 'Columnas visibles', size: 'sm',
      content: [h('p.muted.small', 'Marca las columnas que quieres ver y arrástralas para ordenarlas. El diseño se guarda para tu usuario.'), list],
      footer: [h('button.btn.ghost', { onclick: async () => { columns = defaultCols(); await api(`/apps/${key}/layout/list`, { method: 'PUT', body: { reset: true } }); m.close(); draw(); } }, 'Restablecer'),
        h('div.spacer'), h('button.btn.primary', { onclick: () => {
          columns = [...list.children].filter((el) => el.querySelector('input').checked).map((el) => el.dataset.col);
          saveColumns(); m.close(); draw();
        } }, 'Aplicar')],
    });
  }

  // ----- secciones del formulario -----
  /**
   * Grupos de campos según el diseño de la app (super admin). El primer grupo no tiene título (campos antes de
   * cualquier sección). Dentro de cada sección se aplica el orden personal del usuario («Mover campos»).
   */
  function formGroups() {
    let layout = {};
    try { layout = meta.app.form_layout ? JSON.parse(meta.app.form_layout) : {}; } catch { layout = {}; }
    const groups = [{ title: null, keys: [] }];
    const seen = new Set();
    for (const it of Array.isArray(layout.items) ? layout.items : []) {
      if (it && typeof it === 'object' && 'section' in it) groups.push({ title: String(it.section || 'Sección'), keys: [] });
      else if (typeof it === 'string' && fieldsByKey[it] && !seen.has(it)) { groups[groups.length - 1].keys.push(it); seen.add(it); }
    }
    groups[groups.length - 1].keys.push(...meta.fields.map((f) => f.key).filter((k) => !seen.has(k))); // campos nuevos, al final
    const uo = meta.layouts.form && meta.layouts.form.order;
    if (Array.isArray(uo)) {
      const idx = Object.fromEntries(uo.map((k, i) => [k, i]));
      for (const g of groups) g.keys = g.keys.map((k, i) => [k, idx[k] ?? 1e6 + i]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
    }
    return { groups: groups.filter((g) => g.keys.length), tabs: !!layout.tabs };
  }

  // ----- formulario de registro -----
  async function openRecord(rec, prefill = {}) {
    if (rec) { try { rec = await api(`/apps/${key}/records/${rec.id}`); } catch (e) { return toastErr(e); } }
    const isNew = !rec;
    const editable = isNew ? P.create : rec.can.edit;
    const inputs = {}; const dirtyPw = new Set();

    const centerOpts = meta.centers.filter((c) => (isNew ? c.can_create : true) || (rec && rec.center_id === c.id));
    const centerSelect = h('select', { disabled: !editable },
      (isNew ? meta.can_create_without_center : true) ? h('option', { value: '' }, '— Sin centro —') : null,
      centerOpts.map((c) => h('option', { value: c.id, selected: rec ? rec.center_id === c.id : String(st.center) === String(c.id) }, `${c.code ? c.code + ' · ' : ''}${c.name}`)));

    const fieldEls = {};
    for (const f of meta.fields) fieldEls[f.key] = buildField(f);
    // una rejilla por sección; en modo pestañas, una pestaña por sección con título
    const { groups, tabs: asTabs } = formGroups();
    const grids = groups.map(() => h('div.form-grid'));
    const drawGrids = (gs) => gs.forEach((g, i) => clear(grids[i], g.keys.map((k) => fieldEls[k])));
    drawGrids(groups);
    const titled = groups.map((g, i) => ({ g, i })).filter((x) => x.g.title);
    let showSection = () => {};
    let formBody;
    if (asTabs && titled.length >= 2) {
      const btns = titled.map(({ g, i }) => h('button', { type: 'button', onclick: () => showSection(i) }, g.title));
      const panes = titled.map(({ i }) => h('div.sec-pane', grids[i]));
      showSection = (i) => titled.forEach((t, n) => { const on = t.i === i; btns[n].classList.toggle('active', on); panes[n].hidden = !on; });
      formBody = [groups[0].title ? null : grids[0], h('div.form-subtabs', btns), panes];
      showSection(titled[0].i);
    } else {
      formBody = groups.map((g, i) => [g.title ? h('h3.form-section-title', g.title) : null, grids[i]]);
    }

    function buildField(f) {
      const v = rec ? rec.data[f.key] : (f.key in prefill ? prefill[f.key] : (f.type === 'checkbox' ? false : ''));
      let input; let extra = null;
      const dis = !editable;
      switch (f.type) {
        case 'textarea': input = h('textarea', { value: v || '', disabled: dis }); break;
        case 'number': input = h('input', { type: 'number', step: '1', value: v ?? '', disabled: dis }); break;
        case 'decimal': input = h('input', { type: 'number', step: 'any', value: v ?? '', disabled: dis }); break;
        case 'date': input = h('input', { type: 'date', value: v || '', disabled: dis }); break;
        case 'datetime': input = h('input', { type: 'datetime-local', value: v || '', disabled: dis }); break;
        case 'email': input = h('input', { type: 'email', value: v || '', disabled: dis }); break;
        case 'phone': input = h('input', { type: 'tel', value: v || '', disabled: dis }); break;
        case 'url': input = h('input', { type: 'url', value: v || '', placeholder: 'https://', disabled: dis });
          extra = v ? h('a.btn.icon', { href: v, target: '_blank', rel: 'noopener', title: 'Abrir' }, '↗') : null; break;
        case 'color': input = h('input', { type: 'color', value: v || '#4f46e5', disabled: dis }); break;
        case 'ip': input = ipMask(h('input', { type: 'text', value: v || '', disabled: dis })); break;
        case 'iban': input = h('input', { type: 'text', value: v ? String(v).replace(/(.{4})/g, '$1 ').trim() : '', placeholder: 'ES00 0000 0000 0000 0000 0000', autocomplete: 'off', disabled: dis }); break;
        case 'checkbox': input = h('input', { type: 'checkbox', checked: !!v, disabled: dis }); break;
        case 'select': input = h('select', { disabled: dis }, h('option', { value: '' }, '—'), (f.options.choices || []).map((c) => h('option', { value: c, selected: c === v }, c)),
          v && !(f.options.choices || []).includes(v) ? h('option', { value: v, selected: true }, v) : null); break;
        case 'multiselect': input = h('select', { multiple: true, disabled: dis, size: Math.min(6, (f.options.choices || []).length || 3) }, (f.options.choices || []).map((c) => h('option', { value: c, selected: Array.isArray(v) && v.includes(c) }, c))); break;
        case 'user': input = h('select', { disabled: dis }, h('option', { value: '' }, '—'), meta.users.map((u) => h('option', { value: u.id, selected: Number(v) === u.id }, u.name))); break;
        case 'password': {
          const hasValue = v === MASK;
          input = h('input', { type: 'password', value: '', autocomplete: 'new-password', placeholder: hasValue ? MASK + '  (guardada)' : '', disabled: dis,
            oninput: () => dirtyPw.add(f.key) });
          const canSee = isNew || (rec && rec.can.view_passwords);
          const btns = [];
          if (hasValue && rec && rec.can.view_passwords) {
            btns.push(h('button.btn.icon', { type: 'button', title: 'Mostrar / ocultar', onclick: async () => {
              if (input.type === 'text') { input.type = 'password'; if (!dirtyPw.has(f.key)) input.value = ''; return; }
              if (!dirtyPw.has(f.key) && !input.value) {
                try { input.value = (await api(`/apps/${key}/records/${rec.id}/password/${f.key}`)).value; } catch (e) { return toastErr(e); }
              }
              input.type = 'text';
            } }, '👁'));
            btns.push(h('button.btn.icon', { type: 'button', title: 'Copiar', onclick: async () => {
              let val = input.value;
              if (!val && !dirtyPw.has(f.key)) { try { val = (await api(`/apps/${key}/records/${rec.id}/password/${f.key}`)).value; } catch (e) { return toastErr(e); } }
              copy(val);
            } }, '📋'));
          } else if (canSee) {
            btns.push(h('button.btn.icon', { type: 'button', title: 'Mostrar / ocultar', onclick: () => { input.type = input.type === 'text' ? 'password' : 'text'; } }, '👁'));
          }
          if (editable) btns.push(h('button.btn.icon', { type: 'button', title: 'Generar contraseña segura', onclick: () => { input.value = genPassword(); input.type = 'text'; dirtyPw.add(f.key); } }, '🎲'));
          if (hasValue && rec && rec.can.share_passwords) btns.push(h('button.btn.icon', { type: 'button', title: 'Enviar (email, WhatsApp, enlace…)', onclick: () => openShare(rec, f) }, '📤'));
          extra = btns;
          break;
        }
        default: input = h('input', { type: 'text', value: v ?? '', disabled: dis });
      }
      inputs[f.key] = input;
      const label = h('label', f.label, f.required ? h('span.req', '*') : null);
      const body = f.type === 'checkbox' ? h('label.check', { style: { minHeight: '38px' } }, input, 'Sí')
        : extra ? h('div.input-group', input, extra) : input;
      if (f.max_length && ['INPUT', 'TEXTAREA'].includes(input.tagName) && input.type !== 'checkbox') input.maxLength = f.max_length;
      const hgt = ['textarea', 'multiselect'].includes(f.type) ? (f.height || 1) : 1; // altura en filas (diseñador)
      return h('div.field', { class: 'w-' + ({ half: 'md', third: 'sm' }[f.width] || f.width || 'md') + (hgt > 1 ? ' tall' : ''), dataset: { key: f.key },
        style: hgt > 1 ? { gridRow: `span ${hgt}` } : {} }, label, body, f.help ? h('div.help', f.help) : null);
    }

    function collect() {
      const data = {};
      for (const f of meta.fields) {
        const i = inputs[f.key];
        if (f.type === 'password') { if (dirtyPw.has(f.key)) data[f.key] = i.value; continue; }
        if (f.type === 'checkbox') data[f.key] = i.checked;
        else if (f.type === 'multiselect') data[f.key] = [...i.selectedOptions].map((o) => o.value);
        else data[f.key] = i.value;
      }
      return { center_id: centerSelect.value || null, data };
    }

    // diseño del formulario (por usuario)
    let sorter = null;
    const designBtn = h('button.btn.sm', { title: 'Mover campos', onclick: () => {
      const on = !grids[0].classList.contains('designing');
      grids.forEach((g) => g.classList.toggle('designing', on));
      designBtn.textContent = on ? '✔ Guardar diseño' : '✥ Mover campos';
      resetBtn.hidden = !on;
      if (on) sorter = grids.map((g, i) => sortable(g, { draggable: '.field', group: 'sec' + i })); // cada campo dentro de su sección
      else {
        (sorter || []).forEach((x) => x && x.destroy()); sorter = null;
        const formOrder = grids.flatMap((g) => [...g.children].map((el) => el.dataset.key));
        meta.layouts.form = { order: formOrder };
        api(`/apps/${key}/layout/form`, { method: 'PUT', body: { order: formOrder } }).then(() => toast('Diseño guardado', 'ok')).catch(toastErr);
      }
    } }, '✥ Mover campos');
    const resetBtn = h('button.btn.sm.ghost', { hidden: true, onclick: async () => {
      meta.layouts.form = null; drawGrids(formGroups().groups);
      await api(`/apps/${key}/layout/form`, { method: 'PUT', body: { reset: true } }).catch(toastErr);
    } }, 'Restablecer');

    const dataPane = h('div',
      rec && rec.deleted_at ? h('div.deleted-banner', `🗑️ Registro en la papelera desde ${fmtDateTime(rec.deleted_at)}${rec.deleted_by_name ? ' por ' + rec.deleted_by_name : ''}.`) : null,
      h('div.form-top',
        meta.centers.length ? h('div.field', h('label', 'Centro de trabajo / coste'), centerSelect) : null,
        h('div.design-tools.desktop-only', designBtn, resetBtn)),
      formBody,
      rec ? h('div.meta-line', h('span', `#${rec.id}`), h('span', `Creado ${fmtDateTime(rec.created_at)}${rec.created_by_name ? ' por ' + rec.created_by_name : ''}`),
        h('span', `Modificado ${fmtDateTime(rec.updated_at)}${rec.updated_by_name ? ' por ' + rec.updated_by_name : ''}`)) : null);
    const historyPane = h('div', { hidden: true });

    let tabs = null;
    if (rec && rec.can.view_history) {
      const tData = h('button.active', { onclick: () => switchTab(0) }, 'Datos');
      const tHist = h('button', { onclick: () => switchTab(1) }, '🕘 Historial');
      tabs = h('div.tabs', tData, tHist);
      var switchTab = async (i) => {
        tData.classList.toggle('active', i === 0); tHist.classList.toggle('active', i === 1);
        dataPane.hidden = i !== 0; historyPane.hidden = i !== 1;
        if (i === 1) loadHistory(rec, historyPane);
      };
    }

    const title = rec ? String(rec.data[meta.app.title_field] || `#${rec.id}`) : `Nuevo · ${meta.app.name}`;
    const m = modal({ title: [h('span', meta.app.icon || ''), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, title)], size: 'lg', tabs, content: [dataPane, historyPane] });
    const footer = [];
    if (rec && rec.deleted_at) {
      if (rec.can.restore) footer.push(h('button.btn.ok', { onclick: () => restoreRec(rec, () => m.close()) }, '↩ Restaurar'));
      if (rec.can.purge) footer.push(h('button.btn.danger', { onclick: () => purgeRec(rec, () => m.close()) }, 'Eliminar definitivamente'));
    } else if (rec && rec.can.delete) footer.push(h('button.btn.danger', { onclick: () => deleteRec(rec, () => m.close()) }, '🗑️ Papelera'));
    if (rec) footer.push(h('button.btn', { title: 'Imprimir ficha', onclick: () => printRecord(rec) }, '🖨 Imprimir'));
    footer.push(h('div.spacer'), h('button.btn', { onclick: () => m.close() }, editable ? 'Cancelar' : 'Cerrar'));
    if (editable && !(rec && rec.deleted_at)) {
      const saveBtn = h('button.btn.primary', { onclick: async () => {
        saveBtn.disabled = true;
        try {
          const body = collect();
          if (isNew) await api(`/apps/${key}/records`, { method: 'POST', body });
          else await api(`/apps/${key}/records/${rec.id}`, { method: 'PUT', body });
          toast(isNew ? 'Registro creado' : 'Cambios guardados', 'ok');
          m.close(); load(); onCountsChanged && onCountsChanged();
        } catch (e) {
          toastErr(e); saveBtn.disabled = false;
          const bad = groups.findIndex((g) => g.keys.some((k) => e.message.includes(fieldsByKey[k].label + ':')));
          if (bad >= 0) showSection(bad);
        }
      } }, isNew ? 'Crear' : 'Guardar');
      footer.push(saveBtn);
    }
    m.foot.hidden = false; footer.forEach((b) => m.foot.append(b));
  }

  async function loadHistory(rec, pane) {
    clear(pane, h('p.muted', 'Cargando…'));
    try {
      const rows = await api(`/apps/${key}/records/${rec.id}/history`);
      const label = (k) => (k === '_centro' ? 'Centro' : fieldsByKey[k] ? fieldsByKey[k].label : k);
      const centerName = (id) => { const c = meta.centers.find((x) => String(x.id) === String(id)); return c ? c.name : id; };
      const show = (field, v) => {
        if (field === '_centro') return v === '' || v === null ? '—' : centerName(v);
        const f = fieldsByKey[field];
        if (f && f.type === 'user' && usersById[v]) return usersById[v].name;
        if (f && f.type === 'checkbox') return v === true || v === 1 ? 'Sí' : v === false || v === 0 ? 'No' : String(v);
        if (Array.isArray(v)) return v.join(', ');
        return v === '' || v === null || v === undefined ? '—' : String(v);
      };
      clear(pane, rows.length ? h('div.timeline', rows.map((r) => {
        const [lbl, cls] = ACTION_LABELS[r.action] || [r.action, ''];
        return h('div.tl-item',
          h('div.h', h('span.chip', { class: cls }, lbl), h('strong', r.user_name || ''), h('span.muted', fmtDateTime(r.ts)), h('span.muted.small', r.summary || '')),
          r.changes.length ? h('table', r.changes.map((c) => h('tr', h('td', { style: { width: '30%' } }, label(c.field)), h('td.from', show(c.field, c.from)), h('td.to', '→ ' + show(c.field, c.to))))) : null);
      })) : h('p.muted', 'Sin movimientos.'));
    } catch (e) { clear(pane, h('p.error', e.message)); }
  }

  // ----- enviar contraseña -----
  function openShare(rec, f) {
    const channel = h('select', ['link', 'email', 'whatsapp', 'sms'].map((c) => h('option', { value: c }, { link: '🔗 Enlace / código de un solo uso', email: '✉️ Correo electrónico', whatsapp: '💬 WhatsApp', sms: '📱 SMS' }[c])));
    const to = h('input', { placeholder: '' });
    const toField = h('div.field', h('label', 'Destinatario'), to);
    const hours = h('input', { type: 'number', min: 1, max: 720, value: 24 });
    const views = h('input', { type: 'number', min: 1, max: 20, value: 1 });
    const plain = h('input', { type: 'checkbox' });
    const pick = h('select', { onchange: () => { const u = meta.users.find((x) => String(x.id) === pick.value); if (u) to.value = channel.value === 'email' ? u.email : (u.phone || ''); } },
      h('option', { value: '' }, 'Elegir usuario…'), meta.users.map((u) => h('option', { value: u.id }, u.name)));
    const sync = () => {
      toField.hidden = channel.value === 'link';
      to.placeholder = channel.value === 'email' ? 'nombre@dominio.com' : '+34 600 000 000';
      to.type = channel.value === 'email' ? 'email' : 'tel';
    };
    channel.onchange = sync; sync();
    const out = h('div');
    const m = modal({
      title: `Enviar «${f.label}»`, size: 'sm',
      content: h('div.stack',
        h('p.muted.small', 'Por seguridad se envía un enlace que solo puede abrirse las veces indicadas y caduca. Toda acción queda registrada en el historial.'),
        h('div.field', h('label', 'Canal'), channel),
        toField, h('div.field', { style: {} }, h('label', 'Usuario (opcional)'), pick),
        h('div.two-col', h('div.field', h('label', 'Caduca en (horas)'), hours), h('div.field', h('label', 'Nº de aperturas'), views)),
        h('label.check', plain, 'Incluir la contraseña en claro en el mensaje (menos seguro)'),
        out),
      footer: [h('div.spacer'), h('button.btn', { onclick: () => m.close() }, 'Cerrar'), h('button.btn.primary', { onclick: async () => {
        try {
          const r = await api(`/apps/${key}/records/${rec.id}/share`, { method: 'POST', body: { field: f.key, channel: channel.value, to: to.value, hours: hours.value, max_views: views.value, include_plain: plain.checked } });
          if (r.url) window.open(r.url, '_blank', 'noopener');
          if (r.sent) toast('Correo enviado', 'ok');
          clear(out, h('div.result-box', h('div.small.muted', 'Código: ', h('strong', r.code)), h('div', { style: { whiteSpace: 'pre-wrap', margin: '6px 0' } }, r.text),
            h('div.row', h('button.btn.sm', { onclick: () => copy(r.text) }, '📋 Copiar mensaje'), h('button.btn.sm', { onclick: () => copy(r.link) }, '🔗 Copiar enlace'))));
        } catch (e) { toastErr(e); }
      } }, 'Generar y enviar')],
    });
  }

  // ----- importación -----
  function openImport() {
    const fileInp = h('input', { type: 'file', accept: '.csv,.xlsx,.txt' });
    const step = h('div.stack');
    const m = modal({ title: `Importar en ${meta.app.name}`, size: 'lg', content: step });
    const step1 = () => {
      clear(step,
        h('p', 'Sube un fichero Excel (.xlsx) o CSV con una fila de cabecera. Las columnas se asocian automáticamente por nombre y podrás revisarlas antes de importar.'),
        h('div.row', h('button.btn.sm', { onclick: () => download(`/apps/${key}/template?format=xlsx`, 'plantilla.xlsx') }, '📊 Plantilla Excel'),
          h('button.btn.sm', { onclick: () => download(`/apps/${key}/template?format=csv`, 'plantilla.csv') }, '📄 Plantilla CSV')),
        h('div.field', h('label', 'Fichero'), fileInp),
        h('div.row', h('div.spacer'), h('button.btn.primary', { onclick: preview }, 'Continuar →')));
    };
    async function preview() {
      if (!fileInp.files[0]) return toast('Selecciona un fichero', 'error');
      const fd = new FormData(); fd.append('file', fileInp.files[0]);
      try { step2(await api(`/apps/${key}/import/preview`, { method: 'POST', form: fd })); } catch (e) { toastErr(e); }
    }
    function step2(p) {
      const sels = p.header.map((hd, i) => h('select', h('option', { value: '' }, '— Ignorar —'), p.targets.map((t) => h('option', { value: t.key, selected: p.mapping[i] === t.key }, t.label))));
      const defCenter = h('select', meta.can_create_without_center ? h('option', { value: '' }, '— Sin centro —') : null, meta.centers.filter((c) => c.can_create).map((c) => h('option', { value: c.id, selected: String(st.center) === String(c.id) }, `${c.code ? c.code + ' · ' : ''}${c.name}`)));
      const matchSel = h('select', h('option', { value: '' }, 'No: crear siempre registros nuevos'), meta.fields.filter((f) => f.type !== 'password').map((f) => h('option', { value: f.key, selected: f.unique_value }, `Sí, si coincide «${f.label}»`)));
      const result = h('div');
      const run = async (dry) => {
        try {
          const r = await api(`/apps/${key}/import/commit`, { method: 'POST', body: { token: p.token, mapping: sels.map((s) => s.value), default_center: defCenter.value || null, match_field: matchSel.value, dry_run: dry } });
          clear(result, h('div.result-box',
            h('div.row', h('span.chip.ok', `${r.created} altas`), h('span.chip', `${r.updated} modificaciones`), h('span.chip', `${r.skipped} sin cambios`), r.errors.length ? h('span.chip.danger', `${r.errors.length} errores`) : null,
              dry ? h('strong', '(simulación: no se ha guardado nada)') : h('strong', '✔ Importación completada')),
            r.errors.length ? h('ul.small', r.errors.slice(0, 200).map((e) => h('li', e))) : null));
          if (!dry) { load(); onCountsChanged && onCountsChanged(); importBtn2.disabled = true; }
        } catch (e) { toastErr(e); }
      };
      const importBtn2 = h('button.btn.primary', { onclick: () => run(false) }, 'Importar');
      clear(step,
        h('p', `${p.total} filas detectadas. Revisa a qué campo corresponde cada columna:`),
        h('div.table-wrap', h('table.map-table', h('thead', h('tr', h('th', 'Columna del fichero'), h('th', 'Ejemplo'), h('th', 'Campo destino'))),
          h('tbody', p.header.map((hd, i) => h('tr', h('td', h('strong', hd || `(col. ${i + 1})`)), h('td.muted.small', String(p.sample[0] ? p.sample[0][i] ?? '' : '').slice(0, 40)), h('td', sels[i])))))),
        h('div.two-col',
          meta.centers.length ? h('div.field', h('label', 'Centro por defecto (si no viene en el fichero)'), defCenter) : h('div'),
          h('div.field', h('label', '¿Actualizar registros existentes?'), matchSel)),
        result,
        h('div.row', h('button.btn', { onclick: step1 }, '← Volver'), h('div.spacer'), h('button.btn', { onclick: () => run(true) }, '🔍 Simular'), importBtn2));
    }
    step1();
  }

  await load();
}
