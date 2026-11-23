'use strict';
// Administración (solo super admin): empresas, centros, usuarios, roles, aplicaciones, campos, ajustes y auditoría.
const express = require('express');
const { all, get, run, tx } = require('../db');
const { PERMS, hash } = require('../auth');
const { FIELD_TYPES, appFields } = require('../fields');
const { encrypt } = require('../crypto');
const { audit, diff } = require('../audit');
const { wrap, httpError, sendSheet } = require('./records');

const router = express.Router();
const KEY_RE = /^[a-z][a-z0-9_]{0,40}$/;

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj && k in obj).map((k) => [k, obj[k]]));
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

/** CRUD genérico con borrado lógico y trazabilidad para tablas simples. */
function crud(entity, table, cols, { orderBy = 'id', validate = () => {}, listSql, labelOf = (r) => r.name } = {}) {
  router.get(`/${entity}`, wrap((req, res) => {
    const trash = req.query.trash === '1';
    const sql = listSql || `SELECT * FROM ${table}`;
    res.json(all(`${sql} ${sql.includes('WHERE') ? 'AND' : 'WHERE'} ${trash ? '1' : `${table}.deleted_at IS NULL`} ORDER BY ${orderBy}`));
  }));
  router.post(`/${entity}`, wrap((req, res) => {
    const data = pick(req.body, cols);
    validate(data, null);
    const keys = Object.keys(data);
    const id = Number(run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => data[k])).lastInsertRowid);
    audit(req, { entity, entityId: id, action: 'create', summary: `Alta: ${labelOf(data)}`, changes: diff({}, data) });
    res.status(201).json(get(`SELECT * FROM ${table} WHERE id = ?`, id));
  }));
  router.put(`/${entity}/:id`, wrap((req, res) => {
    const before = get(`SELECT * FROM ${table} WHERE id = ?`, Number(req.params.id));
    if (!before) throw httpError(404, 'No encontrado');
    const data = pick(req.body, cols);
    validate(data, before);
    const keys = Object.keys(data);
    if (keys.length) run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(',')} WHERE id = ?`, ...keys.map((k) => data[k]), before.id);
    const changes = diff(pick(before, keys), data);
    if (changes.length) audit(req, { entity, entityId: before.id, action: 'update', summary: `Modificación: ${labelOf({ ...before, ...data })}`, changes });
    res.json(get(`SELECT * FROM ${table} WHERE id = ?`, before.id));
  }));
  router.delete(`/${entity}/:id`, wrap((req, res) => {
    const r = get(`SELECT * FROM ${table} WHERE id = ?`, Number(req.params.id));
    if (!r) throw httpError(404, 'No encontrado');
    run(`UPDATE ${table} SET deleted_at = datetime('now') WHERE id = ?`, r.id);
    audit(req, { entity, entityId: r.id, action: 'delete', summary: `Enviado a la papelera: ${labelOf(r)}` });
    res.json({ ok: true });
  }));
  router.post(`/${entity}/:id/restore`, wrap((req, res) => {
    const r = get(`SELECT * FROM ${table} WHERE id = ?`, Number(req.params.id));
    if (!r) throw httpError(404, 'No encontrado');
    run(`UPDATE ${table} SET deleted_at = NULL WHERE id = ?`, r.id);
    audit(req, { entity, entityId: r.id, action: 'restore', summary: `Restaurado: ${labelOf(r)}` });
    res.json({ ok: true });
  }));
}

// ---------- empresas y centros ----------
crud('companies', 'companies', ['name', 'cif', 'address', 'email', 'phone', 'notes', 'active'], {
  orderBy: 'name',
  validate: (d, before) => { if ((!before || 'name' in d) && !String(d.name || '').trim()) throw httpError(400, 'El nombre es obligatorio'); if ('active' in d) d.active = bool(d.active); },
});
crud('centers', 'centers', ['company_id', 'code', 'name', 'kind', 'address', 'notes', 'active'], {
  orderBy: 'company_name, centers.code, centers.name',
  listSql: 'SELECT centers.*, companies.name company_name FROM centers JOIN companies ON companies.id = centers.company_id',
  labelOf: (r) => `${r.code ? r.code + ' · ' : ''}${r.name}`,
  validate: (d, before) => {
    if ((!before || 'name' in d) && !String(d.name || '').trim()) throw httpError(400, 'El nombre es obligatorio');
    if (!before && !d.company_id) throw httpError(400, 'La empresa es obligatoria');
    if ('kind' in d && !['trabajo', 'coste', 'ambos'].includes(d.kind)) throw httpError(400, 'Tipo de centro no válido');
    if ('active' in d) d.active = bool(d.active);
    if ('company_id' in d) d.company_id = Number(d.company_id);
  },
});

// ---------- usuarios ----------
router.get('/users', wrap((req, res) => {
  const trash = req.query.trash === '1';
  const users = all(`SELECT id, email, name, phone, is_superadmin, active, must_change_password, created_at, last_login, deleted_at
                     FROM users ${trash ? '' : 'WHERE deleted_at IS NULL'} ORDER BY name`);
  const asg = all(`SELECT a.*, r.name role_name, c.name company_name, ce.name center_name, ce.code center_code
                   FROM user_assignments a JOIN roles r ON r.id = a.role_id JOIN companies c ON c.id = a.company_id
                   LEFT JOIN centers ce ON ce.id = a.center_id`);
  res.json(users.map((u) => ({ ...u, assignments: asg.filter((a) => a.user_id === u.id) })));
}));

function saveUser(req, before) {
  const b = req.body || {};
  const d = pick(b, ['email', 'name', 'phone', 'is_superadmin', 'active', 'must_change_password']);
  if ('email' in d) { d.email = String(d.email).trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+$/.test(d.email)) throw httpError(400, 'Email no válido'); }
  if (!before && (!d.email || !String(d.name || '').trim())) throw httpError(400, 'Nombre y email obligatorios');
  for (const k of ['is_superadmin', 'active', 'must_change_password']) if (k in d) d[k] = bool(d[k]);
  if (before && before.id === req.user.id && (d.is_superadmin === 0 || d.active === 0)) throw httpError(400, 'No puedes quitarte tus propios privilegios ni desactivarte');
  const dup = d.email && get('SELECT id FROM users WHERE email = ? AND id != ?', d.email, before ? before.id : 0);
  if (dup) throw httpError(409, 'Ya existe un usuario con ese email');
  if (b.password) { if (String(b.password).length < 8) throw httpError(400, 'La contraseña debe tener al menos 8 caracteres'); d.password_hash = hash(b.password); }
  if (!before && !d.password_hash) throw httpError(400, 'Indica una contraseña inicial');

  return tx(() => {
    let id;
    const keys = Object.keys(d);
    if (before) {
      id = before.id;
      if (keys.length) run(`UPDATE users SET ${keys.map((k) => k + ' = ?').join(',')} WHERE id = ?`, ...keys.map((k) => d[k]), id);
    } else {
      id = Number(run(`INSERT INTO users (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => d[k])).lastInsertRowid);
    }
    const shown = { ...d }; delete shown.password_hash;
    const changes = diff(before ? pick(before, Object.keys(shown)) : {}, shown);
    if (d.password_hash) changes.push({ field: 'password', from: '', to: '•••• (cambiada)' });
    if (Array.isArray(b.assignments)) {
      const prev = all('SELECT role_id, company_id, center_id FROM user_assignments WHERE user_id = ?', id);
      run('DELETE FROM user_assignments WHERE user_id = ?', id);
      for (const a of b.assignments) {
        if (!a.role_id || !a.company_id) continue;
        run('INSERT INTO user_assignments (user_id, role_id, company_id, center_id) VALUES (?,?,?,?)', id, Number(a.role_id), Number(a.company_id), a.center_id ? Number(a.center_id) : null);
      }
      const now = all('SELECT role_id, company_id, center_id FROM user_assignments WHERE user_id = ?', id);
      const fmt = (l) => l.map((x) => `${x.company_id}/${x.center_id ?? '*'}/${x.role_id}`).sort().join(', ');
      if (fmt(prev) !== fmt(now)) changes.push({ field: 'asignaciones (empresa/centro/rol)', from: fmt(prev), to: fmt(now) });
    }
    if (d.active === 0) run('DELETE FROM sessions WHERE user_id = ?', id);
    if (changes.length) audit(req, { entity: 'users', entityId: id, action: before ? 'update' : 'create', summary: `${before ? 'Modificación' : 'Alta'} usuario ${d.name || before.name}`, changes });
    return id;
  });
}
router.post('/users', wrap((req, res) => res.status(201).json({ id: saveUser(req, null) })));
router.put('/users/:id', wrap((req, res) => {
  const before = get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!before) throw httpError(404, 'No encontrado');
  res.json({ id: saveUser(req, before) });
}));
router.delete('/users/:id', wrap((req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!u) throw httpError(404, 'No encontrado');
  if (u.id === req.user.id) throw httpError(400, 'No puedes borrarte a ti mismo');
  run(`UPDATE users SET deleted_at = datetime('now'), active = 0 WHERE id = ?`, u.id);
  run('DELETE FROM sessions WHERE user_id = ?', u.id);
  audit(req, { entity: 'users', entityId: u.id, action: 'delete', summary: `Usuario a la papelera: ${u.name}` });
  res.json({ ok: true });
}));
router.post('/users/:id/restore', wrap((req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!u) throw httpError(404, 'No encontrado');
  run('UPDATE users SET deleted_at = NULL, active = 1 WHERE id = ?', u.id);
  audit(req, { entity: 'users', entityId: u.id, action: 'restore', summary: `Usuario restaurado: ${u.name}` });
  res.json({ ok: true });
}));

