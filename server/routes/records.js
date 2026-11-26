'use strict';
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { all, get, run, tx, sqlDate, nextNumber } = require('../db');
const { grantsFor, can, summary, sqlFilter } = require('../auth');
const { appFields, normalize, toText } = require('../fields');
const { encrypt, decrypt, shortCode } = require('../crypto');
const { audit, diff } = require('../audit');
const { parseCSV, toCSV } = require('../csv');
const { sendMail, publicUrl } = require('../mailer');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const MASK = '••••••••';
const KEY_RE = /^[a-z][a-z0-9_]*$/;

// ---------- utilidades ----------
const httpError = (status, msg) => Object.assign(new Error(msg), { status });

/** Expresión SQL que extrae el valor escalar de un campo del JSON `data` (clave validada). */
function jv(key, alias = 'r') {
  if (!KEY_RE.test(key)) throw httpError(400, 'Clave de campo no válida');
  return `JSON_VALUE(${alias ? alias + '.' : ''}data, '$.${key}')`;
}

const activeUsers = () => all('SELECT id, name, email, phone FROM users WHERE deleted_at IS NULL ORDER BY name');
const companyCenters = (companyId) => all('SELECT id, code, name, kind FROM centers WHERE company_id = ? AND deleted_at IS NULL AND active = 1 ORDER BY code, name', companyId);
/** Centros que el usuario puede ver en esta app (los de sus asignaciones; todos si tiene acceso a toda la empresa). */
const visibleCenters = async (req) => (await companyCenters(req.companyId)).filter((c) => can(req.grants, 'view', req.user, { center_id: c.id }));

/** Carga la app, sus campos y los permisos del usuario en la empresa activa. */
router.param('appKey', async (req, res, next, key) => {
  try {
    const app = await get('SELECT * FROM apps WHERE `key` = ? AND active = 1', key);
    if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });
    if (!req.companyId) return res.status(403).json({ error: 'No tienes ninguna empresa asignada' });
    req.appDef = app;
    req.fields = await appFields(app.id);
    req.grants = await grantsFor(req.user, req.companyId, app.id);
    if (!req.grants.view.length) return res.status(403).json({ error: 'Sin acceso a esta aplicación' });
  } catch (e) { return next(e); }
  next();
});

const SELECT_REC = `SELECT r.*, c.name center_name, c.code center_code, uc.name created_by_name, uu.name updated_by_name, ud.name deleted_by_name
  FROM records r LEFT JOIN centers c ON c.id = r.center_id
  LEFT JOIN users uc ON uc.id = r.created_by LEFT JOIN users uu ON uu.id = r.updated_by LEFT JOIN users ud ON ud.id = r.deleted_by`;

async function getRecord(req, id) {
  const r = await get(`${SELECT_REC} WHERE r.id = ? AND r.app_id = ? AND r.company_id = ?`, Number(id), req.appDef.id, req.companyId);
  if (!r) throw httpError(404, 'Registro no encontrado');
  const perm = r.deleted_at ? 'view_trash' : 'view';
  if (!can(req.grants, perm, req.user, r)) throw httpError(403, 'Sin permiso sobre este registro');
  return r;
}

function serialize(req, r, full = true) {
  const data = JSON.parse(r.data || '{}');
  const out = {};
  for (const f of req.fields) {
    const v = data[f.key];
    if (f.type === 'password') out[f.key] = v ? MASK : '';
    else if (f.type === 'signature') out[f.key] = v && v.img ? (full ? v : { signed: true, at: v.at }) : '';
    else if (f.type === 'image') out[f.key] = Array.isArray(v) ? (full ? v : { count: v.length }) : [];
    else out[f.key] = v ?? '';
  }
  const g = req.grants, u = req.user;
  return {
    id: r.id, number: r.number, center_id: r.center_id, center_name: r.center_name, center_code: r.center_code,
    data: out,
    created_at: r.created_at, updated_at: r.updated_at, created_by_name: r.created_by_name, updated_by_name: r.updated_by_name,
    deleted_at: r.deleted_at, deleted_by_name: r.deleted_by_name,
    can: {
      edit: !r.deleted_at && can(g, 'edit', u, r),
      delete: !r.deleted_at && can(g, 'delete', u, r),
      restore: !!r.deleted_at && can(g, 'restore', u, r),
      purge: !!r.deleted_at && can(g, 'purge', u, r),
      view_passwords: can(g, 'view_passwords', u, r),
      share_passwords: can(g, 'share_passwords', u, r),
      view_history: can(g, 'view_history', u, r),
    },
  };
}

