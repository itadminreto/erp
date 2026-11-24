'use strict';
// Administración (solo super admin): empresas, centros, usuarios, roles, aplicaciones, campos, ajustes y auditoría.
const express = require('express');
const { all, get, run, tx } = require('../db');
const { PERMS, hash } = require('../auth');
const { FIELD_TYPES, appFields, parseField, normalize } = require('../fields');
const { encrypt } = require('../crypto');
const { audit, diff } = require('../audit');
const { sendMail } = require('../mailer');
const { wrap, httpError, sendSheet } = require('./records');
const multer = require('multer');
const backup = require('../backup');

const uploadLogo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
const uploadBackup = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const router = express.Router();
const KEY_RE = /^[a-z][a-z0-9_]{0,40}$/;

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj && k in obj).map((k) => [k, obj[k]]));
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const q = (c) => '`' + c + '`'; // escapa nombres de columna (p. ej. `key`)

/** CRUD genérico con borrado lógico y trazabilidad para tablas simples. */
const strip = (r) => { if (r) delete r.logo; return r; };

// ---------- campos dinámicos de empresas y centros ----------
const ENTITIES = { companies: 'Empresas', centers: 'Centros' };
// Claves reservadas (columnas fijas) que no pueden usarse como campo dinámico
const RESERVED = ['id', 'name', 'cif', 'address', 'email', 'phone', 'notes', 'active', 'code', 'kind', 'company_id', 'logo', 'extra', 'created_at', 'deleted_at'];
const entityFields = async (entity, inactive = false) =>
  (await all(`SELECT * FROM entity_fields WHERE entity = ? ${inactive ? '' : 'AND active = 1'} ORDER BY sort, id`, entity)).map(parseField);
const parseExtra = (r) => { if (r) { try { r.extra = r.extra ? JSON.parse(r.extra) : {}; } catch { r.extra = {}; } } return r; };

/** Valida los datos extra (campos dinámicos) y devuelve el JSON resultante mezclado con el anterior. */
async function buildExtra(entity, table, input, before) {
  const fields = await entityFields(entity);
  const prev = before ? parseExtra({ extra: before.extra }).extra : {};
  const out = { ...prev };
  const errors = [];
  const users = await all('SELECT id, name, email FROM users WHERE deleted_at IS NULL');
  for (const f of fields) {
    if (!input || !(f.key in input)) continue;
    try { out[f.key] = normalize(f, input[f.key], { users }); } catch (e) { errors.push(e.message); }
  }
  for (const f of fields) {
    const v = out[f.key];
    if (f.required && (v === undefined || v === '' || v === null || (Array.isArray(v) && !v.length))) errors.push(`${f.label}: obligatorio`);
    if (f.unique_value && v !== '' && v !== undefined && v !== null) {
      const dup = await get(`SELECT id FROM ${table} WHERE deleted_at IS NULL AND id <> ? AND LOWER(JSON_VALUE(extra, '$.${f.key}')) = LOWER(?) LIMIT 1`,
        before ? before.id : 0, String(v));
      if (dup) errors.push(`${f.label}: ya existe otro registro con "${v}"`);
    }
  }
  if (errors.length) throw httpError(400, errors.join(' · '));
  return out;
}