// ---------- roles y políticas por aplicación ----------
router.get('/roles', wrap((req, res) => {
  const roles = all(`SELECT * FROM roles ${req.query.trash === '1' ? '' : 'WHERE deleted_at IS NULL'} ORDER BY name`);
  const perms = all('SELECT * FROM role_permissions');
  res.json({ perms: PERMS, roles: roles.map((r) => ({ ...r, permissions: perms.filter((p) => p.role_id === r.id) })) });
}));
function saveRole(req, before) {
  const b = req.body || {};
  if (!before && !String(b.name || '').trim()) throw httpError(400, 'El nombre es obligatorio');
  return tx(() => {
    let id = before && before.id;
    if (before) run('UPDATE roles SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?', b.name ?? null, b.description ?? null, id);
    else id = Number(run('INSERT INTO roles (name, description) VALUES (?,?)', b.name, b.description || '').lastInsertRowid);
    const changes = before ? diff(pick(before, ['name', 'description']), pick(b, ['name', 'description'])) : [{ field: 'name', from: '', to: b.name }];
    if (Array.isArray(b.permissions)) {
      const cols = [...PERMS.map((p) => 'can_' + p), 'only_own'];
      const prev = Object.fromEntries(all('SELECT * FROM role_permissions WHERE role_id = ?', id).map((p) => [p.app_id, p]));
      run('DELETE FROM role_permissions WHERE role_id = ?', id);
      for (const p of b.permissions) {
        if (!p.app_id) continue;
        run(`INSERT INTO role_permissions (role_id, app_id, ${cols.join(',')}) VALUES (?,?,${cols.map(() => '?').join(',')})`, id, Number(p.app_id), ...cols.map((c) => bool(p[c])));
        const old = prev[p.app_id] || {};
        const appName = (get('SELECT name FROM apps WHERE id = ?', Number(p.app_id)) || {}).name;
        for (const c of cols) if (bool(old[c]) !== bool(p[c])) changes.push({ field: `${appName}.${c}`, from: bool(old[c]) ? 'sí' : 'no', to: bool(p[c]) ? 'sí' : 'no' });
      }
    }
    if (changes.length) audit(req, { entity: 'roles', entityId: id, action: before ? 'update' : 'create', summary: `${before ? 'Modificación' : 'Alta'} rol ${b.name || before.name}`, changes });
    return id;
  });
}
router.post('/roles', wrap((req, res) => res.status(201).json({ id: saveRole(req, null) })));
router.put('/roles/:id', wrap((req, res) => {
  const before = get('SELECT * FROM roles WHERE id = ?', Number(req.params.id));
  if (!before) throw httpError(404, 'No encontrado');
  res.json({ id: saveRole(req, before) });
}));
router.delete('/roles/:id', wrap((req, res) => {
  const r = get('SELECT * FROM roles WHERE id = ?', Number(req.params.id));
  if (!r) throw httpError(404, 'No encontrado');
  run(`UPDATE roles SET deleted_at = datetime('now') WHERE id = ?`, r.id);
  audit(req, { entity: 'roles', entityId: r.id, action: 'delete', summary: `Rol a la papelera: ${r.name}` });
  res.json({ ok: true });
}));
router.post('/roles/:id/restore', wrap((req, res) => {
  run('UPDATE roles SET deleted_at = NULL WHERE id = ?', Number(req.params.id));
  audit(req, { entity: 'roles', entityId: Number(req.params.id), action: 'restore', summary: 'Rol restaurado' });
  res.json({ ok: true });
}));