/** Valida y normaliza el payload de un registro. `existing` = datos actuales (cifrados). */
function buildData(req, input, existing, ctx) {
  const data = { ...(existing || {}) };
  const errors = [];
  for (const f of req.fields) {
    if (!(f.key in input)) continue;
    const v = input[f.key];
    if (f.type === 'password') {
      if (v === MASK) continue; // sin cambios
      if (v && f.max_length && String(v).length > f.max_length) { errors.push(`${f.label}: máximo ${f.max_length} caracteres`); continue; }
      data[f.key] = v ? encrypt(String(v)) : '';
      continue;
    }
    if (f.type === 'image') {
      // lista de { id } (ya guardadas) o { data, name } (nuevas, se guardan tras grabar el registro)
      const prev = Array.isArray(existing && existing[f.key]) ? existing[f.key] : [];
      const items = Array.isArray(v) ? v : [];
      const max = f.options.multiple ? 20 : 1;
      if (items.length > max) { errors.push(`${f.label}: máximo ${max} imagen${max > 1 ? 'es' : ''}`); continue; }
      const out = [];
      for (const it of items) {
        if (it && it.id) { const old = prev.find((x) => x.id === Number(it.id)); if (old) out.push(old); continue; }
        const m = it && typeof it.data === 'string' && it.data.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
        if (!m) { errors.push(`${f.label}: imagen no válida (JPG, PNG o WebP)`); continue; }
        const size = Math.floor(m[2].length * 3 / 4);
        if (size > 4 * 1024 * 1024) { errors.push(`${f.label}: imagen demasiado grande (máx. 4 MB)`); continue; }
        out.push({ pending: true, mime: m[1], b64: m[2], size, name: String(it.name || 'imagen').slice(0, 200), w: Number(it.w) || null, h: Number(it.h) || null });
      }
      data[f.key] = out;
      continue;
    }
    if (f.type === 'signature') {
      const img = v && typeof v === 'object' ? v.img : v;
      if (img && existing && existing[f.key] && existing[f.key].img === img) continue; // misma firma
      try { data[f.key] = normalize(f, img ? { img } : '', ctx); } catch (e) { errors.push(e.message); }
      continue;
    }
    try { data[f.key] = normalize(f, v, ctx); } catch (e) { errors.push(e.message); }
  }
  for (const f of req.fields) {
    const v = data[f.key];
    if (f.required && (v === undefined || v === '' || v === null || (Array.isArray(v) && !v.length))) errors.push(`${f.label}: obligatorio`);
  }
  if (errors.length) throw httpError(400, errors.join(' · '));
  return data;
}

async function checkUnique(req, data, exceptId = 0) {
  for (const f of req.fields.filter((x) => x.unique_value && x.type !== 'password')) {
    const v = data[f.key];
    if (v === '' || v === undefined || v === null) continue;
    const dup = await get(
      `SELECT id, number FROM records WHERE app_id = ? AND company_id = ? AND deleted_at IS NULL AND id <> ?
       AND LOWER(${jv(f.key, '')}) = LOWER(?) LIMIT 1`,
      req.appDef.id, req.companyId, exceptId, String(v));
    if (dup) throw httpError(409, `${f.label}: ya existe un registro con "${v}" (Nº ${dup.number})`);
  }
}

async function checkCenter(req, centerId, perm) {
  if (centerId !== null && !(await get('SELECT id FROM centers WHERE id = ? AND company_id = ? AND deleted_at IS NULL', centerId, req.companyId))) {
    throw httpError(400, 'Centro no válido para la empresa activa');
  }
  if (!can(req.grants, perm, req.user, { center_id: centerId })) {
    throw httpError(403, centerId === null ? 'Debes indicar un centro' : 'Sin permiso en ese centro');
  }
}

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { fail(res, e); }
};
function fail(res, e) {
  if (!e.status) console.error(e);
  if (res.headersSent) return res.end();
  const body = { error: e.status ? e.message : 'Error interno: ' + e.message };
  if (e.status && typeof e.code === 'string' && /^[a-z_]+$/.test(e.code)) body.code = e.code;
  res.status(e.status || 500).json(body);
}
const pwKeysOf = (req) => req.fields.filter((f) => f.type === 'password').map((f) => f.key);
/** Vista de los datos para la auditoría: las firmas se registran como «Firmado (fecha)», no la imagen. */
const auditView = (req, data) => {
  const out = { ...data };
  for (const f of req.fields) {
    if (f.type === 'signature') out[f.key] = data[f.key] && data[f.key].img ? `Firmado (${data[f.key].at})` : '';
    if (f.type === 'image') {
      const l = Array.isArray(data[f.key]) ? data[f.key] : [];
      out[f.key] = l.length ? `${l.length} imagen${l.length > 1 ? 'es' : ''} (${l.map((x) => (x.pending ? 'nueva' : x.id)).join(', ')})` : '';
    }
  }
  return out;
};

