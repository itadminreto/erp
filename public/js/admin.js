// Panel de super administración: empresas, centros, usuarios, roles/políticas, aplicaciones y campos, ajustes y auditoría.
import { api, h, clear, toast, toastErr, modal, confirmDlg, promptDlg, fmtDate, fmtDateTime, download, debounce, sortable, PERM_LABELS, ACTION_LABELS } from './core.js';

const head = (title, sub, ...actions) => h('div.page-head', h('div.title', h('div', h('h1', title), sub ? h('div.muted.small', sub) : null)), h('div.btn-group', actions));

/** Muestra el valor de un campo dinámico como texto. */
function fmtExtra(f, v, usersById = {}) {
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return '';
  switch (f.type) {
    case 'checkbox': return v ? 'Sí' : 'No';
    case 'date': return fmtDate(v);
    case 'datetime': return fmtDateTime(v);
    case 'multiselect': return v.join(', ');
    case 'user': return usersById[v] ? usersById[v].name : `#${v}`;
    case 'iban': return String(v).replace(/(.{4})/g, '$1 ').trim();
    case 'decimal': return Number(v).toLocaleString('es-ES', { maximumFractionDigits: 2 });
    default: return String(v);
  }
}

/** Tabla CRUD genérica con papelera para entidades simples. `entity` activa sus campos dinámicos (empresas, centros). */
async function simpleEntity(root, { title, sub, path, columns, form, newLabel, onChange, entity }) {
  let extraFields = [], users = [], usersById = {};
  if (entity) {
    [extraFields, users] = await Promise.all([api(`/admin/entity-fields/${entity}`), api('/admin/users')]);
    usersById = Object.fromEntries(users.map((u) => [u.id, u]));
    // columnas de los campos dinámicos marcados «mostrar en el listado», antes de la columna Estado
    const pos = columns.findIndex((c) => c.label === 'Estado');
    const extraCols = extraFields.filter((f) => f.show_in_list).map((f) => ({ label: f.label,
      render: (r) => { const t = fmtExtra(f, (r.extra || {})[f.key], usersById); return f.type === 'iban' && t ? h('span.mono', t) : t; } }));
    columns = pos < 0 ? [...columns, ...extraCols] : [...columns.slice(0, pos), ...extraCols, ...columns.slice(pos)];
  }
  const X = 'x:'; // prefijo interno de los campos dinámicos en el formulario
  const extraForm = () => extraFields.map((f, i) => ({
    key: X + f.key, label: f.label, type: f.type === 'user' ? 'select' : f.type, help: f.help || '', required: f.required,
    section: i === 0 ? 'Datos adicionales' : undefined, full: ['full', 'xl'].includes(f.width), max_length: f.max_length,
    options: f.type === 'user' ? [{ value: '', label: '—' }, ...users.map((u) => ({ value: u.id, label: u.name }))]
      : f.type === 'select' ? [{ value: '', label: '—' }, ...(f.options.choices || []).map((c) => ({ value: c, label: c }))]
      : f.type === 'multiselect' ? (f.options.choices || []).map((c) => ({ value: c, label: c })) : undefined,
  }));
  let trash = false;
  const tableBox = h('div.card');
  const trashCb = h('input', { type: 'checkbox', onchange: (e) => { trash = e.target.checked; trashLbl.classList.toggle('on', trash); load(); } });
  const trashLbl = h('label.check.trash-toggle', trashCb, '🗑️ Ver papelera');
  let filter = '';
  clear(root, head(title, sub, h('button.btn.primary', { onclick: () => edit(null) }, '＋ ' + newLabel)),
    h('div.toolbar', h('div.search', h('input', { type: 'search', placeholder: 'Buscar…', oninput: debounce((e) => { filter = e.target.value.toLowerCase(); draw(); }, 200) })), trashLbl),
    tableBox);
  let rows = [];
  async function load() { try { rows = await api(`/admin/${path}${trash ? '?trash=1' : ''}`); draw(); } catch (e) { toastErr(e); } }
  function draw() {
    const list = rows.filter((r) => !filter || JSON.stringify(r).toLowerCase().includes(filter));
    clear(tableBox, list.length ? h('div.table-wrap', h('table.data',
      h('thead', h('tr', columns.map((c) => h('th.nosort', c.label)), h('th.nosort', ''))),
      h('tbody', list.map((r) => h('tr', { class: r.deleted_at ? 'deleted' : '', onclick: () => !r.deleted_at && edit(r) },
        columns.map((c) => h('td', c.render ? c.render(r, load) : r[c.key] ?? '')),
        h('td.actions', { onclick: (e) => e.stopPropagation() }, r.deleted_at
          ? h('button.btn.sm.ok', { onclick: async () => { await api(`/admin/${path}/${r.id}/restore`, { method: 'POST' }); toast('Restaurado', 'ok'); load(); onChange && onChange(); } }, '↩ Restaurar')
          : h('button.btn.sm.ghost', { title: 'Papelera', onclick: async () => {
            if (!(await confirmDlg('¿Enviar a la papelera? Podrás restaurarlo después.', { danger: true }))) return;
            try { await api(`/admin/${path}/${r.id}`, { method: 'DELETE' }); toast('Enviado a la papelera', 'ok'); load(); onChange && onChange(); } catch (e) { toastErr(e); }
          } }, '🗑️')))))))
      : h('div.empty', h('div.big', '📭'), h('p', 'Sin registros')));
  }
  async function edit(r, prev = null) {
    const fields = [...(typeof form === 'function' ? await form(r) : form), ...extraForm()];
    const current = (f) => (f.key.startsWith(X) ? (r && r.extra ? r.extra[f.key.slice(X.length)] : undefined) : r ? r[f.key] : undefined);
    const v = await promptDlg(r ? `Editar · ${r.name}` : newLabel, fields.map((f) => ({ ...f, value: prev ? prev[f.key] : r ? current(f) : f.value })));
    if (!v) return;
    const body = { extra: {} };
    for (const [k, val] of Object.entries(v)) { if (k.startsWith(X)) body.extra[k.slice(X.length)] = val; else body[k] = val; }
    if (!entity) delete body.extra;
    try {
      if (r) await api(`/admin/${path}/${r.id}`, { method: 'PUT', body });
      else await api(`/admin/${path}`, { method: 'POST', body });
      toast('Guardado', 'ok'); load(); onChange && onChange();
    } catch (e) { toastErr(e); edit(r, v); } // si falla, se reabre con lo escrito para corregirlo
  }
  load();
}

