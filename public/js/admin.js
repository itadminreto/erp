// Panel de super administración: empresas, centros, usuarios, roles/políticas, aplicaciones y campos, ajustes y auditoría.
import { api, h, clear, toast, toastErr, modal, confirmDlg, promptDlg, fmtDate, fmtDateTime, download, debounce, sortable, PERM_LABELS, ACTION_LABELS, a11yOn } from './core.js';

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
      h('thead', h('tr', columns.map((c) => h('th.nosort', c.label)), h('th.nosort', h('span.sr-only', 'Acciones')))),
      h('tbody', list.map((r) => h('tr', { class: r.deleted_at ? 'deleted' : '', onclick: () => !r.deleted_at && edit(r) },
        columns.map((c) => h('td', c.render ? c.render(r, load) : r[c.key] ?? '')),
        h('td.actions', { onclick: (e) => e.stopPropagation() }, r.deleted_at || !a11yOn() ? null : h('button.btn.sm.ghost.sr-only-focusable', { type: 'button', onclick: () => edit(r) }, `Editar ${r.name || r.code || ''}`), r.deleted_at
          ? h('button.btn.sm.ok', { onclick: async () => { await api(`/admin/${path}/${r.id}/restore`, { method: 'POST' }); toast('Restaurado', 'ok'); load(); onChange && onChange(); } }, '↩ Restaurar')
          : h('button.btn.sm.ghost', { title: 'Papelera', 'aria-label': `Enviar ${r.name || r.code || ''} a la papelera`, onclick: async () => {
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
        h('td', h('strong', u.name), u.is_superadmin ? h('span.chip.warn', { style: { marginLeft: '6px' } }, 'Super admin') : null,
          u.accessible ? h('span.chip', { style: { marginLeft: '6px' }, title: 'Modo accesible activado' }, '♿ Accesible') : null),
        h('td', u.email), h('td', u.phone || ''),
        h('td', { style: { whiteSpace: 'normal' } }, u.assignments.map((a) => h('span.chip', { style: { margin: '2px' } }, `${a.company_name} › ${a.center_name || 'Todos'} › ${a.role_name}`))),
        h('td.small', fmtDateTime(u.last_login)),
        h('td', h('span.chip', { class: u.active ? 'ok' : '' }, u.active ? 'Activo' : 'Inactivo')),
        h('td.actions', { onclick: (e) => e.stopPropagation() }, u.deleted_at || !a11yOn() ? null : h('button.btn.sm.ghost.sr-only-focusable', { type: 'button', onclick: () => edit(u) }, `Editar ${u.name}`), u.deleted_at
          ? h('button.btn.sm.ok', { onclick: async () => { await api(`/admin/users/${u.id}/restore`, { method: 'POST' }); load(); } }, '↩ Restaurar')
          : h('button.btn.sm.ghost', { 'aria-label': `Enviar a ${u.name} a la papelera`, onclick: async () => { if (await confirmDlg(`¿Enviar a ${u.name} a la papelera? Perderá el acceso.`, { danger: true })) { try { await api(`/admin/users/${u.id}`, { method: 'DELETE' }); load(); } catch (e) { toastErr(e); } } } }, '🗑️'))))))));
  }
  function edit(u) {
    const f = {
      name: h('input', { value: u ? u.name : '' }), email: h('input', { type: 'email', value: u ? u.email : '' }), phone: h('input', { type: 'tel', value: u ? u.phone || '' : '' }),
      password: h('input', { type: 'password', autocomplete: 'new-password', placeholder: u ? 'Dejar vacío para no cambiar' : 'Mínimo 8 caracteres' }),
      is_superadmin: h('input', { type: 'checkbox', checked: u ? !!u.is_superadmin : false }),
      accessible: h('input', { type: 'checkbox', checked: u ? !!u.accessible : false }),
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
        h('div.row', h('label.check', f.active, 'Activo'), h('label.check', f.must_change_password, 'Debe cambiar la contraseña'), h('label.check', f.is_superadmin, 'Super administrador'),
          h('label.check', { title: 'Activa el modo para lector de pantalla y teclado, firma escribiendo el nombre y las opciones de ♿ Accesibilidad' }, f.accessible, '♿ Usuario invidente (modo accesible)')),
        h('div', h('h3', 'Accesos (empresa › centro › rol)'), h('p.muted.small', 'Un usuario puede tener varios roles en distintas empresas y centros. "Todos los centros" da acceso a toda la empresa.')),
        asgList, h('div', h('button.btn.sm', { onclick: () => addAsg() }, '＋ Añadir acceso'))),
      footer: [h('div.spacer'), h('button.btn', { onclick: () => m.close() }, 'Cancelar'), h('button.btn.primary', { onclick: async () => {
        const body = { name: f.name.value, email: f.email.value, phone: f.phone.value, is_superadmin: f.is_superadmin.checked, accessible: f.accessible.checked, active: f.active.checked, must_change_password: f.must_change_password.checked, assignments: [...asgList.querySelectorAll('.asg')].map((r) => r.get()) };
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
        h('a.btn', { href: `#/admin/design/${a.id}` }, '🎨 Diseñar formulario'),
        h('button.btn', { onclick: () => editApp(a) }, '⚙ Propiedades'),
        a.voice_fields && a.voice_fields !== '[]' ? h('a.btn', { href: '#/voz/' + a.key, title: 'Probar el asistente por voz para usuarios invidentes' }, '📞 Probar asistente') : null),
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
  const VOICE_TYPES = ['text', 'textarea', 'email', 'phone', 'url', 'number', 'decimal', 'date', 'datetime', 'select', 'multiselect', 'user', 'checkbox', 'ip', 'iban'];
  const voiceList = (a) => { try { return JSON.parse(a.voice_fields || '[]'); } catch { return []; } };
  async function editApp(a) {
    const v = await promptDlg(`Propiedades · ${a.name}`, [
      { key: 'name', label: 'Nombre', value: a.name }, { key: 'icon', label: 'Icono (emoji)', value: a.icon }, { key: 'color', label: 'Color', type: 'color', value: a.color },
      { key: 'description', label: 'Descripción', value: a.description },
      { key: 'title_field', label: 'Campo título (identifica cada registro)', type: 'select', value: a.title_field, options: a.fields.filter((f) => f.type !== 'password').map((f) => ({ value: f.key, label: f.label })) },
      { key: 'status_field', label: 'Campo de estado (para «Abiertos / Cerrados»)', type: 'select', value: a.status_field || '', options: [{ value: '', label: '— Ninguno —' }, ...a.fields.filter((f) => f.type === 'select').map((f) => ({ value: f.key, label: f.label }))] },
      { key: 'closed_values', label: 'Valores del estado que cierran el registro', value: (() => { try { return JSON.parse(a.closed_values || '[]').join(', '); } catch { return ''; } })(), placeholder: 'Hecho, Cancelado', help: 'Separados por comas. Los registros cerrados no avisan de vencimiento y salen atenuados.' },
      { key: 'owner_field', label: 'Campo responsable (para «Míos»)', type: 'select', value: a.owner_field || '', options: [{ value: '', label: '— Ninguno —' }, ...a.fields.filter((f) => f.type === 'user').map((f) => ({ value: f.key, label: f.label }))] },
      { key: 'number_start', label: 'Numeración: empieza en', type: 'number', value: a.number_start ?? 1000, help: 'Primer número de registro (Nº de trabajo). Si ya hay números mayores, se sigue desde el último.' },
      { key: 'voice_mode', label: 'Asistente por voz (usuarios invidentes)', type: 'select',
        value: voiceList(a).includes('*') ? 'all' : voiceList(a).length ? 'some' : '',
        options: [{ value: '', label: 'Desactivado' }, { value: 'all', label: 'Pregunta todos los campos (menos firmas, imágenes y contraseñas)' }, { value: 'some', label: 'Pregunta solo los campos elegidos (y los obligatorios)' }],
        help: 'Lo ven los usuarios marcados como invidentes (menú «Recoger»). Pregunta en el orden del formulario.' },
      { key: 'voice_fields', label: 'Campos elegidos (solo si «Pregunta solo los campos elegidos»)', type: 'multiselect',
        value: voiceList(a).filter((k) => k !== '*'),
        options: a.fields.filter((f) => VOICE_TYPES.includes(f.type)).map((f) => ({ value: f.key, label: f.label })),
        help: 'Ctrl+clic para marcar varios. Los campos obligatorios se preguntan siempre.' },
      { key: 'calendar', label: 'Vista calendario (necesita algún campo de fecha)', type: 'checkbox', value: !!a.calendar },
      { key: 'active', label: 'Aplicación activa', type: 'checkbox', value: !!a.active }]);
    if (!v) return;
    if ('voice_mode' in v) {
      if (v.voice_mode === 'some' && !v.voice_fields.length) return toast('Elige al menos un campo para el asistente por voz', 'error');
      v.voice_fields = v.voice_mode === 'all' ? ['*'] : v.voice_mode === 'some' ? v.voice_fields : [];
      delete v.voice_mode;
    }
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
    const multiple = cb(f && f.options && f.options.multiple);
    const dueAlert = cb(f && f.options && f.options.due_alert);
    const dueLbl = h('label.check', dueAlert, 'Avisar de vencimiento (en rojo si ya pasó, en naranja si faltan 3 días o menos)');
    const multipleLbl = h('label.check', multiple, 'Permitir varias imágenes (hasta 20)');
    const sync = () => {
      choicesField.hidden = !['select', 'multiselect'].includes(type.value);
      multipleLbl.hidden = type.value !== 'image';
      dueLbl.hidden = type.value !== 'date';
      maxLenField.hidden = !['text', 'textarea', 'email', 'phone', 'url', 'password'].includes(type.value);
    };
    type.onchange = sync; sync();
    const m = modal({
      title: f ? `Campo · ${f.label}` : `Nuevo campo en ${target.name}`, size: 'sm',
      content: h('div.stack', h('div.field', h('label', 'Etiqueta *'), label), h('div.field', h('label', 'Clave interna'), key),
        h('div.field', h('label', 'Tipo'), type), choicesField, h('div.field', h('label', 'Ancho en el formulario'), width, h('div.help', 'Proporción de la fila en pantallas anchas; en el móvil se ajusta solo.')), maxLenField, h('div.field', h('label', 'Texto de ayuda'), help),
        h('div.stack', { style: { gap: '8px' } }, h('label.check', required, 'Obligatorio'), h('label.check', unique, 'Valor único (no se permiten duplicados)'), h('label.check', inList, 'Mostrar en el listado por defecto'), multipleLbl, dueLbl, f ? h('label.check', active, 'Activo') : null)),
      footer: [h('div.spacer'), h('button.btn', { onclick: () => m.close() }, 'Cancelar'), h('button.btn.primary', { onclick: async () => {
        const body = { label: label.value, type: type.value, width: widthVal, max_length: maxLenField.hidden ? '' : maxLen.value, help: help.value, required: required.checked, unique_value: unique.checked, show_in_list: inList.checked, choices: choices.value, ...(type.value === 'image' ? { multiple: multiple.checked } : {}), ...(type.value === 'date' ? { due_alert: dueAlert.checked } : {}) };
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

// ---------- diseñador visual de formularios ----------
const DZ_WIDTHS = [['xs', 'Muy estrecho', 2], ['sm', 'Estrecho', 3], ['md', 'Medio', 4], ['lg', 'Ancho', 6], ['xl', 'Muy ancho', 8], ['full', 'Fila completa', 12]];
const DZ_TALL = ['textarea', 'multiselect', 'image'];
const DZ_TYPE_HINT = { text: 'Texto', textarea: 'Texto largo…', number: '123', decimal: '1,50', date: 'dd/mm/aaaa', datetime: 'dd/mm/aaaa hh:mm', email: 'nombre@dominio.com',
  phone: '600 000 000', url: 'https://', select: 'Elegir… ▾', multiselect: 'Elegir varios… ▾', checkbox: '☐ Sí', password: '••••••••  👁 🎲', user: 'Usuario… ▾',
  color: '■', iban: 'ES00 0000 0000 0000 0000 0000', ip: '192.168.1.10', signature: '✍ Firma en pantalla', image: '🖼 📷 Imágenes / fotos' };

export async function renderFormDesigner(root, appId) {
  const [apps, types] = await Promise.all([api('/admin/apps'), api('/admin/field-types')]);
  const app = apps.find((a) => a.id === Number(appId));
  if (!app) return clear(root, h('div.empty', 'Aplicación no encontrada'));
  const fields = app.fields.filter((f) => f.active);
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  const widths = Object.fromEntries(fields.map((f) => [f.key, ({ half: 'md', third: 'sm' }[f.width] || f.width || 'md')]));
  const heights = Object.fromEntries(fields.map((f) => [f.key, DZ_TALL.includes(f.type) ? (f.height || 1) : 1]));
  let layout = {};
  try { layout = app.form_layout ? JSON.parse(app.form_layout) : {}; } catch { layout = {}; }
  // grupos iniciales: el primero sin título; los campos no colocados van al final
  const groups = [{ title: null, keys: [] }]; const seen = new Set();
  const btns = {}; // 'btn:id' → configuración del botón de acción
  for (const it of Array.isArray(layout.items) ? layout.items : []) {
    if (it && typeof it === 'object' && it.button) { btns['btn:' + it.button.id] = { ...it.button }; groups[groups.length - 1].keys.push('btn:' + it.button.id); }
    else if (it && typeof it === 'object' && 'section' in it) groups.push({ title: it.section, keys: [] });
    else if (byKey[it] && !seen.has(it)) { groups[groups.length - 1].keys.push(it); seen.add(it); }
  }
  groups[groups.length - 1].keys.push(...fields.map((f) => f.key).filter((k) => !seen.has(k)));

  let dirty = false;
  const setDirty = () => { dirty = true; saveBtn.disabled = false; status.textContent = 'Cambios sin guardar'; };
  const onLeave = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onLeave);
  const offHash = () => { window.removeEventListener('beforeunload', onLeave); window.removeEventListener('hashchange', offHash); };
  window.addEventListener('hashchange', offHash);

  // ----- tarjeta de campo -----
  // Tiradores: borde derecho = ancho; borde inferior = alto (filas); esquina = ancho y alto a la vez.
  // El alto solo se ofrece en texto largo y selección múltiple (en un campo de una línea solo dejaría un hueco).
  function fieldCard(k) {
    if (k.startsWith('btn:')) return buttonCard(k);
    const f = byKey[k];
    const tall = DZ_TALL.includes(f.type);
    const card = h('div.field.dz-field', { dataset: { key: k } });
    const sizeLbl = h('span.dz-size');
    const hLbl = h('span.dz-size');
    const apply = () => {
      card.className = `field dz-field w-${widths[k]}${tall && heights[k] > 1 ? ' tall' : ''}`;
      card.style.gridRow = tall && heights[k] > 1 ? `span ${heights[k]}` : '';
      sizeLbl.textContent = DZ_WIDTHS.find((w) => w[0] === widths[k])[1];
      hLbl.textContent = `${heights[k]} fila${heights[k] > 1 ? 's' : ''}`;
    };
    const stepW = (d) => { const i = DZ_WIDTHS.findIndex((w) => w[0] === widths[k]); const n = Math.min(Math.max(i + d, 0), DZ_WIDTHS.length - 1); if (n !== i) { widths[k] = DZ_WIDTHS[n][0]; apply(); setDirty(); } };
    const stepH = (d) => { const n = Math.min(Math.max(heights[k] + d, 1), 8); if (n !== heights[k]) { heights[k] = n; apply(); setDirty(); } };

    const startResize = (mode) => (e) => {
      if (canvas.classList.contains('mobile') && mode !== 'y') return toast('Cambia los anchos en la vista de ordenador: en el móvil se ajustan solos.');
      e.preventDefault(); e.stopPropagation();
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      const gridEl = card.parentElement;
      const grid = gridEl.getBoundingClientRect();
      const cs = getComputedStyle(gridEl);
      const gapX = parseFloat(cs.columnGap) || 0, gapY = parseFloat(cs.rowGap) || 0;
      const col = (grid.width - gapX * 11) / 12;
      const rect = card.getBoundingClientRect();
      const rowUnit = (rect.height + gapY) / heights[k] - gapY; // alto de una fila según el tamaño actual
      card.classList.add('resizing');
      const move = (ev) => {
        let changed = false;
        if (mode !== 'y') {
          const span = Math.min(Math.max(Math.round((ev.clientX - rect.left + gapX) / (col + gapX)), 1), 12);
          const best = DZ_WIDTHS.reduce((x, y) => (Math.abs(y[2] - span) < Math.abs(x[2] - span) ? y : x));
          if (best[0] !== widths[k]) { widths[k] = best[0]; changed = true; }
        }
        if (mode !== 'x') {
          const rows = Math.min(Math.max(Math.round((ev.clientY - rect.top + gapY) / (rowUnit + gapY)), 1), 8);
          if (rows !== heights[k]) { heights[k] = rows; changed = true; }
        }
        if (changed) { apply(); setDirty(); }
      };
      const up = () => { card.classList.remove('resizing'); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up);
    };
    const hx = h('div.dz-rs', { title: 'Arrastra para cambiar el ancho' }); hx.addEventListener('pointerdown', startResize('x'));
    const hy = tall ? h('div.dz-rs-y', { title: 'Arrastra para cambiar el alto' }) : null; if (hy) hy.addEventListener('pointerdown', startResize('y'));
    const hxy = tall ? h('div.dz-rs-xy', { title: 'Arrastra para cambiar ancho y alto' }) : null; if (hxy) hxy.addEventListener('pointerdown', startResize('xy'));
    card.append(
      h('label', h('span.dz-grip', '⋮⋮'), f.label, f.required ? h('span.req', '*') : null),
      h('div.dz-fake', { class: tall ? 'tall' : '' }, DZ_TYPE_HINT[f.type] || types[f.type] || f.type),
      h('div.dz-tools',
        h('button', { type: 'button', title: 'Más estrecho', onclick: () => stepW(-1) }, '−'), sizeLbl, h('button', { type: 'button', title: 'Más ancho', onclick: () => stepW(1) }, '+'),
        tall ? [h('span.dz-sep', '↕'), h('button', { type: 'button', title: 'Más bajo', onclick: () => stepH(-1) }, '−'), hLbl, h('button', { type: 'button', title: 'Más alto', onclick: () => stepH(1) }, '+')] : null),
      ...[hx, hy, hxy].filter(Boolean)); // (append del DOM: sin nulos, que se pintarían como «null»)
    apply();
    return card;
  }

  // ----- botones de acción -----
  const ACTIONS = {
    set_fields: 'Rellenar campos (y guardar)', open_url: 'Abrir enlace (mapa, llamar, WhatsApp, web…)', email: 'Enviar por correo', print: 'Imprimir parte', duplicate: 'Duplicar registro',
  };
  const COLORS = { primary: 'Principal', ok: 'Verde', warn: 'Naranja', danger: 'Rojo', neutral: 'Gris' };
  const describe = (b) => {
    if (b.action === 'set_fields') return `Rellena ${(b.sets || []).map((x) => (byKey[x.field] || {}).label + ' = ' + (x.value || 'vacío')).join(', ')}${b.save ? ' y guarda' : ''}`;
    if (b.action === 'open_url') return `Abre ${b.url}`;
    if (b.action === 'email') return `Envía correo a ${[b.to_field ? `{${b.to_field}}` : '', b.to_fixed].filter(Boolean).join(', ')}`;
    return ACTIONS[b.action];
  };
  function buttonCard(k) {
    const b = btns[k];
    const card = h('div.field.dz-field.dz-btn', { dataset: { key: k } });
    const sizeLbl = h('span.dz-size');
    const draw = () => {
      card.className = `field dz-field dz-btn w-${b.width || 'sm'}`;
      sizeLbl.textContent = DZ_WIDTHS.find((w) => w[0] === (b.width || 'sm'))[1];
      clear(card,
        h('label', h('span.dz-grip', '⋮⋮'), 'Botón', b.condition ? h('span.chip', { style: { marginLeft: '6px', fontSize: '.68rem' } }, 'con condición') : null),
        h('div.btn.act', { class: 'act-' + b.color }, b.icon ? h('span', b.icon) : null, b.label),
        h('div.dz-btn-desc', describe(b)),
        h('div.dz-tools',
          h('button', { type: 'button', title: 'Más estrecho', onclick: () => step(-1) }, '−'), sizeLbl, h('button', { type: 'button', title: 'Más ancho', onclick: () => step(1) }, '+'),
          h('button', { type: 'button', title: 'Configurar', style: { width: 'auto', padding: '0 6px' }, onclick: async () => { if (await editButton(b)) { draw(); setDirty(); } } }, '⚙'),
          h('button', { type: 'button', title: 'Quitar botón', onclick: () => { card.remove(); delete btns[k]; setDirty(); } }, '✕')));
    };
    const step = (d) => { const i = DZ_WIDTHS.findIndex((w) => w[0] === (b.width || 'sm')); const n = Math.min(Math.max(i + d, 0), DZ_WIDTHS.length - 1); if (n !== i) { b.width = DZ_WIDTHS[n][0]; draw(); setDirty(); } };
    card.addEventListener('dblclick', async () => { if (await editButton(b)) { draw(); setDirty(); } });
    draw();
    return card;
  }

  /** Ventana de configuración de un botón. Modifica `b` y devuelve true si se acepta. */
  function editButton(b) {
    return new Promise((resolve) => {
      let accepted = false;
      const fieldOpts = (filter = () => true, empty = '— Elegir campo —') => [h('option', { value: '' }, empty), ...fields.filter(filter).map((f) => h('option', { value: f.key }, f.label))];
      const label = h('input', { value: b.label, maxlength: 40 });
      const icon = h('input', { value: b.icon || '', maxlength: 8, placeholder: '✔ 📍 📞 ✉️ 🖨' });
      const color = h('select', Object.entries(COLORS).map(([k, l]) => h('option', { value: k, selected: b.color === k }, l)));
      const action = h('select', Object.entries(ACTIONS).map(([k, l]) => h('option', { value: k, selected: b.action === k }, l)));
      const confirmTxt = h('input', { value: b.confirm || '', placeholder: 'Opcional: p. ej. ¿Marcar el trabajo {numero} como hecho?' });
      // rellenar campos
      const setsBox = h('div.stack', { style: { gap: '6px' } });
      const addSet = (st = {}) => {
        const fsel = h('select', fieldOpts((f) => !['password', 'signature', 'image'].includes(f.type)));
        fsel.value = st.field || '';
        const val = h('input', { value: st.value || '', placeholder: 'Valor, {hoy}, {ahora}, {usuario} o {vacio}' });
        const row = h('div.row', { style: { flexWrap: 'nowrap' } }, fsel, val, h('button.btn.icon.ghost', { type: 'button', onclick: () => row.remove() }, '✕'));
        row.get = () => ({ field: fsel.value, value: val.value });
        setsBox.append(row);
      };
      (b.sets && b.sets.length ? b.sets : [{}]).forEach(addSet);
      const save = h('input', { type: 'checkbox', checked: b.save !== false });
      // enlace
      const url = h('input', { value: b.url || '', placeholder: 'https://www.google.com/maps/search/?api=1&query={direccion}' });
      const presets = h('div.row', { style: { gap: '4px' } }, h('span.small.muted', 'Plantillas:'),
        [['📍 Mapa', 'https://www.google.com/maps/search/?api=1&query={campo}'], ['📞 Llamar', 'tel:{campo}'], ['💬 WhatsApp', 'https://wa.me/34{campo}'], ['✉️ Email', 'mailto:{campo}']]
          .map(([l, u]) => h('button.btn.sm', { type: 'button', onclick: () => { url.value = u; url.focus(); } }, l)));
      // correo
      const toField = h('select', fieldOpts((f) => f.type === 'email', '— Ninguno —')); toField.value = b.to_field || '';
      const toFixed = h('input', { value: b.to_fixed || '', placeholder: 'jefe@empresa.com, oficina@empresa.com' });
      const subject = h('input', { value: b.subject || '{app} Nº {numero}' });
      const attachPdf = h('input', { type: 'checkbox', checked: b.attach_pdf !== false });
      const body = h('textarea', { value: b.body || '', placeholder: 'Vacío = se envían todos los datos del registro.\nEj.: Hola, el trabajo {numero} ({titulo}) está terminado.' });
      // condición
      const cField = h('select', fieldOpts(() => true, '— Mostrar siempre —')); cField.value = b.condition ? b.condition.field : '';
      const cOp = h('select', [['eq', 'es igual a'], ['ne', 'es distinto de'], ['empty', 'está vacío'], ['filled', 'tiene valor']].map(([k, l]) => h('option', { value: k, selected: b.condition && b.condition.op === k }, l)));
      const cVal = h('input', { value: b.condition ? b.condition.value : '', placeholder: 'valor' });
      const vars = h('p.help', 'En textos y enlaces puedes usar {clave_del_campo} y también {numero}, {app}, {usuario}. Claves: ',
        fields.filter((f) => !['password', 'signature', 'image'].includes(f.type)).map((f) => f.key).join(', '));
      const blocks = {
        set_fields: h('div.stack', h('label.small.muted', 'Campos que rellena'), setsBox, h('div', h('button.btn.sm', { type: 'button', onclick: () => addSet() }, '＋ Otro campo')), h('label.check', save, 'Guardar el registro después')),
        open_url: h('div.stack', h('div.field', h('label', 'Enlace'), url), presets),
        email: h('div.stack', h('div.two-col', h('div.field', h('label', 'Enviar al email del campo'), toField), h('div.field', h('label', 'y/o a estas direcciones'), toFixed)),
          h('div.field', h('label', 'Asunto'), subject), h('div.field', h('label', 'Texto'), body),
          h('label.check', attachPdf, 'Adjuntar el parte en PDF (igual que el impreso)'), h('p.help', 'Necesita el correo saliente (SMTP) configurado en Ajustes.')),
        print: h('p.muted', 'Imprime el parte del registro (debe estar guardado).'),
        duplicate: h('p.muted', 'Abre un registro nuevo con los mismos datos (sin fotos, firmas ni contraseñas).'),
      };
      const actionBox = h('div');
      const sync = () => { clear(actionBox, blocks[action.value]); cOpSync(); };
      const cOpSync = () => { cVal.hidden = ['empty', 'filled'].includes(cOp.value) || !cField.value; cOp.hidden = !cField.value; };
      action.onchange = sync; cOp.onchange = cOpSync; cField.onchange = cOpSync; sync();
      const m = modal({
        title: '⚙ Botón de acción', size: '',
        content: h('div.stack',
          h('div', { style: { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '12px' } },
            h('div.field', h('label', 'Texto del botón'), label), h('div.field', h('label', 'Icono'), icon), h('div.field', h('label', 'Color'), color)),
          h('div.field', h('label', 'Qué hace'), action), actionBox,
          h('div.field', h('label', 'Mostrar solo si…'), h('div.row', { style: { flexWrap: 'nowrap' } }, cField, cOp, cVal)),
          h('div.field', h('label', 'Pedir confirmación'), confirmTxt), vars),
        footer: [h('div.spacer'), h('button.btn', { onclick: () => m.close() }, 'Cancelar'), h('button.btn.primary', { onclick: () => {
          if (!label.value.trim()) return toast('Escribe el texto del botón', 'error');
          const sets = [...setsBox.children].map((r) => r.get()).filter((x) => x.field);
          if (action.value === 'set_fields' && !sets.length) return toast('Elige al menos un campo a rellenar', 'error');
          if (action.value === 'open_url' && !/^(https?:\/\/|tel:|mailto:|sms:)/i.test(url.value.trim())) return toast('El enlace debe empezar por https://, tel:, mailto: o sms:', 'error');
          if (action.value === 'email' && !toField.value && !toFixed.value.trim()) return toast('Indica a quién se envía', 'error');
          Object.assign(b, { label: label.value.trim(), icon: icon.value.trim(), color: color.value, action: action.value, confirm: confirmTxt.value.trim(),
            sets, save: save.checked, url: url.value.trim(), to_field: toField.value, to_fixed: toFixed.value.trim(), subject: subject.value, body: body.value, attach_pdf: attachPdf.checked,
            condition: cField.value ? { field: cField.value, op: cOp.value, value: cVal.value } : undefined });
          accepted = true; m.close();
        } }, 'Aceptar')],
        onClose: () => resolve(accepted),
      });
    });
  }

  // ----- secciones -----
  const mkGrid = (keys) => {
    const g = h('div.form-grid.dz-grid', keys.map(fieldCard));
    sortable(g, { group: 'dz-fields', draggable: '.dz-field', filter: '.dz-rs, .dz-rs-y, .dz-rs-xy, .dz-tools button', preventOnFilter: false, emptyInsertThreshold: 40, onEnd: setDirty, onAdd: setDirty });
    return g;
  };
  function sectionEl(title, keys) {
    const input = h('input.dz-title', { value: title, placeholder: 'Título de la sección', oninput: setDirty });
    const sec = h('div.dz-section',
      h('div.dz-sec-head', h('span.dz-sec-grip', { title: 'Arrastra para mover la sección' }, '⋮⋮'), input,
        h('button.btn.sm.ghost', { title: 'Quitar sección (sus campos pasan a la anterior)', onclick: () => {
          const prevGrid = sec.previousElementSibling ? sec.previousElementSibling.querySelector('.dz-grid') : topGrid;
          [...sec.querySelector('.dz-grid').children].forEach((c) => prevGrid.append(c));
          sec.remove(); setDirty();
        } }, '✕ Quitar')),
      mkGrid(keys));
    return sec;
  }
  const topGrid = mkGrid(groups[0].keys);
  const sectionsBox = h('div.dz-sections', groups.slice(1).map((g) => sectionEl(g.title, g.keys)));
  sortable(sectionsBox, { handle: '.dz-sec-grip', draggable: '.dz-section', onEnd: setDirty });

  const canvas = h('div.dz-canvas',
    h('div.dz-top-hint', 'Campos al principio (sin sección)'), topGrid, sectionsBox);

  // ----- barra de herramientas -----
  const tabsCb = h('input', { type: 'checkbox', checked: !!layout.tabs, onchange: setDirty });
  // tamaño de letra de etiquetas y campos (px); null = el de por defecto
  const sizes = { label: layout.label_size || null, input: layout.input_size || null };
  const DEF = { label: 11, input: 14 }, LIM = { label: [10, 22], input: [11, 24] };
  const applySizes = () => {
    canvas.style.setProperty('--lbl-fs', (sizes.label || DEF.label) + 'px');
    canvas.style.setProperty('--inp-fs', (sizes.input || DEF.input) + 'px');
    lblVal.textContent = sizes.label || DEF.label; inpVal.textContent = sizes.input || DEF.input;
  };
  const lblVal = h('strong.fs-val'), inpVal = h('strong.fs-val');
  const fsCtl = (which, val, label) => h('div.fs-ctl', { title: `Tamaño de letra de ${label.toLowerCase()}` }, h('span.small.muted', label),
    h('button.btn.sm', { onclick: () => { sizes[which] = Math.max(LIM[which][0], (sizes[which] || DEF[which]) - 1); applySizes(); setDirty(); } }, 'A−'), val,
    h('button.btn.sm', { onclick: () => { sizes[which] = Math.min(LIM[which][1], (sizes[which] || DEF[which]) + 1); applySizes(); setDirty(); } }, 'A+'));
  const viewSeg = h('div.seg',
    h('button.on', { onclick: (e) => setView(e, false) }, '🖥 Ordenador'),
    h('button', { onclick: (e) => setView(e, true) }, '📱 Móvil'));
  function setView(e, mobile) {
    [...viewSeg.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget));
    canvas.classList.toggle('mobile', mobile);
  }
  const status = h('span.muted.small', 'Sin cambios');
  const saveBtn = h('button.btn.primary', { disabled: true, onclick: save }, '💾 Guardar diseño');

  async function save() {
    const item = (c) => (c.dataset.key.startsWith('btn:') ? { button: btns[c.dataset.key] } : c.dataset.key);
    const items = [...topGrid.children].map(item);
    for (const sec of sectionsBox.children) {
      items.push({ section: sec.querySelector('.dz-title').value.trim() || 'Sección' });
      items.push(...[...sec.querySelector('.dz-grid').children].map(item));
    }
    try {
      await api(`/admin/apps/${app.id}/design`, { method: 'PUT', body: { items, widths, heights, tabs: tabsCb.checked, label_size: sizes.label, input_size: sizes.input } });
      dirty = false; saveBtn.disabled = true; status.textContent = 'Guardado ✔';
      toast('Diseño guardado: ya se aplica al formulario de ' + app.name, 'ok');
    } catch (e) { toastErr(e); }
  }

  clear(root,
    head(`🎨 Diseño del formulario · ${app.name}`, 'Arrastra los campos para colocarlos; tira del borde derecho (ancho), del inferior (alto) o de la esquina (ambos) para cambiar su tamaño, y agrupa con secciones.',
      h('a.btn', { href: '#/admin/apps' }, '← Volver'), saveBtn),
    h('div.toolbar',
      h('button.btn', { onclick: async () => {
        const b = { id: Math.random().toString(36).slice(2, 10), label: 'Nuevo botón', icon: '', color: 'primary', width: 'sm', action: 'print' };
        if (!(await editButton(b))) return;
        btns['btn:' + b.id] = b;
        const card = buttonCard('btn:' + b.id); topGrid.append(card); setDirty();
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } }, '＋ Añadir botón'),
      h('button.btn', { onclick: () => { const s = sectionEl('Nueva sección', []); sectionsBox.append(s); s.querySelector('.dz-title').select(); setDirty(); s.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }, '＋ Añadir sección'),
      h('label.check', tabsCb, 'Mostrar las secciones como pestañas'),
      fsCtl('label', lblVal, 'Etiquetas'), fsCtl('input', inpVal, 'Campos'),
      h('button.btn.sm.ghost', { title: 'Volver al tamaño de letra por defecto', onclick: () => { sizes.label = null; sizes.input = null; applySizes(); setDirty(); } }, '↺'),
      h('div.spacer'), status, viewSeg),
    h('div.dz-stage', h('div.card.dz-paper', h('div.dz-paper-head', h('span', app.icon), h('strong', `Nuevo · ${app.name}`)), canvas)));
  applySizes();
}