// ---------- catálogo de apps ----------
router.get('/', wrap(async (req, res) => {
  if (!req.companyId) return res.json([]);
  const apps = await all('SELECT * FROM apps WHERE active = 1 ORDER BY sort, name');
  const out = [];
  for (const a of apps) {
    const g = await grantsFor(req.user, req.companyId, a.id);
    if (!g.view.length) continue;
    const f = sqlFilter(g, 'view', req.user);
    const n = (await get(`SELECT COUNT(*) n FROM records r WHERE app_id = ? AND company_id = ? AND deleted_at IS NULL AND ${f.sql}`, a.id, req.companyId, ...f.params)).n;
    out.push({ ...a, count: n, perms: summary(g) });
  }
  res.json(out);
}));

router.get('/:appKey', wrap(async (req, res) => {
  const layouts = {};
  for (const l of await all('SELECT kind, config FROM user_layouts WHERE user_id = ? AND app_id = ?', req.user.id, req.appDef.id)) {
    layouts[l.kind] = JSON.parse(l.config);
  }
  const centers = (await visibleCenters(req)).map((c) => ({
    ...c, can_create: can(req.grants, 'create', req.user, { center_id: c.id }),
  }));
  res.json({
    app: req.appDef, fields: req.fields, perms: summary(req.grants),
    can_create_without_center: can(req.grants, 'create', req.user, { center_id: null }),
    can_view_without_center: can(req.grants, 'view', req.user, { center_id: null }),
    centers, users: await activeUsers(), layouts,
  });
}));

router.put('/:appKey/layout/:kind', wrap(async (req, res) => {
  const kind = req.params.kind;
  if (!['list', 'form'].includes(kind)) throw httpError(400, 'Tipo de diseño no válido');
  if (req.body && req.body.reset) {
    await run('DELETE FROM user_layouts WHERE user_id = ? AND app_id = ? AND kind = ?', req.user.id, req.appDef.id, kind);
  } else {
    await run(`INSERT INTO user_layouts (user_id, app_id, kind, config) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE config = VALUES(config)`,
      req.user.id, req.appDef.id, kind, JSON.stringify(req.body || {}));
  }
  res.json({ ok: true });
}));

// ---------- listado ----------
function listQuery(req, q) {
  const where = ['r.app_id = ?', 'r.company_id = ?'];
  const params = [req.appDef.id, req.companyId];
  const fv = sqlFilter(req.grants, 'view', req.user);
  const trash = q.trash === '1' || q.trash === 'only';
  if (trash && req.grants.view_trash.length) {
    const ft = sqlFilter(req.grants, 'view_trash', req.user);
    if (q.trash === 'only') { where.push(`r.deleted_at IS NOT NULL AND ${ft.sql}`); params.push(...ft.params); }
    else { where.push(`((r.deleted_at IS NULL AND ${fv.sql}) OR (r.deleted_at IS NOT NULL AND ${ft.sql}))`); params.push(...fv.params, ...ft.params); }
  } else {
    where.push(`r.deleted_at IS NULL AND ${fv.sql}`); params.push(...fv.params);
  }
  if (q.center) {
    if (q.center === 'none') where.push('r.center_id IS NULL');
    else { where.push('r.center_id = ?'); params.push(Number(q.center)); }
  }
  if (q.q) {
    const terms = String(q.q).trim().split(/\s+/).slice(0, 5);
    for (const t of terms) {
      where.push(`(r.data LIKE ? OR c.name LIKE ? OR c.code LIKE ? OR CAST(r.number AS CHAR) = ?)`);
      params.push(`%${t}%`, `%${t}%`, `%${t}%`, t);
    }
  }
  // rango de fechas (vista calendario): date_field, from, to (AAAA-MM-DD)
  if (q.date_field) {
    const f = req.fields.find((x) => x.key === q.date_field && ['date', 'datetime'].includes(x.type));
    if (!f) throw httpError(400, 'Campo de fecha no válido');
    const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
    where.push(`LEFT(${jv(f.key)}, 10) BETWEEN ? AND ?`);
    params.push(ok(q.from) ? q.from : '0000-01-01', ok(q.to) ? q.to : '9999-12-31');
  }
  // filtros por columna: f_<campo>=valor
  for (const [k, v] of Object.entries(q)) {
    if (!k.startsWith('f_') || v === '') continue;
    const key = k.slice(2);
    const f = req.fields.find((x) => x.key === key);
    if (!f || f.type === 'password') continue;
    if (f.type === 'checkbox') {
      where.push(`${jv(key)} = ?`); params.push(v === '1' || v === 'true' ? 'true' : 'false');
    } else if (['select', 'user'].includes(f.type)) {
      where.push(`${jv(key)} = ?`); params.push(String(v));
    } else {
      where.push(`${jv(key)} LIKE ?`); params.push(`%${v}%`);
    }
  }
  let order = 'r.updated_at DESC';
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  if (q.sort) {
    const f = req.fields.find((x) => x.key === q.sort && x.type !== 'password');
    if (['id', 'number', 'created_at', 'updated_at', 'deleted_at'].includes(q.sort)) order = `r.${q.sort} ${dir}`;
    else if (q.sort === 'center') order = `c.code ${dir}, c.name ${dir}`;
    else if (f) {
      order = ['number', 'decimal'].includes(f.type) ? `CAST(${jv(f.key)} AS DECIMAL(20,6)) ${dir}`
        : f.type === 'ip' ? `LENGTH(INET6_ATON(SUBSTRING_INDEX(${jv(f.key)}, '/', 1))) ${dir}, INET6_ATON(SUBSTRING_INDEX(${jv(f.key)}, '/', 1)) ${dir}`
        : `${jv(f.key)} ${dir}`;
    }
  }
  return { where: where.join(' AND '), params, order };
}