/** Celda con el logo de la empresa y botones para subirlo, cambiarlo o quitarlo. */
function logoCell(r, after) {
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, onchange: async () => {
    if (!file.files[0]) return;
    const fd = new FormData(); fd.append('file', file.files[0]);
    try { await api(`/admin/companies/${r.id}/logo`, { method: 'POST', form: fd }); toast('Logo actualizado', 'ok'); after(); } catch (e) { toastErr(e); }
  } });
  return h('div.row', { style: { flexWrap: 'nowrap', gap: '6px' }, onclick: (e) => e.stopPropagation() }, file,
    r.has_logo && r.active && !r.deleted_at ? h('img.logo-thumb', { src: `/api/companies/${r.id}/logo?v=${Date.now()}`, alt: 'Logo' }) : null,
    r.deleted_at ? null : h('button.btn.sm', { title: 'PNG, JPG, WebP o GIF · máx. 2 MB', onclick: () => file.click() }, r.has_logo ? 'Cambiar' : '🖼 Subir logo'),
    r.has_logo && !r.deleted_at ? h('button.btn.sm.ghost', { title: 'Quitar logo', onclick: async () => {
      if (!(await confirmDlg('¿Quitar el logo de la empresa?'))) return;
      try { await api(`/admin/companies/${r.id}/logo`, { method: 'DELETE' }); after(); } catch (e) { toastErr(e); }
    } }, '✕') : null);
}

