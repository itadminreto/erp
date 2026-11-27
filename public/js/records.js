// Vista de una aplicación: listado, formulario dinámico, papelera, historial, importación/exportación y envío de contraseñas.
import {
  api, h, clear, toast, toastErr, modal, confirmDlg, dropdown, fmtDate, fmtDateTime, debounce, download,
  genPassword, copy, sortable, ACTION_LABELS, state, ipMask, signaturePad, prepareImage, imageViewer, webcamPhoto, canUseWebcam,
  announce, pressable, a11yOn,
} from './core.js';
import { printDoc, docPdf, blobToBase64, esc } from './print.js';

const MASK = '••••••••';
const META_COLS = {
  _center: { key: '_center', label: 'Centro', sortKey: 'center' },
  _num: { key: '_num', label: 'Nº', sortKey: 'number' },
  _updated_at: { key: '_updated_at', label: 'Modificado', sortKey: 'updated_at' },
  _created_at: { key: '_created_at', label: 'Creado', sortKey: 'created_at' },
  _updated_by: { key: '_updated_by', label: 'Modificado por' },
};

export async function renderApp(root, key, onCountsChanged) {
  const meta = await api('/apps/' + key);
  const fieldsByKey = Object.fromEntries(meta.fields.map((f) => [f.key, f]));
  const usersById = { ...Object.fromEntries(Object.entries(meta.user_names || {}).map(([id, name]) => [id, { id: Number(id), name }])), ...Object.fromEntries(meta.users.map((u) => [u.id, u])) };
  const P = meta.perms;
  const st = { q: '', center: '', trash: false, sort: '', dir: 'desc', page: 1, size: 50, selected: new Set(), rows: [], total: 0, filters: {}, state: '', mine: false, overdue: false, view: 'list', calMonth: '', calField: '', colorField: '' };
  const persistKey = `view:${key}`;
  try { Object.assign(st, JSON.parse(sessionStorage.getItem(persistKey) || '{}'), { selected: new Set(), page: 1 }); } catch { /* sin estado previo */ }
  if (!P.view_trash) st.trash = false;
  const saveSt = () => { try { sessionStorage.setItem(persistKey, JSON.stringify({ q: st.q, center: st.center, trash: st.trash, sort: st.sort, dir: st.dir, size: st.size, filters: st.filters, state: st.state, mine: st.mine, overdue: st.overdue, view: st.view, calMonth: st.calMonth, calField: st.calField, colorField: st.colorField })); } catch { /* ignorar */ } };

  // ----- calendario: campos de fecha y de color disponibles -----
  const dateFields = meta.app.calendar ? meta.fields.filter((f) => ['date', 'datetime'].includes(f.type)) : [];
  const colorFields = meta.fields.filter((f) => f.type === 'select' && (f.options.choices || []).length);
  if (!dateFields.some((f) => f.key === st.calField)) st.calField = (dateFields.find((f) => /limite|vencim|proxim|fecha/.test(f.key)) || dateFields[0] || {}).key || '';
  if (st.colorField !== '-' && !colorFields.some((f) => f.key === st.colorField)) st.colorField = (colorFields.find((f) => f.key === 'prioridad') || colorFields.find((f) => f.key === 'estado') || colorFields[0] || {}).key || '-';
  if (!dateFields.length) st.view = 'list';
  if (!/^\d{4}-\d{2}$/.test(st.calMonth)) st.calMonth = new Date().toISOString().slice(0, 7);

  // ----- colores, estado (abierto/cerrado) y vencimientos -----
  const PALETTE = ['#10b981', '#0ea5e9', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];
  const closedVals = (meta.closed_values || []).map((x) => String(x).toLowerCase());
  const OPEN_COLORS = ['#f59e0b', '#0ea5e9', '#8b5cf6', '#ec4899', '#14b8a6'], CLOSED_COLORS = ['#10b981', '#94a3b8', '#64748b'];
  /** Color de una opción: en el campo de estado, abiertos en ámbar/azul y cerrados en verde/gris; en el resto, por orden. */
  function choiceColor(f, v) {
    const choices = f.options.choices || [];
    if (f.key === meta.app.status_field && closedVals.length) {
      const closedList = choices.filter((c) => closedVals.includes(c.toLowerCase())), openList = choices.filter((c) => !closedVals.includes(c.toLowerCase()));
      const ci = closedList.indexOf(v); if (ci >= 0) return CLOSED_COLORS[ci % CLOSED_COLORS.length];
      const oi = openList.indexOf(v); if (oi >= 0) return OPEN_COLORS[oi % OPEN_COLORS.length];
      return '#94a3b8';
    }
    const i = choices.indexOf(v); return i < 0 ? '#94a3b8' : PALETTE[i % PALETTE.length];
  }
  const hasStatus = !!(meta.app.status_field && fieldsByKey[meta.app.status_field] && closedVals.length);
  const groupsById = Object.fromEntries((meta.groups || []).map((g) => [g.id, g]));
  const groupFields = meta.fields.filter((f) => f.type === 'group');
  const centerById = Object.fromEntries(meta.centers.map((c) => [c.id, c]));
  /** Nombre del grupo (con la sede si el usuario ve varias). */
  const groupLabel = (g) => (g ? `${g.name}${meta.centers.length > 1 && centerById[g.center_id] ? ` (${centerById[g.center_id].code || centerById[g.center_id].name})` : ''}` : '');
  const hasOwner = !!(meta.app.owner_field && fieldsByKey[meta.app.owner_field]) || groupFields.length > 0;
  const isClosed = (r) => hasStatus && closedVals.includes(String(r.data[meta.app.status_field] || '').toLowerCase());
  const todayISO = () => new Date().toISOString().slice(0, 10);
  /** 'over' si la fecha ya pasó, 'soon' si vence en 3 días o menos (solo campos con aviso y registros abiertos). */
  function dueState(r, f) {
    const v = String(r.data[f.key] || '').slice(0, 10);
    if (!v || !f.options.due_alert || isClosed(r) || r.deleted_at) return '';
    const days = Math.round((new Date(v) - new Date(todayISO())) / 864e5);
    return days < 0 ? 'over' : days <= 3 ? 'soon' : '';
  }

  // ----- columnas (diseño por usuario) -----
  const defaultCols = () => ['_num', '_center', ...meta.fields.filter((f) => f.show_in_list).map((f) => f.key), '_updated_at'];
  const allColKeys = () => ['_num', '_center', ...meta.fields.map((f) => f.key), '_created_at', '_updated_at', '_updated_by'];
  let columns = (meta.layouts.list && meta.layouts.list.columns) || defaultCols();
  columns = columns.map((c) => (c === '_id' ? '_num' : c)).filter((c) => META_COLS[c] || fieldsByKey[c]);
  const colDef = (c) => META_COLS[c] || { key: c, label: fieldsByKey[c].label, sortKey: fieldsByKey[c].type === 'password' ? null : c, field: fieldsByKey[c] };
  const saveColumns = () => api(`/apps/${key}/layout/list`, { method: 'PUT', body: { columns } }).catch(toastErr);

  // ----- estructura -----
  const titleEl = h('div.title',
    h('div.app-ico', { style: { background: meta.app.color + '22', color: meta.app.color } }, meta.app.icon || '📁'),
    h('div', h('h1', meta.app.name), h('div.muted.small', meta.app.description || '')));
  const newBtn = P.create ? h('button.btn.primary', { onclick: () => openRecord(null) }, '＋ ', h('span.lbl', 'Nuevo')) : null;
  const searchInp = h('input', { type: 'search', placeholder: 'Buscar…', 'aria-label': `Buscar en ${meta.app.name} (también por Nº)`, value: st.q, oninput: debounce((e) => { st.q = e.target.value; st.page = 1; load(); }, 300) });
  // el filtro guardado solo vale si el centro sigue siendo visible para este usuario
  if (st.center && st.center !== 'none' && !meta.centers.some((c) => String(c.id) === String(st.center))) st.center = '';
  if (st.center === 'none' && !meta.can_view_without_center) st.center = '';
  const centerSel = h('select', { 'aria-label': 'Filtrar por centro', style: { width: 'auto', maxWidth: '220px' }, onchange: (e) => { st.center = e.target.value; st.page = 1; load(); } },
    h('option', { value: '' }, 'Todos los centros'),
    meta.centers.map((c) => h('option', { value: c.id, selected: String(st.center) === String(c.id) }, `${c.code ? c.code + ' · ' : ''}${c.name}`)),
    meta.can_view_without_center ? h('option', { value: 'none', selected: st.center === 'none' }, '(Sin centro)') : null);
  const trashCb = h('input', { type: 'checkbox', checked: st.trash, onchange: (e) => { st.trash = e.target.checked; st.page = 1; trashLbl.classList.toggle('on', st.trash); load(); } });
  const trashLbl = h('label.check.trash-toggle', { class: st.trash ? 'on' : '', title: 'Mostrar también los registros borrados (en rojo)' }, trashCb, '🗑️', h('span.lbl', ' Ver papelera'));

  const exportMenu = P.export ? dropdown(h('button.btn', '⬇ ', h('span.lbl', 'Exportar')), [
    { label: '📊 Excel (.xlsx) — vista actual', onclick: () => doExport('xlsx') },
    { label: '📄 CSV — vista actual', onclick: () => doExport('csv') },
    P.view_passwords ? '-' : null,
    P.view_passwords ? { label: '🔐 Excel con contraseñas', onclick: () => doExport('xlsx', true) } : null,
  ]) : null;
  const importBtn = P.import ? h('button.btn', { onclick: () => openImport() }, '⬆ ', h('span.lbl', 'Importar')) : null;
  const colsBtn = h('button.btn', { title: 'Columnas', onclick: () => openColumns() }, '☰ ', h('span.lbl', 'Columnas'));
  const printBtn = h('button.btn', { title: 'Imprimir', onclick: () => (st.view === 'calendar' ? printCalendar() : printList()) }, '🖨 ', h('span.lbl', 'Imprimir'));
  const viewBtns = dateFields.length ? h('div.seg', { role: 'group', 'aria-label': 'Vista' },
    h('button', { class: st.view === 'list' ? 'on' : '', onclick: () => setView('list') }, '☰ Lista'),
    h('button', { class: st.view === 'calendar' ? 'on' : '', onclick: () => setView('calendar') }, '📅 Calendario')) : null;
  function setView(v) {
    st.view = v; st.selected.clear();
    [...viewBtns.children].forEach((b, i) => b.classList.toggle('on', (i === 0) === (v === 'list')));
    listCard.hidden = v !== 'list'; calCard.hidden = v !== 'calendar'; colsBtn.hidden = v !== 'list';
    trashLbl.hidden = v !== 'list';
    load();
  }

  // ----- filtros rápidos (abiertos/cerrados, míos) y panel de filtros -----
  const stateSeg = hasStatus ? h('div.seg', { title: 'Mostrar según el estado', role: 'group', 'aria-label': 'Mostrar según el estado' },
    [['open', 'Abiertos'], ['closed', 'Cerrados'], ['', 'Todos']].map(([v, l]) => h('button', { class: st.state === v ? 'on' : '', dataset: { v }, onclick: () => {
      st.state = v; st.page = 1; [...stateSeg.children].forEach((b) => b.classList.toggle('on', b.dataset.v === v)); load();
    } }, l))) : null;
  const mineBtn = hasOwner ? h('button.btn', { class: st.mine ? 'on-toggle' : '', title: [meta.app.owner_field && fieldsByKey[meta.app.owner_field] ? `asignados a mí en «${fieldsByKey[meta.app.owner_field].label}»` : '', groupFields.length ? 'asignados a mis grupos de trabajo' : ''].filter(Boolean).join(' o ').replace(/^./, (c) => 'Solo los ' + c), onclick: () => {
    st.mine = !st.mine; st.page = 1; mineBtn.classList.toggle('on-toggle', st.mine); load();
  } }, '👤 Míos') : null;
  const filterable = meta.fields.filter((f) => ['select', 'user', 'checkbox', 'group'].includes(f.type));
  // filtros por fecha: atajo (hoy, esta semana…) o rango; se guardan como <campo>__p, __from, __to
  const dateFilterable = meta.fields.filter((f) => ['date', 'datetime'].includes(f.type));
  const DATE_PRESETS = [['', '— Cualquier fecha —'], ['today', 'Hoy'], ['tomorrow', 'Mañana'], ['week', 'Esta semana'], ['next7', 'Próximos 7 días'],
    ['month', 'Este mes'], ['future', 'De hoy en adelante'], ['past', 'Anteriores a hoy'], ['empty', 'Sin fecha'], ['range', 'Entre dos fechas…']];
  const isoD = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function presetRange(p) {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const add = (n) => { const d = new Date(t); d.setDate(d.getDate() + n); return isoD(d); };
    switch (p) {
      case 'today': return { from: add(0), to: add(0) };
      case 'tomorrow': return { from: add(1), to: add(1) };
      case 'week': { const dow = (t.getDay() + 6) % 7; return { from: add(-dow), to: add(6 - dow) }; }
      case 'next7': return { from: add(0), to: add(6) };
      case 'month': return { from: isoD(new Date(t.getFullYear(), t.getMonth(), 1)), to: isoD(new Date(t.getFullYear(), t.getMonth() + 1, 0)) };
      case 'future': return { from: add(0) };
      case 'past': return { to: add(-1) };
      case 'empty': return { empty: '1' };
      default: return {};
    }
  }
  /** Pasa los filtros a la URL (los atajos de fecha se calculan en el momento: «Hoy» siempre es hoy). */
  function appendFilters(qs) {
    for (const [k, v] of Object.entries(st.filters)) {
      if (v === '' || v === undefined) continue;
      const m = k.match(/^(.+)__(p|from|to)$/);
      if (!m) { qs.set('f_' + k, v); continue; }
      if (m[2] !== 'p') continue;
      const r = v === 'range' ? { from: st.filters[m[1] + '__from'], to: st.filters[m[1] + '__to'] } : presetRange(v);
      for (const [rk, rv] of Object.entries(r)) if (rv) qs.set(`f_${m[1]}__${rk}`, rv);
    }
  }
  const presetText = (key) => {
    const p = st.filters[key + '__p'];
    if (p !== 'range') return (DATE_PRESETS.find((x) => x[0] === p) || [, p])[1];
    const f = st.filters[key + '__from'], t = st.filters[key + '__to'];
    return f && t ? `${fmtDate(f)} – ${fmtDate(t)}` : f ? `desde ${fmtDate(f)}` : t ? `hasta ${fmtDate(t)}` : 'cualquiera';
  };
  const filterBtn = filterable.length || dateFilterable.length ? h('button.btn', { onclick: () => openFilters() }, '⚲ ', h('span.lbl', 'Filtros'), h('span.badge', { hidden: true })) : null;
  const activeBar = h('div.active-filters');
  const filterText = (k, v) => { const f = fieldsByKey[k]; if (!f) return v; return f.type === 'user' ? (usersById[v] ? usersById[v].name : v) : f.type === 'group' ? groupLabel(groupsById[v]) || v : f.type === 'checkbox' ? (v === '1' ? 'Sí' : 'No') : v; };
  function drawActiveFilters() {
    const act = Object.entries(st.filters).filter(([k, v]) => v !== '' && fieldsByKey[k]);
    const dact = dateFilterable.filter((f) => st.filters[f.key + '__p']);
    const removeDate = (f) => { for (const x of ['__p', '__from', '__to']) delete st.filters[f.key + x]; st.page = 1; drawActiveFilters(); load(); };
    if (filterBtn) { const bd = filterBtn.querySelector('.badge'); bd.hidden = !(act.length + dact.length); bd.textContent = act.length + dact.length; }
    clear(activeBar, st.overdue ? h('span.chip.filter-chip', '⚠ Solo vencidos', h('button', { title: 'Quitar filtro', 'aria-label': 'Quitar filtro: solo vencidos', onclick: () => { st.overdue = false; st.page = 1; drawActiveFilters(); load(); } }, '✕')) : null,
      act.map(([k, v]) => h('span.chip.filter-chip', `${fieldsByKey[k].label}: ${filterText(k, v)}`,
      h('button', { title: 'Quitar filtro', 'aria-label': `Quitar filtro ${fieldsByKey[k].label}: ${filterText(k, v)}`, onclick: () => { delete st.filters[k]; st.page = 1; drawActiveFilters(); load(); } }, '✕'))),
    dact.map((f) => h('span.chip.filter-chip', `📅 ${f.label}: ${presetText(f.key)}`,
      h('button', { title: 'Quitar filtro', 'aria-label': `Quitar filtro ${f.label}: ${presetText(f.key)}`, onclick: () => removeDate(f) }, '✕'))),
    act.length + dact.length > 1 ? h('button.btn.sm.ghost', { onclick: () => { st.filters = {}; st.page = 1; drawActiveFilters(); load(); } }, 'Quitar todos') : null);
  }
  function openFilters() {
    const sels = {};
    const content = h('div.two-col', filterable.map((f) => {
      const cur = st.filters[f.key] ?? '';
      const opts = f.type === 'select' ? (f.options.choices || []).map((c) => [c, c])
        : f.type === 'user' ? meta.users.map((u) => [String(u.id), u.name])
        : f.type === 'group' ? (meta.groups || []).map((g) => [String(g.id), groupLabel(g) + (g.mine ? ' · mi grupo' : '')]) : [['1', 'Sí'], ['0', 'No']];
      sels[f.key] = h('select', h('option', { value: '' }, '— Cualquiera —'), opts.map(([v, l]) => h('option', { value: v, selected: String(cur) === v }, l)));
      sels[f.key].id = 'ff-' + f.key;
      return h('div.field', h('label', { for: sels[f.key].id }, f.label), sels[f.key]);
    }));
    // filtros por fecha
    const dsel = {};
    for (const f of dateFilterable) {
      const p = h('select', DATE_PRESETS.map(([v, l]) => h('option', { value: v, selected: (st.filters[f.key + '__p'] || '') === v }, l)));
      const from = h('input', { type: 'date', value: st.filters[f.key + '__from'] || '', 'aria-label': `${f.label}: desde` });
      const to = h('input', { type: 'date', value: st.filters[f.key + '__to'] || '', 'aria-label': `${f.label}: hasta` });
      const range = h('div.row', { style: { flexWrap: 'nowrap', gap: '6px', alignItems: 'center' } }, from, h('span.muted.small', 'a'), to);
      const sync = () => { range.hidden = p.value !== 'range'; };
      p.addEventListener('change', () => { sync(); if (p.value === 'range') from.focus(); });
      sync();
      dsel[f.key] = { p, from, to };
      p.id = 'df-' + f.key;
      content.append(h('div.field', { style: { gridColumn: '1 / -1' } }, h('label', { for: p.id }, `📅 ${f.label}`),
        h('div.date-filter', p, range)));
    }
    const m = modal({ title: '⚲ Filtros', size: '', content,
      footer: [h('button.btn.ghost', { onclick: () => { Object.values(sels).forEach((x) => { x.value = ''; }); Object.values(dsel).forEach((x) => { x.p.value = ''; x.p.dispatchEvent(new Event('change')); }); } }, 'Limpiar'), h('div.spacer'),
        h('button.btn', { onclick: () => m.close() }, 'Cancelar'),
        h('button.btn.primary', { onclick: () => {
          st.filters = Object.fromEntries(Object.entries(sels).map(([k, x]) => [k, x.value]).filter(([, v]) => v !== ''));
          for (const [k, x] of Object.entries(dsel)) {
            if (!x.p.value) continue;
            if (x.p.value === 'range' && !x.from.value && !x.to.value) continue;
            st.filters[k + '__p'] = x.p.value;
            if (x.p.value === 'range') { if (x.from.value) st.filters[k + '__from'] = x.from.value; if (x.to.value) st.filters[k + '__to'] = x.to.value; }
          }
          st.page = 1; drawActiveFilters(); m.close(); load();
        } }, 'Aplicar')] });
  }
  // menú «⋯» para el móvil (importar, exportar, imprimir)
  const moreMenu = dropdown(h('button.btn', { title: 'Más acciones' }, '⋯'), [
    P.import ? { label: '⬆ Importar', onclick: () => openImport() } : null,
    P.export ? { label: '📊 Exportar a Excel', onclick: () => doExport('xlsx') } : null,
    P.export ? { label: '📄 Exportar a CSV', onclick: () => doExport('csv') } : null,
    { label: '🖨 Imprimir', onclick: () => (st.view === 'calendar' ? printCalendar() : printList()) },
  ]);

  const bulkBar = h('div.bulkbar', { hidden: true });
  const tableWrap = h('div.table-wrap.desktop-only');
  const mobileList = h('div.mobile-list');
  const pager = h('div.pager');
  const listCard = h('div.card', { hidden: st.view !== 'list' }, tableWrap, h('div.mobile-only', { style: { padding: '10px' } }, mobileList), pager);
  const calCard = h('div.card.cal-card', { hidden: st.view !== 'calendar' });
  colsBtn.hidden = st.view !== 'list'; trashLbl.hidden = st.view !== 'list';

  clear(root,
    h('div.page-head', titleEl, h('div.btn-group', h('div.btn-group.desktop-only', importBtn, exportMenu, printBtn), h('div.mobile-only', moreMenu), newBtn)),
    h('div.toolbar', h('div.search', searchInp), meta.centers.length ? centerSel : null, stateSeg, mineBtn, filterBtn, P.view_trash ? trashLbl : null, h('div.spacer'), viewBtns, colsBtn),
    activeBar, bulkBar, listCard, calCard);
  drawActiveFilters();

  // ----- carga -----
  async function load() {
    saveSt();
    if (st.view === 'calendar') return loadCalendar();
    const qs = new URLSearchParams({ page: st.page, size: st.size });
    if (st.q) qs.set('q', st.q);
    if (st.center) qs.set('center', st.center);
    if (st.trash) qs.set('trash', '1');
    if (st.sort) { qs.set('sort', st.sort); qs.set('dir', st.dir); }
    appendFilters(qs);
    if (st.state) qs.set('state', st.state);
    if (st.mine) qs.set('mine', '1');
    if (st.overdue) qs.set('overdue', '1');
    try {
      const r = await api(`/apps/${key}/records?${qs}`);
      st.rows = r.rows; st.total = r.total;
      draw();
      announce(`${st.total} registro${st.total === 1 ? '' : 's'}${pagesCount() > 1 ? `, página ${st.page} de ${pagesCount()}` : ''}`);
    } catch (e) { toastErr(e); }
  }

  const pagesCount = () => Math.max(1, Math.ceil(st.total / st.size));
  function cellText(r, c) {
    const f = fieldsByKey[c];
    if (f && f.type === 'date') return fmtDate(r.data[c]);
    if (f && f.type === 'password') return r.data[c] ? '••••••' : '';
    if (f && f.type === 'signature') return r.data[c] && (r.data[c].signed || r.data[c].img) ? `Firmado ${fmtDateTime(r.data[c].at)}` : '';
    if (f && f.type === 'image') { const n = Array.isArray(r.data[c]) ? r.data[c].length : (r.data[c] && r.data[c].count) || 0; return n ? `${n} imagen${n > 1 ? 'es' : ''}` : ''; }
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
    appendFilters(qs);
    if (st.state) qs.set('state', st.state);
    if (st.mine) qs.set('mine', '1');
    if (st.overdue) qs.set('overdue', '1');
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
  /** Parte / ficha imprimible: cabecera con empresa y Nº, campos en recuadros según el diseño y casillas de firma. */
  function printRecord(rec) { printDoc(parteDoc(rec)); }
  const parteFilename = (rec) => `${meta.app.name}_${rec.number}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_') + '.pdf';
  /** Descarga el parte en PDF (idéntico al impreso). */
  async function downloadPdf(rec) {
    toast('Generando PDF…');
    try {
      const blob = await docPdf(parteDoc(rec));
      const a = h('a', { href: URL.createObjectURL(blob), download: parteFilename(rec) });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { toastErr(e); }
  }
  function parteDoc(rec) {
    const company = (state.me.companies || []).find((c) => c.id === state.companyId) || {};
    const SPAN = { xs: 2, sm: 3, md: 4, lg: 6, xl: 8, full: 12, half: 4, third: 3 };
    const sigFields = meta.fields.filter((f) => f.type === 'signature');
    const box = (label, value, span, rows = 1) => `<div class="box s${span}"${rows > 1 ? ` style="min-height:${11 * rows}mm"` : ''}>
      <div class="l">${esc(label)}</div><div class="v${value ? '' : ' nil'}">${value ? esc(value) : '—'}</div></div>`;
    let html = '';
    const groups = formGroups().groups;
    groups.forEach((g, gi) => {
      const keys = g.keys.filter((k) => fieldsByKey[k] && fieldsByKey[k].type !== 'signature' && !(k === meta.app.title_field && rec.data[k])); // el título ya va en la cabecera
      if (!keys.length && !(gi === 0)) return;
      let inner = gi === 0 && meta.centers.length
        ? box('Centro', rec.center_name ? `${rec.center_code ? rec.center_code + ' · ' : ''}${rec.center_name}` : '', 4) : '';
      for (const k of keys) {
        const f = fieldsByKey[k];
        const span = f.type === 'textarea' && !SPAN[f.width] ? 12 : (SPAN[f.width] || 4);
        if (f.type === 'image') {
          const imgs = Array.isArray(rec.data[k]) ? rec.data[k] : [];
          inner += `<div class="box s${span}"><div class="l">${esc(f.label)}</div>${imgs.length
            ? `<div class="pics">${imgs.map((x) => `<img src="/api/apps/${esc(key)}/records/${rec.id}/files/${x.id}" alt="">`).join('')}</div>`
            : '<div class="v nil">—</div>'}</div>`;
          continue;
        }
        inner += box(f.label, cellText(rec, k), span, ['textarea', 'multiselect'].includes(f.type) ? (f.height || 1) + (f.type === 'textarea' ? 1 : 0) : 1);
      }
      if (inner) html += `<div class="sec">${g.title ? `<div class="sec-h">${esc(g.title)}</div>` : ''}<div class="grid">${inner}</div></div>`;
    });
    // firmas: los campos «Firma» de la app; en Recados, si no hay ninguno, casillas en blanco para firmar a mano
    let sigs = sigFields.map((f) => {
      const v = rec.data[f.key];
      return `<div class="sig"><div class="l">${esc(f.label)}</div><div class="im">${v && v.img ? `<img src="${esc(v.img)}" alt="">` : ''}</div>
        <div class="d">${v && v.at ? 'Firmado el ' + esc(fmtDateTime(v.at)) : 'Fecha:'}</div></div>`;
    }).join('');
    if (!sigFields.length && key === 'recados') sigs = ['Entregado por', 'Recibido por', 'Realizado (fecha y firma)'].map((l) => `<div class="sig"><div class="l">${l}</div><div class="im"></div><div class="d">Nombre y fecha:</div></div>`).join('');
    const titleVal = rec.data[meta.app.title_field];
    const body = `<div class="doc" style="--accent:${esc(meta.app.color || '#334155')}">
      <div class="doc-head">
        <div class="doc-company">${company.has_logo ? `<img src="/api/companies/${company.id}/logo" alt="">` : ''}
          <div><div class="nm">${esc(company.name || '')}</div>
          <div class="dt">${[company.cif ? 'CIF ' + company.cif : '', company.address, [company.phone, company.email].filter(Boolean).join(' · ')].filter(Boolean).map(esc).join('<br>')}</div></div></div>
        <div class="doc-id"><div class="ty">${esc(meta.app.name)}</div><div class="no">Nº ${esc(rec.number)}</div>
          <div class="dd">Fecha: ${esc(fmtDate(String(rec.created_at).slice(0, 10)))}</div></div>
      </div>
      ${titleVal ? `<div class="doc-title">${esc(cellText(rec, meta.app.title_field))}${rec.deleted_at ? '<span class="stamp">ANULADO</span>' : ''}</div>` : ''}
      <div class="doc-sub">Creado el ${esc(fmtDateTime(rec.created_at))}${rec.created_by_name ? ' por ' + esc(rec.created_by_name) : ''}${rec.updated_at !== rec.created_at ? ` · Última modificación ${esc(fmtDateTime(rec.updated_at))}` : ''}</div>
      ${html}
      ${sigs ? `<div class="sigs">${sigs}</div>` : ''}
      <div class="doc-foot"><span>${esc(company.name || '')} · ${esc(meta.app.name)} Nº ${esc(rec.number)}</span><span>Impreso el ${esc(fmtDateTime(new Date().toISOString()))} por ${esc(state.me.name)}</span></div>
    </div>`;
    return { title: `${meta.app.name} Nº ${rec.number}`, bodyHtml: body, bare: true };
  }

  // ----- calendario -----

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
    return choiceColor(fieldsByKey[st.colorField], r.data[st.colorField]);
  }
  const titleOf = (r) => String(r.data[meta.app.title_field] || `Nº ${r.number}`);
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
    const chip = (r) => h('button.cal-ev', { class: [isClosed(r) ? 'closed' : '', fieldsByKey[st.calField] && dueState(r, fieldsByKey[st.calField]) === 'over' ? 'over' : ''].join(' '),
      style: { '--c': colorOf(r) }, title: titleOf(r), onclick: (e) => { e.stopPropagation(); openRecord(r); } }, titleOf(r));
    const MAX = 3;
    const grid = h('div.cal-grid',
      DOW.map((d) => h('div.cal-dow', d)),
      days.map((d) => {
        const k = iso(d); const list = map[k] || [];
        return h('div.cal-day', {
          role: 'group', 'aria-label': `${d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}${k === today ? ', hoy' : ''}: ${list.length ? list.length + ' elemento' + (list.length === 1 ? '' : 's') : 'nada'}`,
          class: [d.getMonth() !== m - 1 ? 'out' : '', k === today ? 'today' : '', d.getDay() % 6 === 0 ? 'we' : ''].join(' '),
          title: P.create ? 'Doble clic para crear' : '',
          ondblclick: () => P.create && openRecord(null, { [st.calField]: st.calField && fieldsByKey[st.calField].type === 'datetime' ? k + 'T09:00' : k }),
        }, h('div.cal-num', { 'aria-hidden': 'true' }, d.getDate()),
        list.slice(0, MAX).map(chip),
        list.length > MAX ? h('button.cal-more', { onclick: () => openDay(k, list) }, `+${list.length - MAX} más`) : null);
      }));
    // vista agenda (móvil)
    const daysWith = days.filter((d) => d.getMonth() === m - 1 && map[iso(d)]);
    const agenda = h('div.cal-agenda', daysWith.length ? daysWith.map((d) => h('div.cal-agenda-day',
      h('div.cal-agenda-date', { class: iso(d) === today ? 'today' : '' }, d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })),
      h('div', map[iso(d)].map(chip)))) : h('div.empty', 'Nada este mes'));
    const legend = st.colorField !== '-' ? h('div.cal-legend', (fieldsByKey[st.colorField].options.choices || []).map((c, i) => h('span', { style: { '--c': choiceColor(fieldsByKey[st.colorField], c) } }, c))) : null;
    clear(calCard,
      h('div.cal-head',
        h('div.row', h('button.btn.sm', { 'aria-label': 'Mes anterior', onclick: () => shift(-1) }, '‹'), h('button.btn.sm', { onclick: () => { st.calMonth = today.slice(0, 7); load(); } }, 'Hoy'), h('button.btn.sm', { 'aria-label': 'Mes siguiente', onclick: () => shift(1) }, '›'),
          h('h2.cal-title', { 'aria-live': 'polite' }, monthName)),
        h('div.row', h('label.small.muted', { for: (dateSel.id = 'cal-date-sel') }, 'Fecha'), dateSel, colorFields.length ? [h('label.small.muted', { for: (colorSel.id = 'cal-color-sel') }, 'Color'), colorSel] : null)),
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
      ${st.colorField !== '-' ? `<div class="legend">${(fieldsByKey[st.colorField].options.choices || []).map((c, i) => `<span style="--c:${choiceColor(fieldsByKey[st.colorField], c)}">${esc(c)}</span>`).join('')}</div>` : ''}`;
    const title = `${meta.app.name} · ${new Date(y, m - 1, 1).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })}`;
    printDoc({ title, subtitle: [fieldsByKey[st.calField].label, filterSummary()].filter(Boolean).join(' · '), bodyHtml: body, landscape: true });
  }

  function cellValue(r, c, { reveal = true } = {}) {
    switch (c) {
      case '_center': return r.center_code || r.center_name || '—';
      case '_num': return h('strong.num', String(r.number ?? ''));
      case '_updated_at': return fmtDateTime(r.updated_at);
      case '_created_at': return fmtDateTime(r.created_at);
      case '_updated_by': return r.updated_by_name || '';
    }
    const f = fieldsByKey[c]; const v = r.data[c];
    if (v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length)) return '';
    switch (f.type) {
      case 'password': {
        const span = h('span.pw-mask', { role: 'img', 'aria-label': 'Contraseña oculta' }, MASK);
        if (!reveal || !r.can.view_passwords) return span;
        return h('span', span, ' ', h('button.btn.ghost.sm', { title: 'Mostrar', onclick: async (e) => {
          e.stopPropagation();
          try { const { value } = await api(`/apps/${key}/records/${r.id}/password/${c}`); span.textContent = value; span.classList.remove('pw-mask'); span.removeAttribute('role'); span.removeAttribute('aria-label'); e.target.replaceWith(h('button.btn.ghost.sm', { title: 'Copiar', onclick: (ev) => { ev.stopPropagation(); copy(value); } }, '📋')); } catch (err) { toastErr(err); }
        } }, '👁'));
      }
      case 'date': { const d = dueState(r, f); return d ? h('span.due', { class: d, title: d === 'over' ? 'Vencido' : 'Vence pronto' }, d === 'over' ? h('span', { 'aria-hidden': 'true' }, '⚠ ') : '', fmtDate(v), h('span.sr-only', d === 'over' ? ' (vencido)' : ' (vence pronto)')) : fmtDate(v); }
      case 'datetime': return fmtDateTime(v);
      case 'checkbox': return v ? '✔ Sí' : 'No';
      case 'user': return usersById[v] ? usersById[v].name : `#${v}`;
      case 'group': return groupsById[v] ? groupLabel(groupsById[v]) : `Grupo #${v}`;
      case 'multiselect': return v.join(', ');
      case 'select': return h('span.chip.opt', { style: { '--c': choiceColor(f, v) } }, v);
      case 'url': return h('a', { href: v, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, v.replace(/^https?:\/\//, ''));
      case 'email': return h('a', { href: 'mailto:' + v, onclick: (e) => e.stopPropagation() }, v);
      case 'phone': return h('a', { href: 'tel:' + v, onclick: (e) => e.stopPropagation() }, v);
      case 'color': return h('span.chip', h('span', { style: { width: '12px', height: '12px', borderRadius: '3px', background: v, display: 'inline-block' } }), v);
      case 'decimal': return Number(v).toLocaleString('es-ES', { maximumFractionDigits: 2 });
      case 'iban': return h('span.mono', String(v).replace(/(.{4})/g, '$1 ').trim());
      case 'ip': return h('span.mono', v);
      case 'signature': return v && (v.signed || v.img) ? h('span.chip.ok', '✍ Firmado') : '';
      case 'image': { const n = Array.isArray(v) ? v.length : (v && v.count) || 0; return n ? h('span.chip', `🖼 ${n}`) : ''; }
      default: return String(v);
    }
  }

  function draw() {
    // el foco de teclado se conserva al repintar (p. ej. tras guardar, ordenar o cambiar de página)
    const act = document.activeElement;
    const keepFocus = act && act !== document.body && (tableWrap.contains(act) || pager.contains(act)) ? (act.dataset.fk || 'first') : null;
    // tabla
    const cols = columns.map(colDef);
    const allSel = st.rows.length && st.rows.every((r) => st.selected.has(r.id));
    const headRow = h('tr',
      h('th.cb.nosort', h('input', { type: 'checkbox', 'aria-label': 'Seleccionar todos los de esta página', checked: !!allSel, onchange: (e) => { st.rows.forEach((r) => (e.target.checked ? st.selected.add(r.id) : st.selected.delete(r.id))); draw(); } })),
      cols.map((c) => {
        const sorted = st.sort && st.sort === c.sortKey;
        const sortBy = () => { if (st.sort === c.sortKey) st.dir = st.dir === 'asc' ? 'desc' : 'asc'; else { st.sort = c.sortKey; st.dir = 'asc'; } load(); };
        return h('th', {
          dataset: { col: c.key }, class: c.sortKey ? '' : 'nosort', title: 'Arrastra para mover la columna', scope: 'col',
          'aria-sort': sorted ? (st.dir === 'asc' ? 'ascending' : 'descending') : null,
          onclick: (e) => { if (!c.sortKey || e.target.closest('button')) return; sortBy(); },
        }, h('span.grip', '⋮⋮'),
        c.sortKey ? h('button.th-sort', { type: 'button', dataset: { fk: 'sort-' + c.key }, 'aria-label': `${c.label}: ordenar ${sorted && st.dir === 'asc' ? 'descendente' : 'ascendente'}`, onclick: sortBy }, c.label) : c.label,
        sorted ? h('span.sort', st.dir === 'asc' ? '▲' : '▼') : null);
      }),
      h('th.nosort', h('span.sr-only', 'Acciones')));
    const recName = (r) => `Nº ${r.number}${r.data[meta.app.title_field] ? ', ' + String(r.data[meta.app.title_field]) : ''}${r.deleted_at ? ' (en la papelera)' : isClosed(r) ? ' (cerrado)' : ''}`;
    const tbody = h('tbody', st.rows.map((r) => h('tr', { class: [r.deleted_at ? 'deleted' : '', isClosed(r) ? 'closed' : ''].join(' '), onclick: () => openRecord(r) },
      h('td.cb', { onclick: (e) => e.stopPropagation() }, h('input', { type: 'checkbox', dataset: { fk: 'sel-' + r.id }, 'aria-label': `Seleccionar ${recName(r)}`, checked: st.selected.has(r.id), onchange: (e) => { e.target.checked ? st.selected.add(r.id) : st.selected.delete(r.id); drawBulk(); } })),
      cols.map((c) => h('td', { class: c.key === meta.app.title_field ? 'wrap' : '', title: typeof cellValue(r, c.key, { reveal: false }) === 'string' ? cellValue(r, c.key) : '' }, cellValue(r, c.key))),
      h('td.actions', { onclick: (e) => e.stopPropagation() },
        a11yOn() ? h('button.btn.sm.ghost.sr-only-focusable', { type: 'button', dataset: { fk: 'open-' + r.id }, 'aria-label': `Abrir ${recName(r)}`, onclick: () => openRecord(r) }, 'Abrir') : null, rowActions(r)))));
    const table = h('table.data', h('caption.sr-only', `${meta.app.name}: ${st.total} registro${st.total === 1 ? '' : 's'}. Página ${st.page} de ${pagesCount()}.`), h('thead', headRow), tbody);
    clear(tableWrap, st.rows.length ? table : emptyState());
    sortable(headRow, {
      filter: '.cb, th:last-child', preventOnFilter: false, draggable: 'th[data-col]',
      onEnd: () => { columns = [...headRow.querySelectorAll('th[data-col]')].map((th) => th.dataset.col); saveColumns(); draw(); },
    });

    // tarjetas (móvil)
    const titleKey = meta.app.title_field || (meta.fields[0] && meta.fields[0].key);
    clear(mobileList, st.rows.length ? st.rows.map((r) => pressable(h('div.card.rec-card', { class: [r.deleted_at ? 'deleted' : '', isClosed(r) ? 'closed' : ''].join(' '), onclick: () => openRecord(r) },
      h('div.t', r.deleted_at ? '🗑️' : null, h('span.num', `${r.number}`), h('span', { style: { flex: 1 } }, String(r.data[titleKey] || '')), h('span.muted.small', r.center_code || r.center_name || '')),
      h('div.kv', columns.filter((c) => c !== titleKey && c !== '_center' && c !== '_num').slice(0, 5).map((c) => [h('span', colDef(c).label), h('span', cellValue(r, c, { reveal: false }) || '—')])),
      r.deleted_at && r.can.restore ? h('div', h('button.btn.sm.ok', { onclick: (e) => { e.stopPropagation(); restoreRec(r); } }, '↩ Restaurar')) : null,
    ), { role: r.deleted_at && r.can.restore ? null : 'button' })) : emptyState());

    // paginación
    const pages = Math.max(1, Math.ceil(st.total / st.size));
    clear(pager,
      h('span.muted.small', `${st.total} registro${st.total === 1 ? '' : 's'}`),
      h('select', { style: { width: 'auto' }, 'aria-label': 'Registros por página', onchange: (e) => { st.size = Number(e.target.value); st.page = 1; load(); } }, [25, 50, 100, 250].map((n) => h('option', { value: n, selected: n === st.size }, `${n} / pág.`))),
      h('button.btn.sm', { dataset: { fk: 'prev' }, 'aria-label': 'Página anterior', disabled: st.page <= 1, onclick: () => { st.page--; load(); } }, '‹'),
      h('span.small', `${st.page} / ${pages}`),
      h('button.btn.sm', { dataset: { fk: 'next' }, 'aria-label': 'Página siguiente', disabled: st.page >= pages, onclick: () => { st.page++; load(); } }, '›'));
    drawBulk();
    if (keepFocus) {
      const el = (tableWrap.querySelector(`[data-fk="${keepFocus}"]`) || pager.querySelector(`[data-fk="${keepFocus}"]:not(:disabled)`)
        || tableWrap.querySelector('[data-fk^="open-"]') || root.querySelector('h1'));
      if (el) { if (el.tagName === 'H1') el.tabIndex = -1; el.focus({ preventScroll: el.classList.contains('sr-only-focusable') }); }
    }
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
    appendFilters(qs);
    if (st.state) qs.set('state', st.state);
    if (st.mine) qs.set('mine', '1');
    if (st.overdue) qs.set('overdue', '1');
    if (passwords) qs.set('passwords', '1');
    if (ids) qs.set('ids', ids.join(','));
    download(`/apps/${key}/export?${qs}`, `${key}.${format}`);
  }

  // ----- columnas -----
  function openColumns() {
    const order = [...columns, ...allColKeys().filter((c) => !columns.includes(c))];
    const move = (item, dir) => {
      const sib = dir < 0 ? item.previousElementSibling : item.nextElementSibling;
      if (!sib) return;
      if (dir < 0) sib.before(item); else sib.after(item);
      item.querySelector(dir < 0 ? '.up' : '.down').focus();
      announce(`${colDef(item.dataset.col).label}: posición ${[...list.children].indexOf(item) + 1} de ${list.children.length}`);
    };
    const list = h('div.sort-list', order.map((c) => h('div.sort-item', { dataset: { col: c } },
      h('span.grip', '⋮⋮'), h('label.check.grow', h('input', { type: 'checkbox', checked: columns.includes(c) }), colDef(c).label),
      a11yOn() ? h('button.btn.ghost.sm.up', { type: 'button', 'aria-label': `Subir ${colDef(c).label}`, title: 'Subir', onclick: (e) => move(e.currentTarget.parentElement, -1) }, '▲') : null,
      a11yOn() ? h('button.btn.ghost.sm.down', { type: 'button', 'aria-label': `Bajar ${colDef(c).label}`, title: 'Bajar', onclick: (e) => move(e.currentTarget.parentElement, 1) }, '▼') : null)));
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
  const buttonsById = {}; // botones de acción del diseño ('btn:id' → configuración)
  function formGroups() {
    let layout = {};
    try { layout = meta.app.form_layout ? JSON.parse(meta.app.form_layout) : {}; } catch { layout = {}; }
    const groups = [{ title: null, keys: [] }];
    const seen = new Set();
    for (const k of Object.keys(buttonsById)) delete buttonsById[k];
    for (const it of Array.isArray(layout.items) ? layout.items : []) {
      if (it && typeof it === 'object' && it.button) { const k = 'btn:' + it.button.id; buttonsById[k] = it.button; groups[groups.length - 1].keys.push(k); }
      else if (it && typeof it === 'object' && 'section' in it) groups.push({ title: String(it.section || 'Sección'), keys: [] });
      else if (typeof it === 'string' && fieldsByKey[it] && !seen.has(it)) { groups[groups.length - 1].keys.push(it); seen.add(it); }
    }
    groups[groups.length - 1].keys.push(...meta.fields.map((f) => f.key).filter((k) => !seen.has(k))); // campos nuevos, al final
    const uo = meta.layouts.form && meta.layouts.form.order;
    if (Array.isArray(uo)) {
      const idx = Object.fromEntries(uo.map((k, i) => [k, i]));
      for (const g of groups) {
        // el orden personal solo mueve campos; los botones conservan su posición del diseño
        const btnPos = g.keys.map((k, i) => [k, i]).filter(([k]) => k.startsWith('btn:'));
        const fieldsOnly = g.keys.filter((k) => !k.startsWith('btn:')).map((k, i) => [k, idx[k] ?? 1e6 + i]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
        for (const [k, i] of btnPos) fieldsOnly.splice(Math.min(i, fieldsOnly.length), 0, k);
        g.keys = fieldsOnly;
      }
    }
    return { groups: groups.filter((g) => g.keys.length), tabs: !!layout.tabs, labelSize: layout.label_size, inputSize: layout.input_size };
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
    const groupSelects = []; // campos «Grupo de trabajo»: solo los grupos de la sede elegida
    for (const f of meta.fields) fieldEls[f.key] = buildField(f);
    const fillGroups = () => {
      const cid = Number(centerSelect.value) || null;
      for (const sel of groupSelects) {
        const cur = sel.value || sel.dataset.current;
        const list = (meta.groups || []).filter((g) => (!cid || g.center_id === cid) && (g.active || String(g.id) === String(cur)));
        clear(sel, h('option', { value: '' }, list.length ? '—' : cid ? '— Esta sede no tiene grupos —' : '—'),
          list.map((g) => h('option', { value: g.id, selected: String(g.id) === String(cur) }, (cid ? g.name : groupLabel(g)) + (g.mine ? ' · mi grupo' : ''))));
        if (cur && !list.some((g) => String(g.id) === String(cur))) { sel.value = ''; if (sel.dataset.current) toast('El grupo de trabajo no es de la sede elegida: elige otro', 'error'); }
        sel.dataset.current = '';
      }
    };
    fillGroups();
    centerSelect.addEventListener('change', fillGroups);
    // al elegir un grupo sin sede, se pone la sede del grupo
    for (const sel of groupSelects) sel.addEventListener('change', () => {
      const g = groupsById[sel.value];
      if (g && !centerSelect.value && [...centerSelect.options].some((o) => o.value === String(g.center_id))) {
        centerSelect.value = String(g.center_id); fillGroups(); sel.value = String(g.id);
        toast(`Sede: ${centerById[g.center_id] ? centerById[g.center_id].name : ''}`, 'ok');
      }
    });
    let saveRef = null; // botón Guardar (lo usan los botones de acción «rellenar y guardar»)
    formGroups(); // carga los botones del diseño en buttonsById
    for (const [bk, b] of Object.entries(buttonsById)) fieldEls[bk] = buildActionButton(b);

    // ----- botones de acción configurados en el diseñador -----
    function valueOf(k, readable = false) {
      const f = fieldsByKey[k]; const i = inputs[k];
      if (!f || !i) return '';
      if (f.type === 'checkbox') return i.checked ? (readable ? 'Sí' : '1') : '';
      if (f.type === 'multiselect') return [...i.selectedOptions].map((o) => o.value).join(', ');
      if (f.type === 'image') { const n = i.value.length; return n ? String(n) : ''; }
      if (f.type === 'user' && readable) return usersById[i.value] ? usersById[i.value].name : '';
      if (f.type === 'group' && readable) return groupsById[i.value] ? groupsById[i.value].name : '';
      return i.value ?? '';
    }
    const today = () => new Date().toISOString().slice(0, 10);
    function token(v, f) {
      const t = String(v ?? '').trim();
      if (t === '{hoy}') return f && f.type === 'datetime' ? `${today()}T${new Date().toTimeString().slice(0, 5)}` : today();
      if (t === '{ahora}') return f && f.type === 'date' ? today() : `${today()}T${new Date().toTimeString().slice(0, 5)}`;
      if (t === '{usuario}') return f && f.type === 'user' ? String(state.me.id) : state.me.name;
      if (t === '{vacio}') return '';
      return t;
    }
    function setValue(f, raw) {
      const i = inputs[f.key]; if (!i) return;
      const v = token(raw, f);
      if (f.type === 'checkbox') i.checked = ['1', 'si', 'sí', 'true', 'x'].includes(v.toLowerCase());
      else if (f.type === 'multiselect') { const want = v.split(/[,;]/).map((x) => x.trim().toLowerCase()); [...i.options].forEach((o) => { o.selected = want.includes(o.value.toLowerCase()); }); }
      else if (f.type === 'select') { const o = [...i.options].find((x) => x.value.toLowerCase() === v.toLowerCase()); i.value = o ? o.value : ''; }
      else if (f.type === 'user') { const u = meta.users.find((x) => String(x.id) === v || x.name.toLowerCase() === v.toLowerCase() || x.email.toLowerCase() === v.toLowerCase()); i.value = u ? u.id : ''; }
      else i.value = v;
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function conditionOk(b) {
      const c = b.condition; if (!c) return true;
      const val = String(valueOf(c.field)).trim().toLowerCase();
      const want = String(token(c.value, fieldsByKey[c.field])).trim().toLowerCase();
      return c.op === 'eq' ? val === want : c.op === 'ne' ? val !== want : c.op === 'empty' ? !val : !!val;
    }
    function fillTemplate(tpl, encode) {
      const vars = { numero: rec ? rec.number : '', app: meta.app.name, usuario: state.me.name };
      return String(tpl).replace(/\{([a-z0-9_]+)\}/g, (m, k) => {
        const v = k in vars ? vars[k] : fieldsByKey[k] ? valueOf(k, true) : m;
        return encode ? encodeURIComponent(v) : v;
      });
    }
    function buildActionButton(b) {
      const allowed = { set_fields: editable, open_url: true, email: !!rec && P.email, print: !!rec, duplicate: P.create }[b.action];
      const btn = h('button.btn.act', { type: 'button', class: 'act-' + (b.color || 'primary'), disabled: !allowed,
        title: !allowed ? (b.action === 'set_fields' ? 'Sin permiso de edición' : b.action === 'email' && rec ? 'Tu rol no tiene permiso para enviar por correo' : 'Guarda el registro primero') : '' },
      b.icon ? h('span', b.icon) : null, b.label);
      btn.addEventListener('click', async () => {
        if (b.confirm && !(await confirmDlg(fillTemplate(b.confirm), { ok: b.label, title: b.label }))) return;
        try {
          if (b.action === 'set_fields') {
            for (const st of b.sets || []) if (fieldsByKey[st.field]) setValue(fieldsByKey[st.field], st.value);
            evalButtons();
            if (b.save && saveRef) saveRef.click(); else toast('Campos actualizados: pulsa Guardar para confirmar', 'ok');
          } else if (b.action === 'open_url') {
            const url = fillTemplate(b.url, true);
            if (!/^(https?:\/\/|tel:|mailto:|sms:)/i.test(url)) return toast('Enlace no válido', 'error');
            if (/^https?:/i.test(url)) window.open(url, '_blank', 'noopener'); else location.href = url;
          } else if (b.action === 'email') {
            btn.disabled = true;
            const body = {};
            if (b.attach_pdf !== false) { toast('Generando el parte en PDF…'); body.pdf = await blobToBase64(await docPdf(parteDoc(rec))); }
            const r = await api(`/apps/${key}/records/${rec.id}/action/${b.id}`, { method: 'POST', body });
            toast(`Correo enviado a ${r.to}${body.pdf ? ' con el parte en PDF' : ''}`, 'ok');
          } else if (b.action === 'print') {
            printRecord(rec);
          } else if (b.action === 'duplicate') {
            const pre = {};
            for (const f of meta.fields) {
              if (['password', 'signature', 'image'].includes(f.type)) continue;
              const i = inputs[f.key]; if (!i) continue;
              pre[f.key] = f.type === 'checkbox' ? i.checked : f.type === 'multiselect' ? [...i.selectedOptions].map((o) => o.value) : i.value;
            }
            m.close(); openRecord(null, pre);
          }
        } catch (e) { toastErr(e); } finally { btn.disabled = !allowed; }
      });
      return h('div.field.btn-cell', { class: 'w-' + (b.width || 'sm'), dataset: { key: 'btn:' + b.id, cond: b.condition ? '1' : '' } }, h('label', '\u00a0'), btn);
    }
    function evalButtons() {
      for (const [bk, b] of Object.entries(buttonsById)) fieldEls[bk].hidden = !conditionOk(b);
    }
    // una rejilla por sección; en modo pestañas, una pestaña por sección con título
    const { groups, tabs: asTabs, labelSize, inputSize } = formGroups();
    const grids = groups.map(() => h('div.form-grid'));
    // los botones de acción van en su propia barra (no mezclados con los campos)
    const drawGrids = (gs) => gs.forEach((g, i) => clear(grids[i], g.keys.filter((k) => !k.startsWith('btn:')).map((k) => fieldEls[k])));
    drawGrids(groups);
    const btnKeys = groups.flatMap((g) => g.keys.filter((k) => k.startsWith('btn:') && fieldEls[k]));
    const actionBar = btnKeys.length ? h('div.rec-actions', { role: 'toolbar', 'aria-label': 'Acciones' }, btnKeys.map((k) => fieldEls[k])) : null;
    const hasFields = (g) => g.keys.some((k) => !k.startsWith('btn:'));
    const titled = groups.map((g, i) => ({ g, i })).filter((x) => x.g.title);
    let showSection = () => {};
    let formBody;
    if (asTabs && titled.length >= 2) {
      const btns = titled.map(({ g, i }) => h('button', { type: 'button', onclick: () => showSection(i) }, g.title));
      const panes = titled.map(({ i }) => h('div.sec-pane.form-card', grids[i]));
      showSection = (i) => titled.forEach((t, n) => { const on = t.i === i; btns[n].classList.toggle('active', on); panes[n].hidden = !on; });
      formBody = [groups[0].title || !hasFields(groups[0]) ? null : h('section.form-card', grids[0]), h('div.form-subtabs', btns), panes];
      showSection(titled[0].i);
    } else {
      const many = groups.filter(hasFields).length > 1;
      formBody = groups.map((g, i) => (hasFields(g) ? h('section.form-card',
        g.title || many ? h('h3.form-card-title', g.title || 'Datos generales') : null, grids[i]) : null));
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
        case 'image': {
          // lista de imágenes: guardadas { id, name } o nuevas { data, name } (se suben al guardar)
          const multiple = !!f.options.multiple;
          let list = Array.isArray(v) ? v.map((x) => ({ ...x })) : [];
          input = { tagName: 'IMAGES', changed: false, get value() { return list.map((x) => (x.id ? { id: x.id } : { data: x.data, name: x.name, w: x.w, h: x.h })); } };
          const urlOf = (x) => (x.id ? `/api/apps/${key}/records/${rec.id}/files/${x.id}` : x.data);
          const thumbs = h('div.img-thumbs');
          const add = async (files) => {
            for (const file of files) {
              if (!multiple && list.length) list = [];
              if (list.length >= (multiple ? 20 : 1)) { toast('Máximo de imágenes alcanzado', 'error'); break; }
              try { list.push(await prepareImage(file)); input.changed = true; } catch (e) { toastErr(e); }
            }
            draw();
          };
          const pick = (camera) => {
            const inp = h('input', { type: 'file', accept: 'image/*', multiple: multiple && !camera, capture: camera ? 'environment' : undefined, hidden: true,
              onchange: () => { add([...inp.files]); inp.remove(); } });
            document.body.append(inp); inp.click();
          };
          const takePhoto = async () => {
            if (canUseWebcam()) { const file = await webcamPhoto(); if (file) add([file]); } else pick(true); // móvil/tableta: cámara del dispositivo
          };
          const draw = () => {
            thumbs.classList.toggle('empty', !list.length);
            clear(thumbs, list.length ? list.map((x, i) => pressable(h('div.img-thumb', { class: (x.id ? '' : 'new') + ((x.mime || (x.data || '').slice(5, 14)) === 'image/png' ? ' fit' : ''), title: x.name || '', onclick: () => imageViewer(Object.assign(list.map(urlOf), { names: list.map((y, n) => y.name || `${f.label} ${n + 1}`) }), i) },
              h('img', { src: urlOf(x), alt: x.name || '', loading: 'lazy' }),
              !dis ? h('button.x', { type: 'button', title: 'Quitar', 'aria-label': `Quitar imagen ${i + 1}`, onclick: (e) => { e.stopPropagation(); list.splice(i, 1); input.changed = true; draw(); announce('Imagen quitada'); } }, '✕') : null),
              { label: `Ver imagen ${i + 1} de ${list.length}${x.name ? ': ' + x.name : ''}` }))
              : 'Sin imágenes');
          };
          draw();
          inputs[f.key] = input;
          const hgt = f.height || 1;
          return h('div.field', { class: 'w-' + ({ half: 'md', third: 'sm' }[f.width] || f.width || 'md') + (hgt > 1 ? ' tall' : ''), dataset: { key: f.key }, style: hgt > 1 ? { gridRow: `span ${hgt}` } : {} },
            h('label', f.label, f.required ? h('span.req', '*') : null),
            h('div.img-field', thumbs, !dis ? h('div.img-actions',
              h('button.btn.sm', { type: 'button', onclick: takePhoto }, '📷 Hacer foto'),
              h('button.btn.sm', { type: 'button', onclick: () => pick(false) }, multiple ? '🖼 Subir imágenes' : '🖼 Subir imagen')) : null),
            f.help ? h('div.help', f.help) : null);
        }
        case 'signature': {
          // valor: { img, at } o ''. Se edita con la ventana de firma.
          let val = v && v.img ? v : null;
          input = { tagName: 'SIGNATURE', get value() { return val ? val.img : ''; }, changed: false };
          const box = h('div.sig-field');
          const meta2 = h('div.sig-meta');
          const draw = () => {
            clear(box, val ? h('img', { src: val.img, alt: val.at ? `Firmado el ${fmtDateTime(val.at)}` : 'Firmado (pendiente de guardar)' }) : h('span.muted', 'Sin firmar'));
            clear(meta2, val && val.at ? h('span', `Firmado el ${fmtDateTime(val.at)}`) : null,
              !dis ? h('button.btn.sm.sig-btn', { type: 'button', onclick: async () => {
                const img = await signaturePad(f.label);
                if (img) { val = { img }; input.changed = true; draw(); meta2.querySelector('.sig-btn').focus(); announce(`${f.label}: firmado. Recuerda guardar.`); }
              } }, val ? '✍ Volver a firmar' : '✍ Firmar') : null,
              !dis && val ? h('button.btn.sm.ghost', { type: 'button', 'aria-label': `Borrar ${f.label}`, onclick: () => { val = null; input.changed = true; draw(); meta2.querySelector('.sig-btn').focus(); announce(`${f.label}: firma borrada`); } }, 'Borrar') : null);
          };
          draw();
          extra = null;
          inputs[f.key] = input;
          const lbl = h('label', f.label, f.required ? h('span.req', '*') : null);
          return h('div.field', { class: 'w-' + ({ half: 'md', third: 'sm' }[f.width] || f.width || 'md'), dataset: { key: f.key } }, lbl, box, meta2, f.help ? h('div.help', f.help) : null);
        }
        case 'ip': input = ipMask(h('input', { type: 'text', value: v || '', disabled: dis })); break;
        case 'iban': input = h('input', { type: 'text', value: v ? String(v).replace(/(.{4})/g, '$1 ').trim() : '', placeholder: 'ES00 0000 0000 0000 0000 0000', autocomplete: 'off', disabled: dis }); break;
        case 'checkbox': input = h('input', { type: 'checkbox', checked: !!v, disabled: dis }); break;
        case 'select': input = h('select', { disabled: dis }, h('option', { value: '' }, '—'), (f.options.choices || []).map((c) => h('option', { value: c, selected: c === v }, c)),
          v && !(f.options.choices || []).includes(v) ? h('option', { value: v, selected: true }, v) : null); break;
        case 'multiselect': input = h('select', { multiple: true, disabled: dis, size: Math.min(6, (f.options.choices || []).length || 3) }, (f.options.choices || []).map((c) => h('option', { value: c, selected: Array.isArray(v) && v.includes(c) }, c))); break;
        case 'user': input = h('select', { disabled: dis }, h('option', { value: '' }, '—'), meta.users.map((u) => h('option', { value: u.id, selected: Number(v) === u.id }, u.name))); break;
        case 'group': input = h('select', { disabled: dis }); input.dataset.current = v || ''; groupSelects.push(input); break;
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
        if (f.type === 'signature' || f.type === 'image') { if (i.changed) data[f.key] = i.value; continue; }
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

    const dataPane = h('div', { style: { ...(labelSize ? { '--lbl-fs': labelSize + 'px' } : {}), ...(inputSize ? { '--inp-fs': inputSize + 'px' } : {}) } },
      rec && rec.deleted_at ? h('div.deleted-banner', `🗑️ Registro en la papelera desde ${fmtDateTime(rec.deleted_at)}${rec.deleted_by_name ? ' por ' + rec.deleted_by_name : ''}.`) : null,
      h('div.form-top',
        meta.centers.length ? h('div.field', h('label', 'Centro de trabajo / coste'), centerSelect) : null,
        h('div.design-tools.desktop-only', designBtn, resetBtn)),
      actionBar,
      formBody,
      rec ? h('div.meta-line', h('span', `Nº ${rec.number}`), h('span', `Creado ${fmtDateTime(rec.created_at)}${rec.created_by_name ? ' por ' + rec.created_by_name : ''}`),
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

    const title = rec ? String(rec.data[meta.app.title_field] || meta.app.name) : `Nuevo · ${meta.app.name}`;
    // cabecera: número, título, estado y vencimiento
    const sf = meta.app.status_field && fieldsByKey[meta.app.status_field];
    const statusChip = rec && sf && rec.data[sf.key] ? h('span.chip.opt.head-chip', { style: { '--c': choiceColor(sf, rec.data[sf.key]) } }, rec.data[sf.key]) : null;
    const dueF = rec ? meta.fields.find((f) => f.type === 'date' && dueState(rec, f)) : null;
    const dueChip = dueF ? h('span.chip.head-chip', { class: dueState(rec, dueF) === 'over' ? 'danger' : 'warn' }, `${dueState(rec, dueF) === 'over' ? '⚠ Vencido' : 'Vence'} ${fmtDate(rec.data[dueF.key])}`) : null;
    const m = modal({ title: [h('span', { 'aria-hidden': 'true' }, meta.app.icon || ''), rec ? h('span.num-badge', `Nº ${rec.number}`) : null, h('span.head-title', title), statusChip, dueChip], size: 'lg', tabs, content: [dataPane, historyPane] });
    m.el.classList.add('rec-modal');
    const footer = [];
    if (rec && rec.deleted_at) {
      if (rec.can.restore) footer.push(h('button.btn.ok', { onclick: () => restoreRec(rec, () => m.close()) }, '↩ Restaurar'));
      if (rec.can.purge) footer.push(h('button.btn.danger', { onclick: () => purgeRec(rec, () => m.close()) }, 'Eliminar definitivamente'));
    } else if (rec && rec.can.delete) footer.push(h('button.btn.danger', { onclick: () => deleteRec(rec, () => m.close()) }, '🗑️ Papelera'));
    if (rec) footer.push(h('button.btn', { title: 'Imprimir ficha', onclick: () => printRecord(rec) }, '🖨 Imprimir'),
      h('button.btn', { title: 'Descargar el parte en PDF', onclick: () => downloadPdf(rec) }, '⬇ PDF'));
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
          const bad = groups.findIndex((g) => g.keys.some((k) => fieldsByKey[k] && e.message.includes(fieldsByKey[k].label + ':')));
          if (bad >= 0) showSection(bad);
        }
      } }, isNew ? 'Crear' : 'Guardar');
      footer.push(saveBtn);
    }
    m.foot.hidden = false; footer.forEach((b) => m.foot.append(b));
    saveRef = m.foot.querySelector('.btn.primary');
    evalButtons();
    dataPane.addEventListener('input', evalButtons); dataPane.addEventListener('change', evalButtons);
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
        if (f && f.type === 'group' && groupsById[v]) return groupsById[v].name;
        if (f && f.type === 'checkbox') return v === true || v === 1 ? 'Sí' : v === false || v === 0 ? 'No' : String(v);
        if (f && f.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) return fmtDate(v);
        if (f && f.type === 'datetime' && v) return fmtDateTime(v);
        if (f && f.type === 'signature' && v) return String(v).startsWith('Firmado') ? `Firmado ${fmtDateTime(String(v).replace(/^Firmado \(|\)$/g, ''))}` : String(v);
        if (f && f.type === 'image' && v) return String(v).replace(/\s*\(.*\)$/, '');
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