router.get('/:appKey/records', wrap(async (req, res) => {
  const { where, params, order } = listQuery(req, req.query);
  const size = Math.min(Math.max(Number(req.query.size) || 50, 1), 1000);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const total = (await get(`SELECT COUNT(*) n FROM records r LEFT JOIN centers c ON c.id = r.center_id WHERE ${where}`, ...params)).n;
  const rows = await all(`${SELECT_REC} WHERE ${where} ORDER BY ${order}, r.id DESC LIMIT ? OFFSET ?`, ...params, size, (page - 1) * size);
  res.json({ total, page, size, rows: rows.map((r) => serialize(req, r, false)) });
}));

router.get('/:appKey/records/:id', wrap(async (req, res) => res.json(serialize(req, await getRecord(req, req.params.id)))));

// ---------- alta / modificación ----------
/**
 * Guarda en record_files las imágenes nuevas del registro, borra las que ya no están y deja en el JSON solo
 * las referencias { id, name, w, h, at }. Devuelve los datos finales.
 */
async function storeImages(req, recId, data) {
  const imgFields = req.fields.filter((f) => f.type === 'image');
  if (!imgFields.length) return data;
  let changed = false;
  for (const f of imgFields) {
    const list = Array.isArray(data[f.key]) ? data[f.key] : [];
    const out = [];
    for (const it of list) {
      if (!it.pending) { out.push(it); continue; }
      const id = Number((await run(`INSERT INTO record_files (record_id, field_key, name, mime, size, width, height, data, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
        recId, f.key, it.name, it.mime, it.size, it.w, it.h, it.b64, req.user.id)).lastInsertRowid);
      out.push({ id, name: it.name, mime: it.mime, w: it.w, h: it.h, at: new Date().toISOString() });
      changed = true;
    }
    data[f.key] = out;
    const keep = out.map((x) => x.id);
    const del = await run(`DELETE FROM record_files WHERE record_id = ? AND field_key = ?${keep.length ? ` AND id NOT IN (${keep.map(() => '?').join(',')})` : ''}`, recId, f.key, ...keep);
    if (del.changes) changed = true;
  }
  if (changed) await run('UPDATE records SET data = ? WHERE id = ?', JSON.stringify(data), recId);
  return data;
}

async function insertRecord(req, centerId, data, summaryText) {
  const number = await nextNumber(req.appDef.id, req.companyId);
  const id = Number((await run(`INSERT INTO records (app_id, company_id, number, center_id, data, created_by, updated_by) VALUES (?,?,?,?,?,?,?)`,
    req.appDef.id, req.companyId, number, centerId, JSON.stringify(data), req.user.id, req.user.id)).lastInsertRowid);
  await storeImages(req, id, data);
  await audit(req, { entity: 'record', entityId: id, action: 'create', appId: req.appDef.id, companyId: req.companyId,
    summary: `${summaryText} · Nº ${number}`, changes: diff({}, { ...auditView(req, data), _centro: centerId }, pwKeysOf(req)) });
  return id;
}
async function updateRecord(req, rec, centerId, data, summaryText) {
  const changes = diff({ ...auditView(req, JSON.parse(rec.data)), _centro: rec.center_id }, { ...auditView(req, data), _centro: centerId }, pwKeysOf(req));
  if (!changes.length) return false;
  await run(`UPDATE records SET data = ?, center_id = ?, updated_by = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?`,
    JSON.stringify(data), centerId, req.user.id, rec.id);
  await storeImages(req, rec.id, data);
  await audit(req, { entity: 'record', entityId: rec.id, action: 'update', appId: req.appDef.id, companyId: req.companyId,
    summary: summaryText || `Modificación (${changes.length} campo/s)`, changes });
  return true;
}

router.post('/:appKey/records', wrap(async (req, res) => {
  const body = req.body || {};
  const centerId = body.center_id ? Number(body.center_id) : null;
  await checkCenter(req, centerId, 'create');
  const data = buildData(req, body.data || {}, {}, { users: await activeUsers() });
  const id = await tx(async () => {
    await checkUnique(req, data);
    return insertRecord(req, centerId, data, `Alta en ${req.appDef.name}`);
  });
  res.status(201).json(serialize(req, await getRecord(req, id)));
}));

router.put('/:appKey/records/:id', wrap(async (req, res) => {
  const rec = await getRecord(req, req.params.id);
  if (rec.deleted_at) throw httpError(400, 'El registro está en la papelera: restáuralo primero');
  if (!can(req.grants, 'edit', req.user, rec)) throw httpError(403, 'Sin permiso de edición');
  const body = req.body || {};
  let centerId = rec.center_id;
  if ('center_id' in body) {
    centerId = body.center_id ? Number(body.center_id) : null;
    if (centerId !== rec.center_id) await checkCenter(req, centerId, 'edit');
  }
  const data = buildData(req, body.data || {}, JSON.parse(rec.data), { users: await activeUsers() });
  await tx(async () => {
    await checkUnique(req, data, rec.id);
    await updateRecord(req, rec, centerId, data);
  });
  res.json(serialize(req, await getRecord(req, rec.id)));
}));

// ---------- papelera ----------
async function softDelete(req, rec) {
  if (rec.deleted_at) return;
  if (!can(req.grants, 'delete', req.user, rec)) throw httpError(403, 'Sin permiso para borrar');
  await run(`UPDATE records SET deleted_at = UTC_TIMESTAMP(), deleted_by = ? WHERE id = ?`, req.user.id, rec.id);
  await audit(req, { entity: 'record', entityId: rec.id, action: 'delete', appId: req.appDef.id, companyId: req.companyId, summary: 'Enviado a la papelera' });
}
async function restore(req, rec) {
  if (!rec.deleted_at) return;
  if (!can(req.grants, 'restore', req.user, rec)) throw httpError(403, 'Sin permiso para restaurar');
  await checkUnique(req, JSON.parse(rec.data), rec.id);
  await run(`UPDATE records SET deleted_at = NULL, deleted_by = NULL, updated_at = UTC_TIMESTAMP(), updated_by = ? WHERE id = ?`, req.user.id, rec.id);
  await audit(req, { entity: 'record', entityId: rec.id, action: 'restore', appId: req.appDef.id, companyId: req.companyId, summary: 'Restaurado desde la papelera' });
}
async function purge(req, rec) {
  if (!rec.deleted_at) throw httpError(400, 'Solo se pueden eliminar definitivamente registros de la papelera');
  if (!can(req.grants, 'purge', req.user, rec)) throw httpError(403, 'Sin permiso para eliminar definitivamente');
  await audit(req, { entity: 'record', entityId: rec.id, action: 'purge', appId: req.appDef.id, companyId: req.companyId,
    summary: `Eliminado definitivamente (Nº ${rec.number})`, changes: diff(auditView(req, JSON.parse(rec.data)), {}, pwKeysOf(req)) });
  await run('DELETE FROM share_links WHERE record_id = ?', rec.id);
  await run('DELETE FROM records WHERE id = ?', rec.id);
}

router.delete('/:appKey/records/:id', wrap(async (req, res) => { const r = await getRecord(req, req.params.id); await tx(() => softDelete(req, r)); res.json({ ok: true }); }));
router.post('/:appKey/records/:id/restore', wrap(async (req, res) => { const r = await getRecord(req, req.params.id); await tx(() => restore(req, r)); res.json({ ok: true }); }));
router.delete('/:appKey/records/:id/purge', wrap(async (req, res) => { const r = await getRecord(req, req.params.id); await tx(() => purge(req, r)); res.json({ ok: true }); }));

router.post('/:appKey/bulk', wrap(async (req, res) => {
  const { action, ids = [] } = req.body || {};
  const fn = { delete: softDelete, restore, purge }[action];
  if (!fn) throw httpError(400, 'Acción no válida');
  let ok = 0; const errors = [];
  for (const id of ids.slice(0, 1000)) {
    try { const r = await getRecord(req, id); await tx(() => fn(req, r)); ok++; } catch (e) { errors.push(`#${id}: ${e.message}`); }
  }
  res.json({ ok, errors });
}));

// ---------- imágenes ----------
router.get('/:appKey/records/:id/files/:fid', wrap(async (req, res) => {
  const rec = await getRecord(req, req.params.id); // comprueba permisos sobre el registro
  const f = await get('SELECT mime, data FROM record_files WHERE id = ? AND record_id = ?', Number(req.params.fid), rec.id);
  if (!f) throw httpError(404, 'Imagen no encontrada');
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Cache-Control', 'private, max-age=86400'); // el id de una imagen no cambia de contenido
  res.send(Buffer.from(f.data, 'base64'));
}));

// ---------- historial ----------
router.get('/:appKey/records/:id/history', wrap(async (req, res) => {
  const rec = await getRecord(req, req.params.id);
  if (!can(req.grants, 'view_history', req.user, rec)) throw httpError(403, 'Sin permiso para ver el historial');
  const rows = await all(`SELECT id, ts, user_name, action, summary, changes, ip FROM audit_log WHERE entity = 'record' AND entity_id = ? ORDER BY id DESC`, rec.id);
  res.json(rows.map((r) => ({ ...r, changes: r.changes ? JSON.parse(r.changes) : [] })));
}));

// ---------- contraseñas ----------
function passwordField(req, key) {
  const f = req.fields.find((x) => x.key === key && x.type === 'password');
  if (!f) throw httpError(400, 'Campo de contraseña no válido');
  return f;
}
router.get('/:appKey/records/:id/password/:field', wrap(async (req, res) => {
  const rec = await getRecord(req, req.params.id);
  const f = passwordField(req, req.params.field);
  if (!can(req.grants, 'view_passwords', req.user, rec)) throw httpError(403, 'Sin permiso para ver contraseñas');
  const value = decrypt(JSON.parse(rec.data)[f.key]);
  await audit(req, { entity: 'record', entityId: rec.id, action: 'reveal', appId: req.appDef.id, companyId: req.companyId, summary: `Contraseña consultada: ${f.label}` });
  res.json({ value });
}));

router.post('/:appKey/records/:id/share', wrap(async (req, res) => {
  const rec = await getRecord(req, req.params.id);
  if (rec.deleted_at) throw httpError(400, 'El registro está en la papelera');
  const f = passwordField(req, (req.body || {}).field);
  if (!can(req.grants, 'share_passwords', req.user, rec)) throw httpError(403, 'Sin permiso para enviar contraseñas');
  const { channel, to = '', hours = 24, include_plain = false, max_views = 1 } = req.body;
  const data = JSON.parse(rec.data);
  const secret = decrypt(data[f.key]);
  if (!secret) throw httpError(400, 'La contraseña está vacía');
  const title = data[req.appDef.title_field] || `Nº ${rec.number}`;
  const code = shortCode(10);
  const h = Math.min(Math.max(Number(hours) || 24, 1), 24 * 30);
  await run(`INSERT INTO share_links (code, record_id, field_key, created_by, expires_at, max_views) VALUES (?,?,?,?,?,?)`,
    code, rec.id, f.key, req.user.id, sqlDate(Date.now() + h * 3600e3), Math.min(Math.max(Number(max_views) || 1, 1), 20));
  const link = `${await publicUrl(req)}/s/${code}`;
  const text = include_plain
    ? `${req.appDef.name} · ${title}\n${f.label}: ${secret}`
    : `${req.appDef.name} · ${title}\nConsulta "${f.label}" en este enlace de un solo uso (caduca en ${h} h):\n${link}`;
  const result = { code, link, expires_hours: h, text };
  if (channel === 'email') {
    if (!to) throw httpError(400, 'Indica el email de destino');
    await sendMail({ to, subject: `${req.appDef.name}: ${title}`, text });
    result.sent = true;
  } else if (channel === 'whatsapp') {
    result.url = `https://wa.me/${String(to).replace(/[^\d]/g, '')}?text=${encodeURIComponent(text)}`;
  } else if (channel === 'sms') {
    result.url = `sms:${String(to).replace(/[^\d+]/g, '')}?body=${encodeURIComponent(text)}`;
  }
  await audit(req, { entity: 'record', entityId: rec.id, action: 'share', appId: req.appDef.id, companyId: req.companyId,
    summary: `Contraseña "${f.label}" compartida por ${channel || 'enlace'}${to ? ' a ' + to : ''}${include_plain ? ' (en claro)' : ' (enlace de un solo uso)'}` });
  res.json(result);
}));

// ---------- exportación ----------
async function exportRows(req) {
  const { where, params, order } = listQuery(req, req.query);
  const ids = req.query.ids ? String(req.query.ids).split(',').map(Number).filter(Boolean) : null;
  let rows = await all(`${SELECT_REC} WHERE ${where} ORDER BY ${order}, r.id DESC`, ...params);
  if (ids) rows = rows.filter((r) => ids.includes(r.id));
  return rows;
}
async function sendSheet(res, name, header, matrix, format) {
  const fname = `${name}_${new Date().toISOString().slice(0, 10)}`;
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}.csv"`);
    return res.send('﻿' + toCSV([header, ...matrix], ';'));
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(name.slice(0, 31));
  ws.addRow(header).font = { bold: true };
  matrix.forEach((r) => ws.addRow(r));
  ws.columns.forEach((c, i) => { c.width = Math.min(Math.max(String(header[i] || '').length + 4, 12), 50); });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: header.length } };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