// ---------- aplicaciones y campos dinámicos ----------
router.get('/field-types', (req, res) => res.json(FIELD_TYPES));
router.get('/apps', wrap((req, res) => {
  res.json(all('SELECT * FROM apps ORDER BY sort, name').map((a) => ({ ...a, fields: appFields(a.id, true) })));
}));
router.post('/apps', wrap((req, res) => {
  const b = req.body || {};
  const key = String(b.key || '').trim().toLowerCase();
  if (!KEY_RE.test(key)) throw httpError(400, 'Clave no válida (minúsculas, números y _; empezar por letra)');
  if (!String(b.name || '').trim()) throw httpError(400, 'El nombre es obligatorio');
  if (get('SELECT id FROM apps WHERE key = ?', key)) throw httpError(409, 'Ya existe una aplicación con esa clave');
  const id = tx(() => {
    const sort = (get('SELECT MAX(sort) m FROM apps').m || 0) + 1;
    const appId = Number(run('INSERT INTO apps (key, name, icon, color, description, sort) VALUES (?,?,?,?,?,?)', key, b.name, b.icon || '📁', b.color || '#64748b', b.description || '', sort).lastInsertRowid);
    run(`INSERT INTO fields (app_id, key, label, type, required, sort) VALUES (?, 'nombre', 'Nombre', 'text', 1, 0)`, appId);
    run(`UPDATE apps SET title_field = 'nombre' WHERE id = ?`, appId);
    return appId;
  });
  audit(req, { entity: 'apps', entityId: id, action: 'create', summary: `Nueva aplicación: ${b.name}` });
  res.status(201).json({ id });
}));
router.put('/apps/:id', wrap((req, res) => {
  const before = get('SELECT * FROM apps WHERE id = ?', Number(req.params.id));
  if (!before) throw httpError(404, 'No encontrada');
  const d = pick(req.body, ['name', 'icon', 'color', 'description', 'active', 'title_field', 'sort']);
  if ('active' in d) d.active = bool(d.active);
  const keys = Object.keys(d);
  if (keys.length) run(`UPDATE apps SET ${keys.map((k) => k + ' = ?').join(',')} WHERE id = ?`, ...keys.map((k) => d[k]), before.id);
  const changes = diff(pick(before, keys), d);
  if (changes.length) audit(req, { entity: 'apps', entityId: before.id, action: 'update', summary: `Aplicación ${before.name}`, changes });
  res.json({ ok: true });
}));
router.put('/apps-order', wrap((req, res) => {
  (req.body.ids || []).forEach((id, i) => run('UPDATE apps SET sort = ? WHERE id = ?', i, Number(id)));
  res.json({ ok: true });
}));