export function renderCompanies(root, onChange) {
  return simpleEntity(root, {
    title: 'Empresas', sub: 'Entorno multi-empresa: cada empresa tiene sus centros, usuarios y datos separados', path: 'companies', newLabel: 'Nueva empresa', onChange, entity: 'companies',
    columns: [{ label: 'Logo', render: (r, reload) => logoCell(r, async () => { await reload(); onChange && onChange(); }) },
      { key: 'name', label: 'Nombre' }, { key: 'cif', label: 'CIF' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Teléfono' }, { label: 'Estado', render: (r) => h('span.chip', { class: r.active ? 'ok' : '' }, r.active ? 'Activa' : 'Inactiva') }],
    form: [{ key: 'name', label: 'Nombre *' }, { key: 'cif', label: 'CIF / NIF' }, { key: 'address', label: 'Dirección' }, { key: 'email', label: 'Email', type: 'email' }, { key: 'phone', label: 'Teléfono' }, { key: 'notes', label: 'Notas', type: 'textarea' }, { key: 'active', label: 'Activa', type: 'checkbox', value: true }],
  });
}

export async function renderCenters(root) {
  const companies = await api('/admin/companies');
  return simpleEntity(root, {
    title: 'Centros de trabajo / coste', sub: 'Los registros de cada aplicación se asignan a un centro y los permisos pueden limitarse por centro', path: 'centers', newLabel: 'Nuevo centro', entity: 'centers',
    columns: [{ key: 'company_name', label: 'Empresa' }, { key: 'code', label: 'Código' }, { key: 'name', label: 'Nombre' },
      { label: 'Tipo', render: (r) => h('span.chip', { trabajo: 'Centro de trabajo', coste: 'Centro de coste', ambos: 'Trabajo y coste' }[r.kind] || r.kind) },
      { label: 'Estado', render: (r) => h('span.chip', { class: r.active ? 'ok' : '' }, r.active ? 'Activo' : 'Inactivo') }],
    form: [
      { key: 'company_id', label: 'Empresa *', type: 'select', options: companies.map((c) => ({ value: c.id, label: c.name })), value: companies[0] && companies[0].id },
      { key: 'code', label: 'Código', placeholder: 'CC01' }, { key: 'name', label: 'Nombre *' },
      { key: 'kind', label: 'Tipo', type: 'select', value: 'trabajo', options: [{ value: 'trabajo', label: 'Centro de trabajo' }, { value: 'coste', label: 'Centro de coste' }, { value: 'ambos', label: 'Trabajo y coste' }] },
      { key: 'address', label: 'Dirección' },
      { key: 'notes', label: 'Notas', type: 'textarea' }, { key: 'active', label: 'Activo', type: 'checkbox', value: true }],
  });
}

// ---------- usuarios ----------
export async function renderUsers(root) {
  const [companies, centers, rolesData] = await Promise.all([api('/admin/companies'), api('/admin/centers'), api('/admin/roles')]);
  const roles = rolesData.roles;
  let trash = false, filter = '', users = [];
  const box = h('div.card');
  const trashLbl = h('label.check.trash-toggle', h('input', { type: 'checkbox', onchange: (e) => { trash = e.target.checked; trashLbl.classList.toggle('on', trash); load(); } }), '🗑️ Ver papelera');
  clear(root, head('Usuarios', 'Los usuarios son comunes a todas las aplicaciones y empresas; su acceso se define con asignaciones empresa + centro + rol', h('button.btn.primary', { onclick: () => edit(null) }, '＋ Nuevo usuario')),
    h('div.toolbar', h('div.search', h('input', { type: 'search', placeholder: 'Buscar usuario…', oninput: debounce((e) => { filter = e.target.value.toLowerCase(); draw(); }, 200) })), trashLbl), box);
  async function load() { users = await api('/admin/users' + (trash ? '?trash=1' : '')); draw(); }
  function draw() {
    const list = users.filter((u) => !filter || `${u.name} ${u.email}`.toLowerCase().includes(filter));
    clear(box, h('div.table-wrap', h('table.data', h('thead', h('tr', ['Nombre', 'Email', 'Teléfono', 'Accesos', 'Último acceso', 'Estado', ''].map((t) => h('th.nosort', t)))),
      h('tbody', list.map((u) => h('tr', { class: u.deleted_at ? 'deleted' : '', onclick: () => !u.deleted_at && edit(u) },
        h('td', h('strong', u.name), u.is_superadmin ? h('span.chip.warn', { style: { marginLeft: '6px' } }, 'Super admin') : null),
        h('td', u.email), h('td', u.phone || ''),
        h('td', { style: { whiteSpace: 'normal' } }, u.assignments.map((a) => h('span.chip', { style: { margin: '2px' } }, `${a.company_name} › ${a.center_name || 'Todos'} › ${a.role_name}`))),
        h('td.small', fmtDateTime(u.last_login)),
        h('td', h('span.chip', { class: u.active ? 'ok' : '' }, u.active ? 'Activo' : 'Inactivo')),
        h('td.actions', { onclick: (e) => e.stopPropagation() }, u.deleted_at
          ? h('button.btn.sm.ok', { onclick: async () => { await api(`/admin/users/${u.id}/restore`, { method: 'POST' }); load(); } }, '↩ Restaurar')
          : h('button.btn.sm.ghost', { onclick: async () => { if (await confirmDlg(`¿Enviar a ${u.name} a la papelera? Perderá el acceso.`, { danger: true })) { try { await api(`/admin/users/${u.id}`, { method: 'DELETE' }); load(); } catch (e) { toastErr(e); } } } }, '🗑️'))))))));
  }
  function edit(u) {
    const f = {
      name: h('input', { value: u ? u.name : '' }), email: h('input', { type: 'email', value: u ? u.email : '' }), phone: h('input', { type: 'tel', value: u ? u.phone || '' : '' }),
      password: h('input', { type: 'password', autocomplete: 'new-password', placeholder: u ? 'Dejar vacío para no cambiar' : 'Mínimo 8 caracteres' }),
      is_superadmin: h('input', { type: 'checkbox', checked: u ? !!u.is_superadmin : false }),
      active: h('input', { type: 'checkbox', checked: u ? !!u.active : true }),
      must_change_password: h('input', { type: 'checkbox', checked: u ? !!u.must_change_password : true }),
    };
    const asgList = h('div.stack');
    const addAsg = (a = {}) => {
      const comp = h('select', companies.map((c) => h('option', { value: c.id, selected: a.company_id === c.id }, c.name)));
      const cen = h('select');
      const fillCenters = () => clear(cen, h('option', { value: '' }, 'Todos los centros'), centers.filter((c) => String(c.company_id) === comp.value).map((c) => h('option', { value: c.id, selected: a.center_id === c.id }, `${c.code ? c.code + ' · ' : ''}${c.name}`)));
      comp.onchange = fillCenters; fillCenters();
      const role = h('select', roles.map((r) => h('option', { value: r.id, selected: a.role_id === r.id }, r.name)));
      const row = h('div.row.asg', { style: { flexWrap: 'nowrap' } }, comp, cen, role, h('button.btn.icon.ghost', { onclick: () => row.remove() }, '✕'));
      row.get = () => ({ company_id: comp.value, center_id: cen.value || null, role_id: role.value });
      asgList.append(row);
    };
    (u ? u.assignments : []).forEach(addAsg);
    const m = modal({
      title: u ? `Usuario · ${u.name}` : 'Nuevo usuario', size: '',
      content: h('div.stack',
        h('div.two-col', h('div.field', h('label', 'Nombre *'), f.name), h('div.field', h('label', 'Email (usuario de acceso) *'), f.email),
          h('div.field', h('label', 'Teléfono (para WhatsApp/SMS)'), f.phone), h('div.field', h('label', u ? 'Nueva contraseña' : 'Contraseña inicial *'), f.password)),
        h('div.row', h('label.check', f.active, 'Activo'), h('label.check', f.must_change_password, 'Debe cambiar la contraseña'), h('label.check', f.is_superadmin, 'Super administrador')),
        h('div', h('h3', 'Accesos (empresa › centro › rol)'), h('p.muted.small', 'Un usuario puede tener varios roles en distintas empresas y centros. "Todos los centros" da acceso a toda la empresa.')),
        asgList, h('div', h('button.btn.sm', { onclick: () => addAsg() }, '＋ Añadir acceso'))),
      footer: [h('div.spacer'), h('button.btn', { onclick: () => m.close() }, 'Cancelar'), h('button.btn.primary', { onclick: async () => {
        const body = { name: f.name.value, email: f.email.value, phone: f.phone.value, is_superadmin: f.is_superadmin.checked, active: f.active.checked, must_change_password: f.must_change_password.checked, assignments: [...asgList.querySelectorAll('.asg')].map((r) => r.get()) };
        if (f.password.value) body.password = f.password.value;
        try { if (u) await api(`/admin/users/${u.id}`, { method: 'PUT', body }); else await api('/admin/users', { method: 'POST', body }); toast('Usuario guardado', 'ok'); m.close(); load(); } catch (e) { toastErr(e); }
      } }, 'Guardar')],
    });
  }
  load();
}

// ---------- roles y políticas ----------
export async function renderRoles(root) {
  const [data, apps] = await Promise.all([api('/admin/roles'), api('/admin/apps')]);
  const cols = [...data.perms.map((p) => 'can_' + p), 'only_own'];
  const box = h('div.grid-cards', { style: { gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' } });
  clear(root, head('Roles y políticas', 'Define, por aplicación, qué puede hacer cada rol: ver, crear, editar, borrar, papelera, contraseñas, importar/exportar…',
    h('button.btn.primary', { onclick: () => edit(null) }, '＋ Nuevo rol')), box);
  async function reload() { Object.assign(data, await api('/admin/roles')); draw(); }
  function draw() {
    clear(box, data.roles.map((r) => h('div.card.app-card', { style: { cursor: 'pointer' }, onclick: () => edit(r) },
      h('div.top', h('h2', r.name), h('span.chip', `${r.permissions.filter((p) => p.can_view).length} apps`)),
      h('p.muted.small', r.description || ''))));
  }
  function edit(r) {
    const name = h('input', { value: r ? r.name : '' });
    const desc = h('input', { value: r ? r.description || '' : '' });
    const byApp = Object.fromEntries((r ? r.permissions : []).map((p) => [p.app_id, p]));
    const cbs = {};
    const table = h('table.perm-table', h('thead', h('tr', h('th', 'Aplicación'), cols.map((c) => h('th', { title: c }, PERM_LABELS[c.replace(/^can_/, '')] || c)))),
      h('tbody', apps.map((a) => h('tr', h('td', `${a.icon || ''} ${a.name}`), cols.map((c) => {
        const cb = h('input', { type: 'checkbox', checked: !!(byApp[a.id] && byApp[a.id][c]) });
        (cbs[a.id] = cbs[a.id] || {})[c] = cb;
        return h('td', cb);
      })))));
    const presets = h('div.row', h('span.small.muted', 'Rápido:'),
      [['Todo', () => true], ['Solo lectura', (c) => c === 'can_view'], ['Ninguno', () => false]].map(([l, fn]) =>
        h('button.btn.sm', { onclick: () => apps.forEach((a) => cols.forEach((c) => { cbs[a.id][c].checked = c === 'only_own' ? false : fn(c); })) }, l)));
    const m = modal({
      title: r ? `Rol · ${r.name}` : 'Nuevo rol', size: 'lg',
      content: h('div.stack', h('div.two-col', h('div.field', h('label', 'Nombre *'), name), h('div.field', h('label', 'Descripción'), desc)), presets,
        h('div.table-wrap', table),
        h('p.muted.small', '«Solo sus registros» limita ver/editar/borrar a los registros creados por el propio usuario. La visibilidad por centro se define en la asignación de cada usuario.')),
      footer: [r ? h('button.btn.danger', { onclick: async () => { if (await confirmDlg('¿Enviar el rol a la papelera? Los usuarios con este rol perderán esos permisos.', { danger: true })) { await api(`/admin/roles/${r.id}`, { method: 'DELETE' }); m.close(); reload(); } } }, '🗑️ Papelera') : null,
        h('div.spacer'), h('button.btn', { onclick: () => m.close() }, 'Cancelar'),
        h('button.btn.primary', { onclick: async () => {
          const permissions = apps.map((a) => ({ app_id: a.id, ...Object.fromEntries(cols.map((c) => [c, cbs[a.id][c].checked])) }));
          try {
            if (r) await api(`/admin/roles/${r.id}`, { method: 'PUT', body: { name: name.value, description: desc.value, permissions } });
            else await api('/admin/roles', { method: 'POST', body: { name: name.value, description: desc.value, permissions } });
            toast('Rol guardado', 'ok'); m.close(); reload();
          } catch (e) { toastErr(e); }
        } }, 'Guardar')],
    });
  }
  draw();
}

// ---------- aplicaciones y campos dinámicos ----------
export async function renderAppsAdmin(root, onChange) {
  const types = await api('/admin/field-types');
  let apps = await api('/admin/apps');
  const ENT = { companies: { name: 'Empresas', icon: '🏢', desc: 'Datos adicionales de cada empresa' }, centers: { name: 'Centros', icon: '📍', desc: 'Datos adicionales de cada centro de trabajo / coste' } };
  const entFields = {};
  const loadEnt = async () => { for (const e of Object.keys(ENT)) entFields[e] = await api(`/admin/entity-fields/${e}?all=1`); };
  await loadEnt();
  let current = apps[0] ? apps[0].id : null;   // id de app o 'e:centers' / 'e:companies'
  const side = h('div.sort-list');
  const sideEnt = h('div.sort-list');
  const detail = h('div');
  clear(root, head('Aplicaciones y campos', 'Añade aplicaciones y campos sin programar. Arrastra para cambiar el orden por defecto.',
    h('button.btn.primary', { onclick: newApp }, '＋ Nueva aplicación')),
  h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) 1fr', gap: '16px' }, class: 'apps-admin' }, h('div', side, sideEnt), detail));
  if (window.matchMedia('(max-width: 760px)').matches) root.querySelector('.apps-admin').style.gridTemplateColumns = '1fr';

  async function reload() { apps = await api('/admin/apps'); await loadEnt(); draw(); onChange && onChange(); }
  const fieldRow = (f, onEdit, extra = null) => h('div.sort-item', { class: f.active ? '' : 'inactive', dataset: { id: f.id } },
    h('span.grip', '⋮⋮'),
    h('div.grow', h('div', h('strong', f.label), f.required ? h('span.req', { style: { color: 'var(--danger)' } }, ' *') : null, extra),
      h('div.muted.small', `${types[f.type] || f.type} · clave: ${f.key}${f.unique_value ? ' · único' : ''}${f.show_in_list ? ' · en listado' : ''}${f.active ? '' : ' · DESACTIVADO'}`)),
    h('button.btn.sm', { onclick: onEdit }, 'Editar'));
  const entItem = (e) => h('div.sort-item', { style: current === 'e:' + e ? { borderColor: 'var(--primary)', background: 'var(--primary-2)' } : { cursor: 'pointer' }, onclick: () => { current = 'e:' + e; draw(); } },
    h('span', ENT[e].icon), h('span.grow', ENT[e].name), h('span.muted.small', `${entFields[e].filter((f) => f.active).length}`));
  function drawEntity(e) {
    const target = { name: ENT[e].name, noPassword: true,
      create: (body) => api(`/admin/entity-fields/${e}`, { method: 'POST', body }),
      update: (f, body) => api(`/admin/entity-fields/${e}/${f.id}`, { method: 'PUT', body }) };
    const list = h('div.sort-list', entFields[e].map((f) => fieldRow(f, () => editField(target, f))));
    sortable(list, { handle: '.grip', onEnd: () => api(`/admin/entity-fields/${e}/order`, { method: 'PUT', body: { ids: [...list.children].map((x) => x.dataset.id) } }).then(reload).catch(toastErr) });
    clear(detail, h('div.card.card-pad.stack',
      h('div.row', h('div.app-ico', { style: { width: '42px', height: '42px', borderRadius: '11px', display: 'grid', placeItems: 'center', fontSize: '22px', background: 'var(--primary-2)' } }, ENT[e].icon),
        h('div', { style: { flex: 1 } }, h('h2', `${ENT[e].name} · datos adicionales`), h('div.muted.small', ENT[e].desc))),
      h('p.muted.small', 'Los datos básicos (nombre, código, dirección…) son fijos. Aquí añades los que necesites: aparecerán en el formulario bajo «Datos adicionales» y, si lo marcas, como columna del listado.'),
      h('div.row', h('h3', { style: { flex: 1 } }, 'Campos'), h('button.btn.primary.sm', { onclick: () => editField(target, null) }, '＋ Añadir campo')),
      entFields[e].length ? list : h('p.muted', 'Todavía no hay campos adicionales.'),
      h('p.muted.small', 'Los campos no se borran: se desactivan para conservar los datos históricos.')));
  }
  function draw() {
    if (String(current).startsWith('e:')) {
      drawSide();
      return drawEntity(String(current).slice(2));
    }
    drawSide();
    drawApp();
  }
  function drawSide() {
    clear(side, apps.map((a) => h('div.sort-item', { class: (a.active ? '' : 'inactive ') + (a.id === current ? 'active' : ''), dataset: { id: a.id }, style: a.id === current ? { borderColor: 'var(--primary)', background: 'var(--primary-2)' } : { cursor: 'pointer' }, onclick: () => { current = a.id; draw(); } },
      h('span.grip', '⋮⋮'), h('span', a.icon), h('span.grow', a.name), h('span.muted.small', `${a.fields.filter((f) => f.active).length}`))));
    sortable(side, { handle: '.grip', onEnd: () => api('/admin/apps-order', { method: 'PUT', body: { ids: [...side.children].map((e) => e.dataset.id) } }).then(reload) });
    clear(sideEnt, h('div.muted.small', { style: { margin: '14px 4px 6px', textTransform: 'uppercase', letterSpacing: '.05em' } }, 'Datos maestros'), Object.keys(ENT).map(entItem));
  }
  function drawApp() {
    const a = apps.find((x) => x.id === current);
    if (!a) return clear(detail, h('div.empty', 'Selecciona una aplicación'));
    const target = { name: a.name,
      create: (body) => api(`/admin/apps/${a.id}/fields`, { method: 'POST', body }),
      update: (f, body) => api(`/admin/fields/${f.id}`, { method: 'PUT', body }) };
    const fieldsList = h('div.sort-list', a.fields.map((f) => fieldRow(f, () => editField(target, f),
      a.title_field === f.key ? h('span.chip', { style: { marginLeft: '6px' } }, 'Título') : null)));
    sortable(fieldsList, { handle: '.grip', onEnd: () => api(`/admin/apps/${a.id}/fields-order`, { method: 'PUT', body: { ids: [...fieldsList.children].map((e) => e.dataset.id) } }).then(reload).catch(toastErr) });
    clear(detail, h('div.card.card-pad.stack',
      h('div.row', h('div.app-ico', { style: { width: '42px', height: '42px', borderRadius: '11px', display: 'grid', placeItems: 'center', fontSize: '22px', background: a.color + '22' } }, a.icon),
        h('div', { style: { flex: 1 } }, h('h2', a.name), h('div.muted.small', `clave: ${a.key} · ${a.description || ''}`)),
        h('button.btn', { onclick: () => editApp(a) }, '⚙ Propiedades')),
      h('div.row', h('h3', { style: { flex: 1 } }, 'Campos'), h('button.btn.primary.sm', { onclick: () => editField(target, null) }, '＋ Añadir campo')),
      fieldsList,
      h('p.muted.small', 'Los campos no se borran: se desactivan para conservar los datos históricos. La clave interna no cambia aunque modifiques la etiqueta.')));
  }
  async function newApp() {
    const v = await promptDlg('Nueva aplicación', [{ key: 'name', label: 'Nombre *' }, { key: 'key', label: 'Clave (URL)', placeholder: 'ej. inventario', help: 'Minúsculas sin espacios. Si se deja vacía se genera a partir del nombre.' }, { key: 'icon', label: 'Icono (emoji)', value: '📁' }, { key: 'color', label: 'Color', type: 'color', value: '#64748b' }, { key: 'description', label: 'Descripción' }]);
    if (!v) return;
    if (!v.key) v.key = v.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    try { const r = await api('/admin/apps', { method: 'POST', body: v }); current = r.id; toast('Aplicación creada. Recuerda darle permisos en Roles.', 'ok'); reload(); } catch (e) { toastErr(e); }
  }
  async function editApp(a) {
    const v = await promptDlg(`Propiedades · ${a.name}`, [
      { key: 'name', label: 'Nombre', value: a.name }, { key: 'icon', label: 'Icono (emoji)', value: a.icon }, { key: 'color', label: 'Color', type: 'color', value: a.color },
      { key: 'description', label: 'Descripción', value: a.description },
      { key: 'title_field', label: 'Campo título (identifica cada registro)', type: 'select', value: a.title_field, options: a.fields.filter((f) => f.type !== 'password').map((f) => ({ value: f.key, label: f.label })) },
      { key: 'calendar', label: 'Vista calendario (necesita algún campo de fecha)', type: 'checkbox', value: !!a.calendar },
      { key: 'active', label: 'Aplicación activa', type: 'checkbox', value: !!a.active }]);
    if (!v) return;
    try { await api(`/admin/apps/${a.id}`, { method: 'PUT', body: v }); toast('Guardado', 'ok'); reload(); } catch (e) { toastErr(e); }
  }
  function editField(target, f) {
    const label = h('input', { value: f ? f.label : '' });
    const key = h('input', { value: f ? f.key : '', disabled: !!f, placeholder: 'automática' });
    const type = h('select', Object.entries(types).filter(([k]) => !(target.noPassword && k === 'password')).map(([k, l]) => h('option', { value: k, selected: f ? f.type === k : k === 'text' }, l)));
    const choices = h('textarea', { value: f && f.options.choices ? f.options.choices.join('\n') : '', placeholder: 'Una opción por línea' });
    const choicesField = h('div.field', h('label', 'Opciones'), choices);
    // Ancho visual: proporción de la fila (se adapta a cada pantalla)
    const WID = [['xs', 'Muy estrecho', 1 / 6], ['sm', 'Estrecho', 1 / 4], ['md', 'Medio', 1 / 3], ['lg', 'Ancho', 1 / 2], ['xl', 'Muy ancho', 2 / 3], ['full', 'Fila completa', 1]];
    let widthVal = f ? ({ half: 'md', third: 'sm' }[f.width] || f.width || 'md') : 'md';
    const width = h('div.width-pick', WID.map(([k, l, frac]) => h('button', { type: 'button', class: k === widthVal ? 'on' : '', dataset: { w: k },
      onclick: (e) => { widthVal = k; [...width.children].forEach((b) => b.classList.toggle('on', b.dataset.w === k)); e.preventDefault(); } },
    h('span.bar', h('i', { style: { width: `${frac * 100}%` } })), l)));
    const maxLen = h('input', { type: 'number', min: 1, max: 65000, value: f && f.max_length ? f.max_length : '', placeholder: 'Sin límite' });
    const maxLenField = h('div.field', h('label', 'Máximo de caracteres (opcional)'), maxLen, h('div.help', 'Por ejemplo 4 para un PIN o 9 para un CIF. No deja escribir más.'));
    const help = h('input', { value: f ? f.help || '' : '' });
    const cb = (v) => h('input', { type: 'checkbox', checked: !!v });
    const required = cb(f && f.required), unique = cb(f && f.unique_value), inList = cb(f ? f.show_in_list : true), active = cb(f ? f.active : true);
    const sync = () => {
      choicesField.hidden = !['select', 'multiselect'].includes(type.value);
      maxLenField.hidden = !['text', 'textarea', 'email', 'phone', 'url', 'password'].includes(type.value);
    };
    type.onchange = sync; sync();
    const m = modal({
      title: f ? `Campo · ${f.label}` : `Nuevo campo en ${target.name}`, size: 'sm',
      content: h('div.stack', h('div.field', h('label', 'Etiqueta *'), label), h('div.field', h('label', 'Clave interna'), key),
        h('div.field', h('label', 'Tipo'), type), choicesField, h('div.field', h('label', 'Ancho en el formulario'), width, h('div.help', 'Proporción de la fila en pantallas anchas; en el móvil se ajusta solo.')), maxLenField, h('div.field', h('label', 'Texto de ayuda'), help),
        h('div.stack', { style: { gap: '8px' } }, h('label.check', required, 'Obligatorio'), h('label.check', unique, 'Valor único (no se permiten duplicados)'), h('label.check', inList, 'Mostrar en el listado por defecto'), f ? h('label.check', active, 'Activo') : null)),
      footer: [h('div.spacer'), h('button.btn', { onclick: () => m.close() }, 'Cancelar'), h('button.btn.primary', { onclick: async () => {
        const body = { label: label.value, type: type.value, width: widthVal, max_length: maxLenField.hidden ? '' : maxLen.value, help: help.value, required: required.checked, unique_value: unique.checked, show_in_list: inList.checked, choices: choices.value };
        if (f) body.active = active.checked; else if (key.value) body.key = key.value;
        try { if (f) await target.update(f, body); else await target.create(body); toast('Campo guardado', 'ok'); m.close(); reload(); } catch (e) { toastErr(e); }
      } }, 'Guardar')],
    });
  }
  draw();
}

// ---------- ajustes ----------
export async function renderSettings(root) {
  const s = await api('/admin/settings');
  const inp = (k, attrs = {}) => h('input', { value: s[k] || '', ...attrs });
  const f = { app_name: inp('app_name'), public_url: inp('public_url', { placeholder: 'https://erp.midominio.com' }), smtp_host: inp('smtp_host', { placeholder: 'smtp.office365.com' }), smtp_port: inp('smtp_port', { placeholder: '587' }),
    smtp_user: inp('smtp_user'), smtp_pass: inp('smtp_pass', { type: 'password', autocomplete: 'new-password' }), smtp_from: inp('smtp_from', { placeholder: 'Gestión <no-reply@dominio.com>' }),
    smtp_secure: h('input', { type: 'checkbox', checked: s.smtp_secure === '1' }) };
  const fld = (l, el) => h('div.field', h('label', l), el);
  clear(root, head('Ajustes generales', 'Datos generales de la plataforma y correo saliente'),
    h('div.card.card-pad.stack', { style: { maxWidth: '760px' } },
      h('h2', 'General'), h('div.two-col', fld('Nombre de la plataforma', f.app_name), fld('URL pública (para enlaces enviados)', f.public_url)),
      h('h2', 'Correo saliente (SMTP)'), h('div.two-col', fld('Servidor', f.smtp_host), fld('Puerto', f.smtp_port), fld('Usuario', f.smtp_user), fld('Contraseña', f.smtp_pass), fld('Remitente', f.smtp_from), h('label.check', f.smtp_secure, 'SSL/TLS directo (puerto 465)')),
      h('div.row', h('button.btn', { onclick: async () => { try { await api('/admin/settings/test-mail', { method: 'POST', body: {} }); toast('Correo de prueba enviado', 'ok'); } catch (e) { toastErr(e); } } }, '✉️ Enviar correo de prueba'), h('div.spacer'),
        h('button.btn.primary', { onclick: async () => {
          const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value]));
          try { await api('/admin/settings', { method: 'PUT', body }); toast('Ajustes guardados', 'ok'); } catch (e) { toastErr(e); }
        } }, 'Guardar'))),
    backupCard(s));
}

// ---------- copias de seguridad (dentro de Ajustes) ----------
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function backupCard(s) {
  const auto = h('input', { type: 'checkbox', checked: s.backup_auto !== '0' });
  const keep = h('input', { type: 'number', min: 1, max: 365, value: s.backup_keep || 14, style: { width: '90px' } });
  const listBox = h('div');
  const fileInp = h('input', { type: 'file', accept: '.gz,application/gzip' });

  async function load() {
    try {
      const r = await api('/admin/backups');
      clear(listBox, r.list.length ? h('div.table-wrap', h('table.data',
        h('thead', h('tr', ['Fecha', 'Tipo', 'Tamaño', ''].map((t) => h('th.nosort', t)))),
        h('tbody', r.list.map((b) => h('tr', { style: { cursor: 'default' } },
          h('td', fmtDateTime(b.created_at)),
          h('td', h('span.chip', { class: b.kind === 'manual' ? 'ok' : b.kind === 'antes-restaurar' ? 'warn' : '' }, b.kind_label)),
          h('td.small', fmtSize(b.size)),
          h('td.actions', h('div.btn-group', { style: { flexWrap: 'nowrap' } },
            h('button.btn.sm', { title: 'Descargar', onclick: () => download(`/admin/backups/${encodeURIComponent(b.name)}`, b.name) }, '⬇'),
            h('button.btn.sm.danger', { onclick: () => restore(`/admin/backups/${encodeURIComponent(b.name)}/restore`, null, fmtDateTime(b.created_at)) }, '↩ Restaurar'),
            h('button.btn.sm.ghost', { title: 'Borrar', onclick: async () => {
              if (!(await confirmDlg(`¿Borrar la copia del ${fmtDateTime(b.created_at)}?`, { danger: true }))) return;
              try { await api(`/admin/backups/${encodeURIComponent(b.name)}`, { method: 'DELETE' }); load(); } catch (e) { toastErr(e); }
            } }, '🗑️')))))))) : h('p.muted', 'Todavía no hay copias.'),
      h('p.muted.small', `Se guardan en el servidor, en ${r.dir}.`));
    } catch (e) { toastErr(e); }
  }

  async function restore(url, form, label, force = false) {
    if (!force && !(await confirmDlg(
      `Se sustituirán TODOS los datos actuales por los de la copia (${label}). Antes se guardará automáticamente una copia del estado actual. Todos los usuarios tendrán que volver a iniciar sesión.`,
      { ok: 'Restaurar', danger: true, title: 'Restaurar copia de seguridad' }))) return;
    try {
      const r = await api(url + (force ? (url.includes('?') ? '&' : '?') + 'force=1' : ''), { method: 'POST', form: form || undefined });
      const n = Object.values(r.counts).reduce((a, b) => a + b, 0);
      toast(`Copia restaurada (${n} filas). Vuelve a iniciar sesión.`, 'ok');
      setTimeout(() => location.reload(), 1500);
    } catch (e) {
      if (/otra clave APP_SECRET/.test(e.message)) {
        const again = await confirmDlg(`${e.message} Solo continúa si sabes lo que haces (por ejemplo, si vas a poner después la misma APP_SECRET del servidor de origen).`,
          { ok: 'Restaurar igualmente', danger: true, title: 'Clave de cifrado distinta' });
        if (again) restore(url, form && (() => { const fd = new FormData(); fd.append('file', fileInp.files[0]); return fd; })(), label, true);
      } else toastErr(e);
    }
  }

  load();
  return h('div.card.card-pad.stack', { style: { maxWidth: '760px', marginTop: '16px' } },
    h('h2', '💾 Copias de seguridad'),
    h('p.muted.small', 'Incluyen todas las empresas, usuarios, roles, aplicaciones, registros, papelera, auditoría y ajustes. Las contraseñas van cifradas: para restaurarlas en otro servidor hace falta la misma APP_SECRET.'),
    h('div.row', h('label.check', auto, 'Copia automática diaria'), h('span.muted.small', 'Conservar'), keep, h('span.muted.small', 'días'), h('div.spacer'),
      h('button.btn', { onclick: async () => {
        try { await api('/admin/settings', { method: 'PUT', body: { backup_auto: auto.checked ? '1' : '0', backup_keep: String(keep.value || 14) } }); toast('Guardado', 'ok'); } catch (e) { toastErr(e); }
      } }, 'Guardar')),
    h('div.row', h('button.btn.primary', { onclick: async (e) => {
      e.target.disabled = true;
      try { const b = await api('/admin/backups', { method: 'POST' }); toast('Copia creada', 'ok'); await load(); download(`/admin/backups/${encodeURIComponent(b.name)}`, b.name); }
      catch (err) { toastErr(err); } finally { e.target.disabled = false; }
    } }, '💾 Crear copia ahora y descargar')),
    listBox,
    h('h3', 'Restaurar desde un archivo'),
    h('div.row', fileInp, h('button.btn.danger', { onclick: () => {
      if (!fileInp.files[0]) return toast('Selecciona un archivo .json.gz', 'error');
      const fd = new FormData(); fd.append('file', fileInp.files[0]);
      restore('/admin/backups-upload?restore=1', fd, fileInp.files[0].name);
    } }, '↩ Restaurar archivo')));
}

// ---------- auditoría ----------
export async function renderAudit(root) {
  const [apps, users] = await Promise.all([api('/admin/apps'), api('/admin/users?trash=1')]);
  const q = { page: 1 };
  const sel = (k, opts, ph) => h('select', { style: { width: 'auto' }, onchange: (e) => { q[k] = e.target.value; q.page = 1; load(); } }, h('option', { value: '' }, ph), opts);
  const box = h('div.card');
  const qs = () => new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '' && v !== undefined));
  clear(root, head('Auditoría', 'Trazabilidad completa de todos los cambios, accesos y consultas de contraseñas',
    h('button.btn', { onclick: () => download('/admin/audit/export?' + qs() + '&format=xlsx', 'auditoria.xlsx') }, '⬇ Excel')),
  h('div.toolbar',
    h('div.search', h('input', { type: 'search', placeholder: 'Buscar en resumen o cambios…', oninput: debounce((e) => { q.q = e.target.value; q.page = 1; load(); }, 300) })),
    sel('app_id', apps.map((a) => h('option', { value: a.id }, a.name)), 'Todas las apps'),
    sel('user_id', users.map((u) => h('option', { value: u.id }, u.name)), 'Todos los usuarios'),
    sel('action', Object.entries(ACTION_LABELS).map(([k, [l]]) => h('option', { value: k }, l)), 'Todas las acciones'),
    h('input', { type: 'date', style: { width: 'auto' }, title: 'Desde', onchange: (e) => { q.from = e.target.value; load(); } }),
    h('input', { type: 'date', style: { width: 'auto' }, title: 'Hasta', onchange: (e) => { q.to = e.target.value; load(); } })),
  box);
  async function load() {
    const r = await api('/admin/audit?' + qs());
    const pages = Math.max(1, Math.ceil(r.total / 100));
    clear(box, h('div.table-wrap', h('table.data', h('thead', h('tr', ['Fecha', 'Usuario', 'Empresa', 'App', 'Acción', 'Resumen', 'Cambios'].map((t) => h('th.nosort', t)))),
      h('tbody', r.rows.map((a) => {
        const [l, c] = ACTION_LABELS[a.action] || [a.action, ''];
        return h('tr', { style: { cursor: 'default' } }, h('td.small', fmtDateTime(a.ts)), h('td', a.user_name || ''), h('td.small', a.company_name || ''), h('td.small', a.app_name || a.entity),
          h('td', h('span.chip', { class: c }, l)), h('td', { style: { whiteSpace: 'normal', maxWidth: '360px' } }, `${a.summary || ''}${a.entity_id ? ` (#${a.entity_id})` : ''}`),
          h('td.small', { style: { whiteSpace: 'normal', maxWidth: '420px' } }, a.changes.slice(0, 8).map((ch) => h('div', `${ch.field}: ${String(ch.from ?? '')} → ${String(ch.to ?? '')}`)), a.changes.length > 8 ? `… +${a.changes.length - 8}` : ''));
      })))),
    h('div.pager', h('span.muted.small', `${r.total} eventos`), h('button.btn.sm', { disabled: q.page <= 1, onclick: () => { q.page--; load(); } }, '‹'), h('span.small', `${q.page} / ${pages}`), h('button.btn.sm', { disabled: q.page >= pages, onclick: () => { q.page++; load(); } }, '›')));
  }
  load().catch(toastErr);
}