router.get('/:appKey/export', wrap(async (req, res) => {
  if (!req.grants.export.length) throw httpError(403, 'Sin permiso de exportación');
  const withPw = req.query.passwords === '1' && req.grants.view_passwords.length > 0;
  const rows = await exportRows(req);
  const users = Object.fromEntries((await activeUsers()).map((u) => [u.id, u]));
  const fields = req.fields.filter((f) => f.type !== 'password' || withPw);
  const header = ['Nº', 'Centro', ...fields.map((f) => f.label), 'Creado', 'Modificado', 'Estado'];
  const matrix = rows.map((r) => {
    const d = JSON.parse(r.data);
    const rowCanPw = withPw && can(req.grants, 'view_passwords', req.user, r);
    return [r.number, r.center_code || r.center_name || '',
      ...fields.map((f) => (f.type === 'password' ? (rowCanPw ? decrypt(d[f.key]) : '') : toText(f, d[f.key], users))),
      r.created_at, r.updated_at, r.deleted_at ? 'BORRADO' : 'Activo'];
  });
  await audit(req, { entity: 'app', entityId: req.appDef.id, action: 'export', appId: req.appDef.id, companyId: req.companyId,
    summary: `Exportación ${req.query.format === 'csv' ? 'CSV' : 'Excel'} de ${rows.length} registros${withPw ? ' (con contraseñas)' : ''}` });
  await sendSheet(res, req.appDef.key, header, matrix, req.query.format);
}));