function fieldData(b, isNew) {
  const d = pick(b, ['label', 'type', 'required', 'unique_value', 'show_in_list', 'width', 'help', 'active']);
  if (isNew || 'label' in d) if (!String(d.label || '').trim()) throw httpError(400, 'La etiqueta es obligatoria');
  if ('type' in d && !FIELD_TYPES[d.type]) throw httpError(400, 'Tipo de campo no válido');
  for (const k of ['required', 'unique_value', 'show_in_list', 'active']) if (k in d) d[k] = bool(d[k]);
  if ('width' in d && !['half', 'full', 'third'].includes(d.width)) d.width = 'half';
  if ('choices' in b) {
    const choices = (Array.isArray(b.choices) ? b.choices : String(b.choices).split('\n')).map((s) => String(s).trim()).filter(Boolean);
    d.options = JSON.stringify({ choices });
  }
  return d;
}
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'c_$1').slice(0, 40);

router.post('/apps/:id/fields', wrap((req, res) => {
  const app = get('SELECT * FROM apps WHERE id = ?', Number(req.params.id));
  if (!app) throw httpError(404, 'Aplicación no encontrada');
  const d = fieldData(req.body || {}, true);
  let key = String(req.body.key || slug(d.label)).trim().toLowerCase();
  if (!KEY_RE.test(key)) throw httpError(400, 'Clave de campo no válida');
  let n = 2; const base = key;
  while (get('SELECT id FROM fields WHERE app_id = ? AND key = ?', app.id, key)) key = `${base}_${n++}`;
  d.type = d.type || 'text';
  d.sort = (get('SELECT MAX(sort) m FROM fields WHERE app_id = ?', app.id).m ?? -1) + 1;
  if (!d.width) d.width = d.type === 'textarea' ? 'full' : 'half';
  const keys = Object.keys(d);
  const id = Number(run(`INSERT INTO fields (app_id, key, ${keys.join(',')}) VALUES (?, ?, ${keys.map(() => '?').join(',')})`, app.id, key, ...keys.map((k) => d[k])).lastInsertRowid);
  audit(req, { entity: 'fields', entityId: id, appId: app.id, action: 'create', summary: `Nuevo campo "${d.label}" (${d.type}) en ${app.name}` });
  res.status(201).json({ id, key });
}));
router.put('/fields/:id', wrap((req, res) => {
  const before = get('SELECT * FROM fields WHERE id = ?', Number(req.params.id));
  if (!before) throw httpError(404, 'Campo no encontrado');
  const d = fieldData(req.body || {}, false);
  if ('type' in d && d.type !== before.type && (d.type === 'password' || before.type === 'password')) {
    throw httpError(400, 'No se puede convertir un campo a/desde contraseña (crea un campo nuevo)');
  }
  const keys = Object.keys(d);
  if (keys.length) run(`UPDATE fields SET ${keys.map((k) => k + ' = ?').join(',')} WHERE id = ?`, ...keys.map((k) => d[k]), before.id);
  const changes = diff(pick(before, keys), d);
  if (changes.length) audit(req, { entity: 'fields', entityId: before.id, appId: before.app_id, action: 'update', summary: `Campo "${before.label}"`, changes });
  res.json({ ok: true });
}));
router.put('/apps/:id/fields-order', wrap((req, res) => {
  tx(() => (req.body.ids || []).forEach((id, i) => run('UPDATE fields SET sort = ? WHERE id = ? AND app_id = ?', i, Number(id), Number(req.params.id))));
  audit(req, { entity: 'apps', entityId: Number(req.params.id), appId: Number(req.params.id), action: 'update', summary: 'Reordenación de campos por defecto' });
  res.json({ ok: true });
}));