/** CRUD genérico con borrado lógico, campos dinámicos (`extra`) y trazabilidad para tablas simples. */
function crud(entity, table, cols, { orderBy = 'id', validate = () => {}, listSql, labelOf = (r) => r.name } = {}) {
  const dynamic = !!ENTITIES[entity];
  const reload = async (id) => strip(parseExtra(await get(`SELECT * FROM ${table} WHERE id = ?`, id)));
  router.get(`/${entity}`, wrap(async (req, res) => {
    const trash = req.query.trash === '1';
    const sql = listSql || `SELECT * FROM ${table}`;
    const rows = await all(`${sql} ${sql.includes('WHERE') ? 'AND' : 'WHERE'} ${trash ? '1' : `${table}.deleted_at IS NULL`} ORDER BY ${orderBy}`);
    res.json(dynamic ? rows.map(parseExtra) : rows);
  }));
  router.post(`/${entity}`, wrap(async (req, res) => {
    const data = pick(req.body, cols);
    validate(data, null);
    if (dynamic) data.extra = JSON.stringify(await buildExtra(entity, table, req.body.extra || {}, null));
    const keys = Object.keys(data);
    const id = Number((await run(`INSERT INTO ${table} (${keys.map(q).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => data[k]))).lastInsertRowid);
    const shown = { ...data }; if (dynamic) { delete shown.extra; Object.assign(shown, JSON.parse(data.extra)); }
    await audit(req, { entity, entityId: id, action: 'create', summary: `Alta: ${labelOf(data)}`, changes: diff({}, shown) });
    res.status(201).json(await reload(id));
  }));
  router.put(`/${entity}/:id`, wrap(async (req, res) => {
    const before = await get(`SELECT * FROM ${table} WHERE id = ?`, Number(req.params.id));
    if (!before) throw httpError(404, 'No encontrado');
    const data = pick(req.body, cols);
    validate(data, before);
    let changes = diff(pick(before, Object.keys(data)), data);
    if (dynamic && req.body.extra && typeof req.body.extra === 'object') {
      const extra = await buildExtra(entity, table, req.body.extra, before);
      changes = changes.concat(diff(parseExtra({ extra: before.extra }).extra, extra));
      data.extra = JSON.stringify(extra);
    }
    const keys = Object.keys(data);
    if (keys.length) await run(`UPDATE ${table} SET ${keys.map((k) => `${q(k)} = ?`).join(',')} WHERE id = ?`, ...keys.map((k) => data[k]), before.id);
    if (changes.length) await audit(req, { entity, entityId: before.id, action: 'update', summary: `Modificación: ${labelOf({ ...before, ...data })}`, changes });
    res.json(await reload(before.id));
  }));
  router.delete(`/${entity}/:id`, wrap(async (req, res) => {
    const r = await get(`SELECT * FROM ${table} WHERE id = ?`, Number(req.params.id));
    if (!r) throw httpError(404, 'No encontrado');
    await run(`UPDATE ${table} SET deleted_at = UTC_TIMESTAMP() WHERE id = ?`, r.id);
    await audit(req, { entity, entityId: r.id, action: 'delete', summary: `Enviado a la papelera: ${labelOf(r)}` });
    res.json({ ok: true });
  }));
  router.post(`/${entity}/:id/restore`, wrap(async (req, res) => {
    const r = await get(`SELECT * FROM ${table} WHERE id = ?`, Number(req.params.id));
    if (!r) throw httpError(404, 'No encontrado');
    await run(`UPDATE ${table} SET deleted_at = NULL WHERE id = ?`, r.id);
    await audit(req, { entity, entityId: r.id, action: 'restore', summary: `Restaurado: ${labelOf(r)}` });
    res.json({ ok: true });
  }));
}

// Definición de los campos dinámicos de empresas y centros (mismo editor que en las aplicaciones)
const checkEntity = (e) => { if (!ENTITIES[e]) throw httpError(404, 'Entidad no válida'); return e; };
router.get('/entity-fields/:entity', wrap(async (req, res) => res.json(await entityFields(checkEntity(req.params.entity), req.query.all === '1'))));
router.post('/entity-fields/:entity', wrap(async (req, res) => {
  const entity = checkEntity(req.params.entity);
  const d = fieldData(req.body || {}, true);
  if (d.type === 'password') throw httpError(400, 'Las contraseñas solo pueden usarse en las aplicaciones');
  let key = String(req.body.key || slug(d.label)).trim().toLowerCase();
  if (!KEY_RE.test(key)) throw httpError(400, 'Clave de campo no válida');
  if (RESERVED.includes(key)) key = `${key}_2`;
  let n = 2; const base = key;
  while (await get('SELECT id FROM entity_fields WHERE entity = ? AND `key` = ?', entity, key)) key = `${base}_${n++}`;
  d.type = d.type || 'text';
  d.sort = ((await get('SELECT MAX(sort) m FROM entity_fields WHERE entity = ?', entity)).m ?? -1) + 1;
  if (!d.width) d.width = d.type === 'textarea' ? 'full' : 'half';
  const keys = Object.keys(d);
  const id = Number((await run(`INSERT INTO entity_fields (entity, \`key\`, ${keys.map(q).join(',')}) VALUES (?, ?, ${keys.map(() => '?').join(',')})`, entity, key, ...keys.map((k) => d[k]))).lastInsertRowid);
  await audit(req, { entity: 'fields', entityId: id, action: 'create', summary: `Nuevo campo "${d.label}" (${d.type}) en ${ENTITIES[entity]}` });
  res.status(201).json({ id, key });
}));
router.put('/entity-fields/:entity/order', wrap(async (req, res) => {
  const entity = checkEntity(req.params.entity);
  await tx(async () => { for (const [i, id] of (req.body.ids || []).entries()) await run('UPDATE entity_fields SET sort = ? WHERE id = ? AND entity = ?', i, Number(id), entity); });
  res.json({ ok: true });
}));
router.put('/entity-fields/:entity/:id', wrap(async (req, res) => {
  const entity = checkEntity(req.params.entity);
  const before = await get('SELECT * FROM entity_fields WHERE id = ? AND entity = ?', Number(req.params.id), entity);
  if (!before) throw httpError(404, 'Campo no encontrado');
  const d = fieldData(req.body || {}, false);
  if (d.type === 'password') throw httpError(400, 'Las contraseñas solo pueden usarse en las aplicaciones');
  const keys = Object.keys(d);
  if (keys.length) await run(`UPDATE entity_fields SET ${keys.map((k) => q(k) + ' = ?').join(',')} WHERE id = ?`, ...keys.map((k) => d[k]), before.id);
  const changes = diff(pick(before, keys), d);
  if (changes.length) await audit(req, { entity: 'fields', entityId: before.id, action: 'update', summary: `Campo "${before.label}" de ${ENTITIES[entity]}`, changes });
  res.json({ ok: true });
}));

// ---------- empresas y centros ----------
crud('companies', 'companies', ['name', 'cif', 'address', 'email', 'phone', 'notes', 'active'], {
  orderBy: 'name',
  listSql: 'SELECT id, name, cif, address, email, phone, notes, active, created_at, deleted_at, extra, (logo IS NOT NULL) has_logo FROM companies',
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

// Logo de empresa (PNG, JPG, WebP o GIF; máx. 2 MB). Se guarda en la propia BD para que entre en las copias.
router.post('/companies/:id/logo', uploadLogo.single('file'), wrap(async (req, res) => {
  const c = await get('SELECT id, name FROM companies WHERE id = ?', Number(req.params.id));
  if (!c) throw httpError(404, 'Empresa no encontrada');
  if (!req.file) throw httpError(400, 'Adjunta una imagen');
  if (!LOGO_TYPES.includes(req.file.mimetype)) throw httpError(400, 'Formato no admitido: usa PNG, JPG, WebP o GIF');
  await run('UPDATE companies SET logo = ? WHERE id = ?', `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`, c.id);
  await audit(req, { entity: 'companies', entityId: c.id, action: 'update', summary: `Logo actualizado: ${c.name}` });
  res.json({ ok: true });
}));
router.delete('/companies/:id/logo', wrap(async (req, res) => {
  const c = await get('SELECT id, name FROM companies WHERE id = ?', Number(req.params.id));
  if (!c) throw httpError(404, 'Empresa no encontrada');
  await run('UPDATE companies SET logo = NULL WHERE id = ?', c.id);
  await audit(req, { entity: 'companies', entityId: c.id, action: 'update', summary: `Logo eliminado: ${c.name}` });
  res.json({ ok: true });
}));

// ---------- usuarios ----------
router.get('/users', wrap(async (req, res) => {
  const trash = req.query.trash === '1';
  const users = await all(`SELECT id, email, name, phone, is_superadmin, active, must_change_password, created_at, last_login, deleted_at
                     FROM users ${trash ? '' : 'WHERE deleted_at IS NULL'} ORDER BY name`);
  const asg = await all(`SELECT a.*, r.name role_name, c.name company_name, ce.name center_name, ce.code center_code
                   FROM user_assignments a JOIN roles r ON r.id = a.role_id JOIN companies c ON c.id = a.company_id
                   LEFT JOIN centers ce ON ce.id = a.center_id`);
  res.json(users.map((u) => ({ ...u, assignments: asg.filter((a) => a.user_id === u.id) })));
}));

async function saveUser(req, before) {
  const b = req.body || {};
  const d = pick(b, ['email', 'name', 'phone', 'is_superadmin', 'active', 'must_change_password']);
  if ('email' in d) { d.email = String(d.email).trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+$/.test(d.email)) throw httpError(400, 'Email no válido'); }
  if (!before && (!d.email || !String(d.name || '').trim())) throw httpError(400, 'Nombre y email obligatorios');
  for (const k of ['is_superadmin', 'active', 'must_change_password']) if (k in d) d[k] = bool(d[k]);
  if (before && before.id === req.user.id && (d.is_superadmin === 0 || d.active === 0)) throw httpError(400, 'No puedes quitarte tus propios privilegios ni desactivarte');
  const dup = d.email && await get('SELECT id FROM users WHERE email = ? AND id <> ?', d.email, before ? before.id : 0);
  if (dup) throw httpError(409, 'Ya existe un usuario con ese email');
  if (b.password) { if (String(b.password).length < 8) throw httpError(400, 'La contraseña debe tener al menos 8 caracteres'); d.password_hash = hash(b.password); }
  if (!before && !d.password_hash) throw httpError(400, 'Indica una contraseña inicial');

  return tx(async () => {
    let id;
    const keys = Object.keys(d);
    if (before) {
      id = before.id;
      if (keys.length) await run(`UPDATE users SET ${keys.map((k) => k + ' = ?').join(',')} WHERE id = ?`, ...keys.map((k) => d[k]), id);
    } else {
      id = Number((await run(`INSERT INTO users (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => d[k]))).lastInsertRowid);
    }
    const shown = { ...d }; delete shown.password_hash;
    const changes = diff(before ? pick(before, Object.keys(shown)) : {}, shown);
    if (d.password_hash) changes.push({ field: 'password', from: '', to: '•••• (cambiada)' });
    if (Array.isArray(b.assignments)) {
      const fmt = (l) => l.map((x) => `${x.company_id}/${x.center_id ?? '*'}/${x.role_id}`).sort().join(', ');
      const prev = await all('SELECT role_id, company_id, center_id FROM user_assignments WHERE user_id = ?', id);
      await run('DELETE FROM user_assignments WHERE user_id = ?', id);
      for (const a of b.assignments) {
        if (!a.role_id || !a.company_id) continue;
        await run('INSERT INTO user_assignments (user_id, role_id, company_id, center_id) VALUES (?,?,?,?)', id, Number(a.role_id), Number(a.company_id), a.center_id ? Number(a.center_id) : null);
      }
      const now = await all('SELECT role_id, company_id, center_id FROM user_assignments WHERE user_id = ?', id);
      if (fmt(prev) !== fmt(now)) changes.push({ field: 'asignaciones (empresa/centro/rol)', from: fmt(prev), to: fmt(now) });
    }
    if (d.active === 0) await run('DELETE FROM sessions WHERE user_id = ?', id);
    if (changes.length) await audit(req, { entity: 'users', entityId: id, action: before ? 'update' : 'create', summary: `${before ? 'Modificación' : 'Alta'} usuario ${d.name || before.name}`, changes });
    return id;
  });
}
router.post('/users', wrap(async (req, res) => res.status(201).json({ id: await saveUser(req, null) })));
router.put('/users/:id', wrap(async (req, res) => {
  const before = await get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!before) throw httpError(404, 'No encontrado');
  res.json({ id: await saveUser(req, before) });
}));
router.delete('/users/:id', wrap(async (req, res) => {
  const u = await get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!u) throw httpError(404, 'No encontrado');
  if (u.id === req.user.id) throw httpError(400, 'No puedes borrarte a ti mismo');
  await run(`UPDATE users SET deleted_at = UTC_TIMESTAMP(), active = 0 WHERE id = ?`, u.id);
  await run('DELETE FROM sessions WHERE user_id = ?', u.id);
  await audit(req, { entity: 'users', entityId: u.id, action: 'delete', summary: `Usuario a la papelera: ${u.name}` });
  res.json({ ok: true });
}));
router.post('/users/:id/restore', wrap(async (req, res) => {
  const u = await get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!u) throw httpError(404, 'No encontrado');
  await run('UPDATE users SET deleted_at = NULL, active = 1 WHERE id = ?', u.id);
  await audit(req, { entity: 'users', entityId: u.id, action: 'restore', summary: `Usuario restaurado: ${u.name}` });
  res.json({ ok: true });
}));

// ---------- roles y políticas por aplicación ----------
router.get('/roles', wrap(async (req, res) => {
  const roles = await all(`SELECT * FROM roles ${req.query.trash === '1' ? '' : 'WHERE deleted_at IS NULL'} ORDER BY name`);
  const perms = await all('SELECT * FROM role_permissions');
  res.json({ perms: PERMS, roles: roles.map((r) => ({ ...r, permissions: perms.filter((p) => p.role_id === r.id) })) });
}));
async function saveRole(req, before) {
  const b = req.body || {};
  if (!before && !String(b.name || '').trim()) throw httpError(400, 'El nombre es obligatorio');
  return tx(async () => {
    let id = before && before.id;
    if (before) await run('UPDATE roles SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?', b.name ?? null, b.description ?? null, id);
    else id = Number((await run('INSERT INTO roles (name, description) VALUES (?,?)', b.name, b.description || '')).lastInsertRowid);
    const changes = before ? diff(pick(before, ['name', 'description']), pick(b, ['name', 'description'])) : [{ field: 'name', from: '', to: b.name }];
    if (Array.isArray(b.permissions)) {
      const cols = [...PERMS.map((p) => 'can_' + p), 'only_own'];
      const prev = Object.fromEntries((await all('SELECT * FROM role_permissions WHERE role_id = ?', id)).map((p) => [p.app_id, p]));
      const appNames = Object.fromEntries((await all('SELECT id, name FROM apps')).map((a) => [a.id, a.name]));
      await run('DELETE FROM role_permissions WHERE role_id = ?', id);
      for (const p of b.permissions) {
        if (!p.app_id) continue;
        await run(`INSERT INTO role_permissions (role_id, app_id, ${cols.join(',')}) VALUES (?,?,${cols.map(() => '?').join(',')})`, id, Number(p.app_id), ...cols.map((c) => bool(p[c])));
        const old = prev[p.app_id] || {};
        for (const c of cols) if (bool(old[c]) !== bool(p[c])) changes.push({ field: `${appNames[p.app_id]}.${c}`, from: bool(old[c]) ? 'sí' : 'no', to: bool(p[c]) ? 'sí' : 'no' });
      }
    }
    if (changes.length) await audit(req, { entity: 'roles', entityId: id, action: before ? 'update' : 'create', summary: `${before ? 'Modificación' : 'Alta'} rol ${b.name || before.name}`, changes });
    return id;
  });
}
router.post('/roles', wrap(async (req, res) => res.status(201).json({ id: await saveRole(req, null) })));
router.put('/roles/:id', wrap(async (req, res) => {
  const before = await get('SELECT * FROM roles WHERE id = ?', Number(req.params.id));
  if (!before) throw httpError(404, 'No encontrado');
  res.json({ id: await saveRole(req, before) });
}));
router.delete('/roles/:id', wrap(async (req, res) => {
  const r = await get('SELECT * FROM roles WHERE id = ?', Number(req.params.id));
  if (!r) throw httpError(404, 'No encontrado');
  await run(`UPDATE roles SET deleted_at = UTC_TIMESTAMP() WHERE id = ?`, r.id);
  await audit(req, { entity: 'roles', entityId: r.id, action: 'delete', summary: `Rol a la papelera: ${r.name}` });
  res.json({ ok: true });
}));
router.post('/roles/:id/restore', wrap(async (req, res) => {
  await run('UPDATE roles SET deleted_at = NULL WHERE id = ?', Number(req.params.id));
  await audit(req, { entity: 'roles', entityId: Number(req.params.id), action: 'restore', summary: 'Rol restaurado' });
  res.json({ ok: true });
}));

// ---------- aplicaciones y campos dinámicos ----------
router.get('/field-types', (req, res) => res.json(FIELD_TYPES));
router.get('/apps', wrap(async (req, res) => {
  const apps = await all('SELECT * FROM apps ORDER BY sort, name');
  for (const a of apps) a.fields = await appFields(a.id, true);
  res.json(apps);
}));
router.post('/apps', wrap(async (req, res) => {
  const b = req.body || {};
  const key = String(b.key || '').trim().toLowerCase();
  if (!KEY_RE.test(key)) throw httpError(400, 'Clave no válida (minúsculas, números y _; empezar por letra)');
  if (!String(b.name || '').trim()) throw httpError(400, 'El nombre es obligatorio');
  if (await get('SELECT id FROM apps WHERE `key` = ?', key)) throw httpError(409, 'Ya existe una aplicación con esa clave');
  const id = await tx(async () => {
    const sort = ((await get('SELECT MAX(sort) m FROM apps')).m || 0) + 1;
    const appId = Number((await run('INSERT INTO apps (`key`, name, icon, color, description, sort, title_field) VALUES (?,?,?,?,?,?,?)',
      key, b.name, b.icon || '📁', b.color || '#64748b', b.description || '', sort, 'nombre')).lastInsertRowid);
    await run("INSERT INTO fields (app_id, `key`, label, type, required, sort) VALUES (?, 'nombre', 'Nombre', 'text', 1, 0)", appId);
    return appId;
  });
  await audit(req, { entity: 'apps', entityId: id, action: 'create', summary: `Nueva aplicación: ${b.name}` });
  res.status(201).json({ id });
}));
router.put('/apps/:id', wrap(async (req, res) => {
  const before = await get('SELECT * FROM apps WHERE id = ?', Number(req.params.id));
  if (!before) throw httpError(404, 'No encontrada');
  const d = pick(req.body, ['name', 'icon', 'color', 'description', 'active', 'title_field', 'sort', 'calendar']);
  if ('active' in d) d.active = bool(d.active);
  if ('calendar' in d) d.calendar = bool(d.calendar);
  const keys = Object.keys(d);
  if (keys.length) await run(`UPDATE apps SET ${keys.map((k) => q(k) + ' = ?').join(',')} WHERE id = ?`, ...keys.map((k) => d[k]), before.id);
  const changes = diff(pick(before, keys), d);
  if (changes.length) await audit(req, { entity: 'apps', entityId: before.id, action: 'update', summary: `Aplicación ${before.name}`, changes });
  res.json({ ok: true });
}));
router.put('/apps-order', wrap(async (req, res) => {
  await tx(async () => { for (const [i, id] of (req.body.ids || []).entries()) await run('UPDATE apps SET sort = ? WHERE id = ?', i, Number(id)); });
  res.json({ ok: true });
}));

function fieldData(b, isNew) {
  const d = pick(b, ['label', 'type', 'required', 'unique_value', 'show_in_list', 'width', 'help', 'active']);
  if ((isNew || 'label' in d) && !String(d.label || '').trim()) throw httpError(400, 'La etiqueta es obligatoria');
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

router.post('/apps/:id/fields', wrap(async (req, res) => {
  const app = await get('SELECT * FROM apps WHERE id = ?', Number(req.params.id));
  if (!app) throw httpError(404, 'Aplicación no encontrada');
  const d = fieldData(req.body || {}, true);
  let key = String(req.body.key || slug(d.label)).trim().toLowerCase();
  if (!KEY_RE.test(key)) throw httpError(400, 'Clave de campo no válida');
  let n = 2; const base = key;
  while (await get('SELECT id FROM fields WHERE app_id = ? AND `key` = ?', app.id, key)) key = `${base}_${n++}`;
  d.type = d.type || 'text';
  d.sort = ((await get('SELECT MAX(sort) m FROM fields WHERE app_id = ?', app.id)).m ?? -1) + 1;
  if (!d.width) d.width = d.type === 'textarea' ? 'full' : 'half';
  const keys = Object.keys(d);
  const id = Number((await run(`INSERT INTO fields (app_id, \`key\`, ${keys.map(q).join(',')}) VALUES (?, ?, ${keys.map(() => '?').join(',')})`, app.id, key, ...keys.map((k) => d[k]))).lastInsertRowid);
  await audit(req, { entity: 'fields', entityId: id, appId: app.id, action: 'create', summary: `Nuevo campo "${d.label}" (${d.type}) en ${app.name}` });
  res.status(201).json({ id, key });
}));
router.put('/fields/:id', wrap(async (req, res) => {
  const before = await get('SELECT * FROM fields WHERE id = ?', Number(req.params.id));
  if (!before) throw httpError(404, 'Campo no encontrado');
  const d = fieldData(req.body || {}, false);
  if ('type' in d && d.type !== before.type && (d.type === 'password' || before.type === 'password')) {
    throw httpError(400, 'No se puede convertir un campo a/desde contraseña (crea un campo nuevo)');
  }
  const keys = Object.keys(d);
  if (keys.length) await run(`UPDATE fields SET ${keys.map((k) => q(k) + ' = ?').join(',')} WHERE id = ?`, ...keys.map((k) => d[k]), before.id);
  const changes = diff(pick(before, keys), d);
  if (changes.length) await audit(req, { entity: 'fields', entityId: before.id, appId: before.app_id, action: 'update', summary: `Campo "${before.label}"`, changes });
  res.json({ ok: true });
}));
router.put('/apps/:id/fields-order', wrap(async (req, res) => {
  await tx(async () => { for (const [i, id] of (req.body.ids || []).entries()) await run('UPDATE fields SET sort = ? WHERE id = ? AND app_id = ?', i, Number(id), Number(req.params.id)); });
  await audit(req, { entity: 'apps', entityId: Number(req.params.id), appId: Number(req.params.id), action: 'update', summary: 'Reordenación de campos por defecto' });
  res.json({ ok: true });
}));

// ---------- ajustes ----------
const SETTINGS = ['public_url', 'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from', 'app_name', 'backup_auto', 'backup_keep'];
router.get('/settings', wrap(async (req, res) => {
  const out = Object.fromEntries(SETTINGS.map((k) => [k, '']));
  for (const r of await all('SELECT `key`, value FROM settings')) if (r.key in out) out[r.key] = r.value || '';
  out.smtp_pass = out.smtp_pass ? '••••••••' : '';
  if (out.backup_auto === '') out.backup_auto = '1';
  if (out.backup_keep === '') out.backup_keep = '14';
  res.json(out);
}));
router.put('/settings', wrap(async (req, res) => {
  const changes = [];
  for (const k of SETTINGS) {
    if (!(k in (req.body || {}))) continue;
    let v = String(req.body[k] ?? '');
    if (k === 'smtp_pass') { if (v === '••••••••') continue; v = v ? encrypt(v) : ''; }
    await run('INSERT INTO settings (`key`, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value = VALUES(value)', k, v);
    changes.push({ field: k, from: '', to: k === 'smtp_pass' ? '••••' : v });
  }
  await audit(req, { entity: 'settings', action: 'update', summary: 'Ajustes generales', changes });
  res.json({ ok: true });
}));
router.post('/settings/test-mail', wrap(async (req, res) => {
  await sendMail({ to: req.body.to || req.user.email, subject: 'Prueba de correo', text: 'El correo saliente está configurado correctamente.' });
  res.json({ ok: true });
}));

// ---------- copias de seguridad ----------
router.get('/backups', wrap(async (req, res) => res.json({ dir: backup.BACKUP_DIR, list: backup.listBackups() })));
router.post('/backups', wrap(async (req, res) => {
  const b = await backup.createBackup('manual');
  await audit(req, { entity: 'backup', action: 'backup', summary: `Copia de seguridad creada: ${b.name}` });
  res.status(201).json(b);
}));
router.get('/backups/:name', wrap(async (req, res) => {
  const file = backup.backupPath(req.params.name);
  await audit(req, { entity: 'backup', action: 'export', summary: `Copia de seguridad descargada: ${req.params.name}` });
  res.download(file, req.params.name);
}));
router.delete('/backups/:name', wrap(async (req, res) => {
  backup.deleteBackup(req.params.name);
  await audit(req, { entity: 'backup', action: 'delete', summary: `Copia de seguridad borrada: ${req.params.name}` });
  res.json({ ok: true });
}));
async function doRestore(req, res, buf, label) {
  const r = await backup.restoreBackup(buf, { force: req.query.force === '1' });
  await audit(req, { entity: 'backup', action: 'restore', summary: `Restaurada la copia ${label} (del ${r.created_at}). Copia previa: ${r.safety}`, changes: Object.entries(r.counts).map(([k, v]) => ({ field: k, from: '', to: `${v} filas` })) });
  res.json(r);
}
router.post('/backups/:name/restore', wrap(async (req, res) => {
  const fsMod = require('fs');
  await doRestore(req, res, fsMod.readFileSync(backup.backupPath(req.params.name)), req.params.name);
}));
router.post('/backups-upload', uploadBackup.single('file'), wrap(async (req, res) => {
  if (!req.file) throw httpError(400, 'Adjunta el archivo de copia (.json.gz)');
  const name = backup.saveUploaded(req.file.buffer);
  if (req.query.restore === '1') return doRestore(req, res, req.file.buffer, req.file.originalname);
  res.status(201).json({ name });
}));

// ---------- auditoría global ----------
function auditQuery(qs) {
  const where = ['1'], params = [];
  if (qs.entity) { where.push('a.entity = ?'); params.push(qs.entity); }
  if (qs.action) { where.push('a.action = ?'); params.push(qs.action); }
  if (qs.app_id) { where.push('a.app_id = ?'); params.push(Number(qs.app_id)); }
  if (qs.user_id) { where.push('a.user_id = ?'); params.push(Number(qs.user_id)); }
  if (qs.from) { where.push('a.ts >= ?'); params.push(qs.from); }
  if (qs.to) { where.push('a.ts <= ?'); params.push(qs.to + ' 23:59:59'); }
  if (qs.q) { where.push('(a.summary LIKE ? OR a.changes LIKE ? OR a.user_name LIKE ?)'); params.push(`%${qs.q}%`, `%${qs.q}%`, `%${qs.q}%`); }
  return { where: where.join(' AND '), params };
}
const AUDIT_SELECT = 'SELECT a.*, ap.name app_name, c.name company_name FROM audit_log a LEFT JOIN apps ap ON ap.id = a.app_id LEFT JOIN companies c ON c.id = a.company_id';
router.get('/audit', wrap(async (req, res) => {
  const { where, params } = auditQuery(req.query);
  const size = Math.min(Number(req.query.size) || 100, 500), page = Math.max(Number(req.query.page) || 1, 1);
  const total = (await get(`SELECT COUNT(*) n FROM audit_log a WHERE ${where}`, ...params)).n;
  const rows = await all(`${AUDIT_SELECT} WHERE ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...params, size, (page - 1) * size);
  res.json({ total, rows: rows.map((r) => ({ ...r, changes: r.changes ? JSON.parse(r.changes) : [] })) });
}));
router.get('/audit/export', wrap(async (req, res) => {
  const { where, params } = auditQuery(req.query);
  const rows = await all(`${AUDIT_SELECT} WHERE ${where} ORDER BY a.id DESC LIMIT 100000`, ...params);
  const header = ['Fecha', 'Usuario', 'Empresa', 'Aplicación', 'Entidad', 'ID', 'Acción', 'Resumen', 'Cambios', 'IP'];
  const matrix = rows.map((r) => [r.ts, r.user_name, r.company_name || '', r.app_name || '', r.entity, r.entity_id, r.action, r.summary,
    (r.changes ? JSON.parse(r.changes) : []).map((c) => `${c.field}: ${c.from} → ${c.to}`).join(' | '), r.ip]);
  await sendSheet(res, 'auditoria', header, matrix, req.query.format);
}));

module.exports = router;