router.get('/:appKey/template', wrap(async (req, res) => {
  const header = ['Centro', ...req.fields.map((f) => f.label)];
  const example = ['CC01', ...req.fields.map((f) => ({
    select: (f.options.choices || [''])[0], multiselect: (f.options.choices || []).slice(0, 2).join(', '),
    date: '31/12/2026', checkbox: 'Sí', number: '1', decimal: '1,5', email: 'nombre@dominio.com',
  }[f.type] ?? ''))];
  await sendSheet(res, `plantilla_${req.appDef.key}`, header, [example], req.query.format);
}));

// ---------- importación ----------
const pendingImports = new Map(); // token -> { rows, header, userId, expires }
setInterval(() => { const n = Date.now(); for (const [k, v] of pendingImports) if (v.expires < n) pendingImports.delete(k); }, 60e3).unref();

async function readSheet(file) {
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.txt') || file.mimetype === 'text/csv') {
    return parseCSV(file.buffer.toString('utf8'));
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const out = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = [];
    for (let i = 1; i <= ws.columnCount; i++) {
      let v = row.getCell(i).value;
      if (v && typeof v === 'object' && !(v instanceof Date)) v = v.text ?? v.result ?? (v.richText ? v.richText.map((t) => t.text).join('') : v.hyperlink ?? '');
      vals.push(v ?? '');
    }
    out.push(vals);
  });
  return out;
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