// ---------- ajustes ----------
const SETTINGS = ['public_url', 'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from', 'app_name'];
router.get('/settings', wrap((req, res) => {
  const out = {};
  for (const k of SETTINGS) { const r = get('SELECT value FROM settings WHERE key = ?', k); out[k] = r ? r.value : ''; }
  out.smtp_pass = out.smtp_pass ? '••••••••' : '';
  res.json(out);
}));
router.put('/settings', wrap((req, res) => {
  const changes = [];
  for (const k of SETTINGS) {
    if (!(k in (req.body || {}))) continue;
    let v = String(req.body[k] ?? '');
    if (k === 'smtp_pass') { if (v === '••••••••') continue; v = v ? encrypt(v) : ''; }
    run('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v);
    changes.push({ field: k, from: '', to: k === 'smtp_pass' ? '••••' : v });
  }
  audit(req, { entity: 'settings', action: 'update', summary: 'Ajustes generales', changes });
  res.json({ ok: true });
}));
router.post('/settings/test-mail', wrap(async (req, res) => {
  const { sendMail } = require('../mailer');
  await sendMail({ to: req.body.to || req.user.email, subject: 'Prueba de correo', text: 'El correo saliente está configurado correctamente.' });
  res.json({ ok: true });
}));

// ---------- auditoría global ----------
function auditQuery(q) {
  const where = ['1'], params = [];
  if (q.entity) { where.push('a.entity = ?'); params.push(q.entity); }
  if (q.action) { where.push('a.action = ?'); params.push(q.action); }
  if (q.app_id) { where.push('a.app_id = ?'); params.push(Number(q.app_id)); }
  if (q.user_id) { where.push('a.user_id = ?'); params.push(Number(q.user_id)); }
  if (q.from) { where.push('a.ts >= ?'); params.push(q.from); }
  if (q.to) { where.push('a.ts <= ?'); params.push(q.to + ' 23:59:59'); }
  if (q.q) { where.push('(a.summary LIKE ? OR a.changes LIKE ? OR a.user_name LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  return { where: where.join(' AND '), params };
}
router.get('/audit', wrap((req, res) => {
  const { where, params } = auditQuery(req.query);
  const size = Math.min(Number(req.query.size) || 100, 500), page = Math.max(Number(req.query.page) || 1, 1);
  const total = get(`SELECT COUNT(*) n FROM audit_log a WHERE ${where}`, ...params).n;
  const rows = all(`SELECT a.*, ap.name app_name, c.name company_name FROM audit_log a LEFT JOIN apps ap ON ap.id = a.app_id LEFT JOIN companies c ON c.id = a.company_id
                    WHERE ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...params, size, (page - 1) * size);
  res.json({ total, rows: rows.map((r) => ({ ...r, changes: r.changes ? JSON.parse(r.changes) : [] })) });
}));
router.get('/audit/export', wrap(async (req, res) => {
  const { where, params } = auditQuery(req.query);
  const rows = all(`SELECT a.*, ap.name app_name, c.name company_name FROM audit_log a LEFT JOIN apps ap ON ap.id = a.app_id LEFT JOIN companies c ON c.id = a.company_id WHERE ${where} ORDER BY a.id DESC LIMIT 100000`, ...params);
  const header = ['Fecha', 'Usuario', 'Empresa', 'Aplicación', 'Entidad', 'ID', 'Acción', 'Resumen', 'Cambios', 'IP'];
  const matrix = rows.map((r) => [r.ts, r.user_name, r.company_name || '', r.app_name || '', r.entity, r.entity_id, r.action, r.summary,
    (r.changes ? JSON.parse(r.changes) : []).map((c) => `${c.field}: ${c.from} → ${c.to}`).join(' | '), r.ip]);
  await sendSheet(res, 'auditoria', header, matrix, req.query.format);
}));

module.exports = router;