router.post('/:appKey/import/preview', upload.single('file'), wrap(async (req, res) => {
  if (!req.grants.import.length) throw httpError(403, 'Sin permiso de importación');
  if (!req.file) throw httpError(400, 'Adjunta un fichero CSV o Excel');
  const matrix = (await readSheet(req.file)).filter((r) => r.some((c) => String(c).trim() !== ''));
  if (matrix.length < 2) throw httpError(400, 'El fichero no contiene datos (se espera una fila de cabecera y al menos una fila)');
  const header = matrix[0].map((h) => String(h).trim());
  const rows = matrix.slice(1);
  const targets = [{ key: '_id', label: 'Nº (actualizar existente)' }, { key: '_center', label: 'Centro (código o nombre)' },
    ...req.fields.filter((f) => !['signature', 'image'].includes(f.type)).map((f) => ({ key: f.key, label: f.label, type: f.type }))];
  const mapping = header.map((h) => {
    const n = norm(h);
    if (['id', 'n', 'no', 'numero', 'num', 'nparte', 'numerodetrabajo', 'ntrabajo'].includes(n)) return '_id';
    if (['centro', 'center', 'centrodetrabajo', 'centrodecoste', 'cc'].includes(n)) return '_center';
    const f = req.fields.find((x) => norm(x.label) === n || norm(x.key) === n);
    return f ? f.key : '';
  });
  const token = shortCode(16);
  pendingImports.set(token, { header, rows, userId: req.user.id, appId: req.appDef.id, companyId: req.companyId, expires: Date.now() + 30 * 60e3 });
  res.json({ token, header, mapping, targets, total: rows.length, sample: rows.slice(0, 5) });
}));

router.post('/:appKey/import/commit', wrap(async (req, res) => {
  if (!req.grants.import.length) throw httpError(403, 'Sin permiso de importación');
  const { token, mapping = [], default_center = null, match_field = '', dry_run = false } = req.body || {};
  const p = pendingImports.get(token);
  if (!p || p.userId !== req.user.id || p.appId !== req.appDef.id || p.companyId !== req.companyId) throw httpError(400, 'La importación ha caducado, vuelve a subir el fichero');
  const centers = await visibleCenters(req);
  const users = await activeUsers();
  const findCenter = (v) => {
    const s = norm(v);
    if (!s) return undefined;
    const c = centers.find((x) => norm(x.code) === s || norm(x.name) === s || String(x.id) === String(v).trim());
    if (!c) throw new Error(`Centro "${v}" no encontrado`);
    return c.id;
  };
  const matchF = match_field ? req.fields.find((f) => f.key === match_field && f.type !== 'password') : null;
  const result = { created: 0, updated: 0, skipped: 0, errors: [] };

  // Cada fila va en su propio SAVEPOINT; en simulación se deshace todo al final.
  const DRY = Symbol('dry');
  try {
    await tx(async () => {
      for (let i = 0; i < p.rows.length; i++) {
        const row = p.rows[i];
        await run(`SAVEPOINT fila`);
        try {
          const input = {}; let centerId; let recId = null;
          mapping.forEach((target, col) => {
            if (!target) return;
            const v = row[col];
            if (target === '_id') { if (String(v).trim()) recId = Number(v); }
            else if (target === '_center') centerId = findCenter(v);
            else input[target] = v ?? '';
          });
          let existing = null;
          if (recId) existing = await get('SELECT * FROM records WHERE number = ? AND app_id = ? AND company_id = ? AND deleted_at IS NULL', recId, req.appDef.id, req.companyId);
          if (!existing && matchF && input[matchF.key] !== undefined && String(input[matchF.key]).trim()) {
            const v = normalize(matchF, input[matchF.key], { users });
            existing = await get(`SELECT * FROM records WHERE app_id = ? AND company_id = ? AND deleted_at IS NULL
              AND LOWER(${jv(matchF.key, '')}) = LOWER(?) LIMIT 1`, req.appDef.id, req.companyId, String(v));
          }
          if (existing) {
            if (!can(req.grants, 'edit', req.user, existing)) throw new Error('sin permiso para modificar este registro');
            const newCenter = centerId === undefined ? existing.center_id : centerId;
            if (newCenter !== existing.center_id) await checkCenter(req, newCenter, 'edit');
            const data = buildData(req, input, JSON.parse(existing.data), { users });
            await checkUnique(req, data, existing.id);
            if (await updateRecord(req, existing, newCenter, data, 'Modificación por importación')) result.updated++;
            else result.skipped++;
          } else {
            const cId = centerId === undefined ? (default_center ? Number(default_center) : null) : centerId;
            await checkCenter(req, cId, 'create');
            const data = buildData(req, input, {}, { users });
            await checkUnique(req, data);
            await insertRecord(req, cId, data, 'Alta por importación');
            result.created++;
          }
          await run(`RELEASE SAVEPOINT fila`);
        } catch (e) {
          await run(`ROLLBACK TO SAVEPOINT fila`);
          result.errors.push(`Fila ${i + 2}: ${e.message}`);
        }
      }
      if (dry_run) throw DRY;
    });
  } catch (e) { if (e !== DRY) throw e; }

  if (!dry_run) {
    pendingImports.delete(token);
    await audit(req, { entity: 'app', entityId: req.appDef.id, action: 'import', appId: req.appDef.id, companyId: req.companyId,
      summary: `Importación: ${result.created} altas, ${result.updated} modificaciones, ${result.errors.length} errores` });
  }
  res.json(result);
}));

module.exports = { router, wrap, httpError, fail, sendSheet };
