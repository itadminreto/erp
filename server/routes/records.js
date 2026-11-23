'use strict';
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { all, get, run, tx } = require('../db');
const { grantsFor, can, summary, sqlFilter } = require('../auth');
const { appFields, normalize, toText } = require('../fields');
const { encrypt, decrypt, shortCode } = require('../crypto');
const { audit, diff } = require('../audit');
const { parseCSV, toCSV } = require('../csv');
const { sendMail, getSetting, publicUrl } = require('../mailer');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const MASK = '••••••••';
const KEY_RE = /^[a-z][a-z0-9_]*$/;

// ---------- utilidades ----------
const httpError = (status, msg) => Object.assign(new Error(msg), { status });

function activeUsers() {
  return all('SELECT id, name, email, phone FROM users WHERE deleted_at IS NULL ORDER BY name');
}
function companyCenters(companyId) {
  return all('SELECT id, code, name, kind FROM centers WHERE company_id = ? AND deleted_at IS NULL AND active = 1 ORDER BY code, name', companyId);
}

/** Carga la app, sus campos y los permisos del usuario en la empresa activa. */
router.param('appKey', (req, res, next, key) => {
  const app = get('SELECT * FROM apps WHERE key = ? AND active = 1', key);
  if (!app) return res.status(404).json({ error: 'Aplicación no encontrada' });
  if (!req.companyId) return res.status(403).json({ error: 'No tienes ninguna empresa asignada' });
  req.appDef = app;
  req.fields = appFields(app.id);
  req.grants = grantsFor(req.user, req.companyId, app.id);
  if (!req.grants.view.length) return res.status(403).json({ error: 'Sin acceso a esta aplicación' });
  next();
});

function getRecord(req, id) {
  const r = get(
    `SELECT r.*, c.name center_name, c.code center_code, uc.name created_by_name, uu.name updated_by_name, ud.name deleted_by_name
     FROM records r LEFT JOIN centers c ON c.id = r.center_id
     LEFT JOIN users uc ON uc.id = r.created_by LEFT JOIN users uu ON uu.id = r.updated_by LEFT JOIN users ud ON ud.id = r.deleted_by
     WHERE r.id = ? AND r.app_id = ? AND r.company_id = ?`, Number(id), req.appDef.id, req.companyId);
  if (!r) throw httpError(404, 'Registro no encontrado');
  const perm = r.deleted_at ? 'view_trash' : 'view';
  if (!can(req.grants, perm, req.user, r)) throw httpError(403, 'Sin permiso sobre este registro');
  return r;
}

function serialize(req, r) {
  const data = JSON.parse(r.data || '{}');
  const out = {};
  for (const f of req.fields) {
    const v = data[f.key];
    out[f.key] = f.type === 'password' ? (v ? MASK : '') : (v ?? '');
  }
  const g = req.grants, u = req.user;
  return {
    id: r.id, center_id: r.center_id, center_name: r.center_name, center_code: r.center_code,
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

/** Valida y normaliza el payload de un registro. `existing` = datos actuales (descifrados no). */
function buildData(req, input, existing = {}, ctx = {}) {
  const data = { ...existing };
  const errors = [];
  for (const f of req.fields) {
    if (!(f.key in input)) continue;
    let v = input[f.key];
    if (f.type === 'password') {
      if (v === MASK) continue; // sin cambios
      data[f.key] = v ? encrypt(String(v)) : '';
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

function checkUnique(req, data, exceptId = 0) {
  for (const f of req.fields.filter((x) => x.unique_value && x.type !== 'password')) {
    const v = data[f.key];
    if (v === '' || v === undefined || v === null) continue;
    const dup = get(
      `SELECT id FROM records WHERE app_id = ? AND company_id = ? AND deleted_at IS NULL AND id != ?
       AND lower(CAST(json_extract(data, ?) AS TEXT)) = lower(?)`,
      req.appDef.id, req.companyId, exceptId, `$.${f.key}`, String(v));
    if (dup) throw httpError(409, `${f.label}: ya existe un registro con "${v}" (#${dup.id})`);
  }
}

function checkCenter(req, centerId, perm) {
  if (centerId !== null && !get('SELECT id FROM centers WHERE id = ? AND company_id = ? AND deleted_at IS NULL', centerId, req.companyId)) {
    throw httpError(400, 'Centro no válido para la empresa activa');
  }
  if (!can(req.grants, perm, req.user, { center_id: centerId })) {
    throw httpError(403, centerId === null ? 'Debes indicar un centro' : 'Sin permiso en ese centro');
  }
}

const wrap = (fn) => (req, res) => {
  try { const r = fn(req, res); if (r && r.then) r.catch((e) => fail(res, e)); }
  catch (e) { fail(res, e); }
};
function fail(res, e) {
  if (!e.status) console.error(e);
  res.status(e.status || 500).json({ error: e.status ? e.message : 'Error interno: ' + e.message });
}

// ---------- catálogo de apps ----------
router.get('/', wrap((req, res) => {
  if (!req.companyId) return res.json([]);
  const apps = all('SELECT * FROM apps WHERE active = 1 ORDER BY sort, name');
  const out = [];
  for (const a of apps) {
    const g = grantsFor(req.user, req.companyId, a.id);
    if (!g.view.length) continue;
    const f = sqlFilter(g, 'view', req.user);
    const n = get(`SELECT COUNT(*) n FROM records r WHERE app_id = ? AND company_id = ? AND deleted_at IS NULL AND ${f.sql}`, a.id, req.companyId, ...f.params).n;
    out.push({ ...a, count: n, perms: summary(g) });
  }
  res.json(out);
}));

router.get('/:appKey', wrap((req, res) => {
  const layouts = {};
  for (const l of all('SELECT kind, config FROM user_layouts WHERE user_id = ? AND app_id = ?', req.user.id, req.appDef.id)) {
    layouts[l.kind] = JSON.parse(l.config);
  }
  const centers = companyCenters(req.companyId).map((c) => ({
    ...c, can_create: can(req.grants, 'create', req.user, { center_id: c.id }),
  }));
  res.json({
    app: req.appDef, fields: req.fields, perms: summary(req.grants),
    can_create_without_center: can(req.grants, 'create', req.user, { center_id: null }),
    centers, users: activeUsers(), layouts,
  });
}));

router.put('/:appKey/layout/:kind', wrap((req, res) => {
  const kind = req.params.kind;
  if (!['list', 'form'].includes(kind)) throw httpError(400, 'Tipo de diseño no válido');
  if (req.body && req.body.reset) {
    run('DELETE FROM user_layouts WHERE user_id = ? AND app_id = ? AND kind = ?', req.user.id, req.appDef.id, kind);
  } else {
    run(`INSERT INTO user_layouts (user_id, app_id, kind, config) VALUES (?,?,?,?)
         ON CONFLICT(user_id, app_id, kind) DO UPDATE SET config = excluded.config`,
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
      where.push(`(r.data LIKE ? OR c.name LIKE ? OR c.code LIKE ? OR CAST(r.id AS TEXT) = ?)`);
      params.push(`%${t}%`, `%${t}%`, `%${t}%`, t);
    }
  }
  // filtros por columna: f_<campo>=valor
  for (const [k, v] of Object.entries(q)) {
    if (!k.startsWith('f_') || v === '') continue;
    const key = k.slice(2);
    const f = req.fields.find((x) => x.key === key);
    if (!f || f.type === 'password') continue;
    if (['select', 'user', 'checkbox'].includes(f.type)) {
      where.push(`CAST(json_extract(r.data, ?) AS TEXT) = ?`);
      params.push(`$.${key}`, f.type === 'checkbox' ? (v === '1' || v === 'true' ? '1' : '0') : String(v));
    } else {
      where.push(`CAST(json_extract(r.data, ?) AS TEXT) LIKE ?`);
      params.push(`$.${key}`, `%${v}%`);
    }
  }
  let order = 'r.updated_at DESC';
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  if (q.sort) {
    if (['id', 'created_at', 'updated_at', 'deleted_at'].includes(q.sort)) order = `r.${q.sort} ${dir}`;
    else if (q.sort === 'center') order = `c.code ${dir}, c.name ${dir}`;
    else if (KEY_RE.test(q.sort) && req.fields.some((f) => f.key === q.sort && f.type !== 'password')) {
      order = `json_extract(r.data, '$.${q.sort}') COLLATE NOCASE ${dir}`;
    }
  }
  return { where: where.join(' AND '), params, order };
}

const SELECT_REC = `SELECT r.*, c.name center_name, c.code center_code, uc.name created_by_name, uu.name updated_by_name, ud.name deleted_by_name
  FROM records r LEFT JOIN centers c ON c.id = r.center_id
  LEFT JOIN users uc ON uc.id = r.created_by LEFT JOIN users uu ON uu.id = r.updated_by LEFT JOIN users ud ON ud.id = r.deleted_by`;

router.get('/:appKey/records', wrap((req, res) => {
  const { where, params, order } = listQuery(req, req.query);
  const size = Math.min(Math.max(Number(req.query.size) || 50, 1), 500);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const total = get(`SELECT COUNT(*) n FROM records r LEFT JOIN centers c ON c.id = r.center_id WHERE ${where}`, ...params).n;
  const rows = all(`${SELECT_REC} WHERE ${where} ORDER BY ${order}, r.id DESC LIMIT ? OFFSET ?`, ...params, size, (page - 1) * size);
  res.json({ total, page, size, rows: rows.map((r) => serialize(req, r)) });
}));

router.get('/:appKey/records/:id', wrap((req, res) => res.json(serialize(req, getRecord(req, req.params.id)))));

// ---------- alta / modificación ----------
router.post('/:appKey/records', wrap((req, res) => {
  const body = req.body || {};
  const centerId = body.center_id ? Number(body.center_id) : null;
  checkCenter(req, centerId, 'create');
  const data = buildData(req, body.data || {});
  checkUnique(req, data);
  const id = Number(run(`INSERT INTO records (app_id, company_id, center_id, data, created_by, updated_by) VALUES (?,?,?,?,?,?)`,
    req.appDef.id, req.companyId, centerId, JSON.stringify(data), req.user.id, req.user.id).lastInsertRowid);
  const pwKeys = req.fields.filter((f) => f.type === 'password').map((f) => f.key);
  audit(req, { entity: 'record', entityId: id, action: 'create', appId: req.appDef.id, companyId: req.companyId,
    summary: `Alta en ${req.appDef.name}`, changes: diff({}, { ...data, _centro: centerId }, pwKeys) });
  res.status(201).json(serialize(req, getRecord(req, id)));
}));

router.put('/:appKey/records/:id', wrap((req, res) => {
  const rec = getRecord(req, req.params.id);
  if (rec.deleted_at) throw httpError(400, 'El registro está en la papelera: restáuralo primero');
  if (!can(req.grants, 'edit', req.user, rec)) throw httpError(403, 'Sin permiso de edición');
  const body = req.body || {};
  const before = JSON.parse(rec.data);
  let centerId = rec.center_id;
  if ('center_id' in body) {
    centerId = body.center_id ? Number(body.center_id) : null;
    if (centerId !== rec.center_id) checkCenter(req, centerId, 'edit');
  }
  const data = buildData(req, body.data || {}, before);
  checkUnique(req, data, rec.id);
  const pwKeys = req.fields.filter((f) => f.type === 'password').map((f) => f.key);
  const changes = diff({ ...before, _centro: rec.center_id }, { ...data, _centro: centerId }, pwKeys);
  if (!changes.length) return res.json(serialize(req, rec));
  run(`UPDATE records SET data = ?, center_id = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
    JSON.stringify(data), centerId, req.user.id, rec.id);
  audit(req, { entity: 'record', entityId: rec.id, action: 'update', appId: req.appDef.id, companyId: req.companyId,
    summary: `Modificación (${changes.length} campo/s)`, changes });
  res.json(serialize(req, getRecord(req, rec.id)));
}));

// ---------- papelera ----------
function softDelete(req, rec) {
  if (rec.deleted_at) return;
  if (!can(req.grants, 'delete', req.user, rec)) throw httpError(403, 'Sin permiso para borrar');
  run(`UPDATE records SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ?`, req.user.id, rec.id);
  audit(req, { entity: 'record', entityId: rec.id, action: 'delete', appId: req.appDef.id, companyId: req.companyId, summary: 'Enviado a la papelera' });
}
function restore(req, rec) {
  if (!rec.deleted_at) return;
  if (!can(req.grants, 'restore', req.user, rec)) throw httpError(403, 'Sin permiso para restaurar');
  checkUnique(req, JSON.parse(rec.data), rec.id);
  run(`UPDATE records SET deleted_at = NULL, deleted_by = NULL, updated_at = datetime('now'), updated_by = ? WHERE id = ?`, req.user.id, rec.id);
  audit(req, { entity: 'record', entityId: rec.id, action: 'restore', appId: req.appDef.id, companyId: req.companyId, summary: 'Restaurado desde la papelera' });
}
function purge(req, rec) {
  if (!rec.deleted_at) throw httpError(400, 'Solo se pueden eliminar definitivamente registros de la papelera');
  if (!can(req.grants, 'purge', req.user, rec)) throw httpError(403, 'Sin permiso para eliminar definitivamente');
  const pwKeys = req.fields.filter((f) => f.type === 'password').map((f) => f.key);
  audit(req, { entity: 'record', entityId: rec.id, action: 'purge', appId: req.appDef.id, companyId: req.companyId,
    summary: 'Eliminado definitivamente', changes: diff(JSON.parse(rec.data), {}, pwKeys) });
  run('DELETE FROM share_links WHERE record_id = ?', rec.id);
  run('DELETE FROM records WHERE id = ?', rec.id);
}

router.delete('/:appKey/records/:id', wrap((req, res) => { softDelete(req, getRecord(req, req.params.id)); res.json({ ok: true }); }));
router.post('/:appKey/records/:id/restore', wrap((req, res) => { restore(req, getRecord(req, req.params.id)); res.json({ ok: true }); }));
router.delete('/:appKey/records/:id/purge', wrap((req, res) => { purge(req, getRecord(req, req.params.id)); res.json({ ok: true }); }));

router.post('/:appKey/bulk', wrap((req, res) => {
  const { action, ids = [] } = req.body || {};
  const fn = { delete: softDelete, restore, purge }[action];
  if (!fn) throw httpError(400, 'Acción no válida');
  let ok = 0; const errors = [];
  for (const id of ids.slice(0, 1000)) {
    try { tx(() => fn(req, getRecord(req, id))); ok++; } catch (e) { errors.push(`#${id}: ${e.message}`); }
  }
  res.json({ ok, errors });
}));

// ---------- historial ----------
router.get('/:appKey/records/:id/history', wrap((req, res) => {
  const rec = getRecord(req, req.params.id);
  if (!can(req.grants, 'view_history', req.user, rec)) throw httpError(403, 'Sin permiso para ver el historial');
  const rows = all(`SELECT id, ts, user_name, action, summary, changes, ip FROM audit_log WHERE entity = 'record' AND entity_id = ? ORDER BY id DESC`, rec.id);
  res.json(rows.map((r) => ({ ...r, changes: r.changes ? JSON.parse(r.changes) : [] })));
}));

// ---------- contraseñas ----------
function passwordField(req, key) {
  const f = req.fields.find((x) => x.key === key && x.type === 'password');
  if (!f) throw httpError(400, 'Campo de contraseña no válido');
  return f;
}
router.get('/:appKey/records/:id/password/:field', wrap((req, res) => {
  const rec = getRecord(req, req.params.id);
  const f = passwordField(req, req.params.field);
  if (!can(req.grants, 'view_passwords', req.user, rec)) throw httpError(403, 'Sin permiso para ver contraseñas');
  const value = decrypt(JSON.parse(rec.data)[f.key]);
  audit(req, { entity: 'record', entityId: rec.id, action: 'reveal', appId: req.appDef.id, companyId: req.companyId, summary: `Contraseña consultada: ${f.label}` });
  res.json({ value });
}));

router.post('/:appKey/records/:id/share', wrap(async (req, res) => {
  const rec = getRecord(req, req.params.id);
  const f = passwordField(req, (req.body || {}).field);
  if (!can(req.grants, 'share_passwords', req.user, rec)) throw httpError(403, 'Sin permiso para enviar contraseñas');
  const { channel, to = '', hours = 24, include_plain = false, max_views = 1 } = req.body;
  const data = JSON.parse(rec.data);
  const secret = decrypt(data[f.key]);
  if (!secret) throw httpError(400, 'La contraseña está vacía');
  const title = data[req.appDef.title_field] || `#${rec.id}`;
  const code = shortCode(10);
  const h = Math.min(Math.max(Number(hours) || 24, 1), 24 * 30);
  run(`INSERT INTO share_links (code, record_id, field_key, created_by, expires_at, max_views) VALUES (?,?,?,?,?,?)`,
    code, rec.id, f.key, req.user.id, new Date(Date.now() + h * 3600e3).toISOString(), Math.min(Math.max(Number(max_views) || 1, 1), 20));
  const link = `${publicUrl(req)}/s/${code}`;
  const text = include_plain
    ? `${req.appDef.name} · ${title}\n${f.label}: ${secret}`
    : `${req.appDef.name} · ${title}\nConsulta "${f.label}" en este enlace de un solo uso (caduca en ${h} h):\n${link}`;
  const result = { code, link, expires_hours: h, text };
  if (channel === 'email') {
    if (!to) throw httpError(400, 'Indica el email de destino');
    await sendMail({ to, subject: `${req.appDef.name}: ${title}`, text });
    result.sent = true;
  } else if (channel === 'whatsapp') {
    const phone = String(to).replace(/[^\d]/g, '');
    result.url = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
  } else if (channel === 'sms') {
    result.url = `sms:${String(to).replace(/[^\d+]/g, '')}?body=${encodeURIComponent(text)}`;
  }
  audit(req, { entity: 'record', entityId: rec.id, action: 'share', appId: req.appDef.id, companyId: req.companyId,
    summary: `Contraseña "${f.label}" compartida por ${channel || 'enlace'}${to ? ' a ' + to : ''}${include_plain ? ' (en claro)' : ' (enlace de un solo uso)'}` });
  res.json(result);
}));

// ---------- exportación ----------
function exportRows(req) {
  const q = { ...req.query };
  const { where, params, order } = listQuery(req, q);
  const ids = q.ids ? String(q.ids).split(',').map(Number).filter(Boolean) : null;
  let rows = all(`${SELECT_REC} WHERE ${where} ORDER BY ${order}, r.id DESC`, ...params);
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
  const rows = exportRows(req);
  const users = Object.fromEntries(activeUsers().map((u) => [u.id, u]));
  const fields = req.fields.filter((f) => f.type !== 'password' || withPw);
  const header = ['ID', 'Centro', ...fields.map((f) => f.label), 'Creado', 'Modificado', 'Estado'];
  const matrix = rows.map((r) => {
    const d = JSON.parse(r.data);
    const rowCanPw = withPw && can(req.grants, 'view_passwords', req.user, r);
    return [r.id, r.center_code || r.center_name || '',
      ...fields.map((f) => (f.type === 'password' ? (rowCanPw ? decrypt(d[f.key]) : '') : toText(f, d[f.key], users))),
      r.created_at, r.updated_at, r.deleted_at ? 'BORRADO' : 'Activo'];
  });
  audit(req, { entity: 'app', entityId: req.appDef.id, action: 'export', appId: req.appDef.id, companyId: req.companyId,
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
  const targets = [{ key: '_id', label: 'ID (actualizar existente)' }, { key: '_center', label: 'Centro (código o nombre)' },
    ...req.fields.map((f) => ({ key: f.key, label: f.label, type: f.type }))];
  const mapping = header.map((h) => {
    const n = norm(h);
    if (['id'].includes(n)) return '_id';
    if (['centro', 'center', 'centrodetrabajo', 'centrodecoste', 'cc'].includes(n)) return '_center';
    const f = req.fields.find((x) => norm(x.label) === n || norm(x.key) === n);
    return f ? f.key : '';
  });
  const token = shortCode(16);
  pendingImports.set(token, { header, rows, userId: req.user.id, appId: req.appDef.id, companyId: req.companyId, expires: Date.now() + 30 * 60e3 });
  res.json({ token, header, mapping, targets, total: rows.length, sample: rows.slice(0, 5) });
}));

router.post('/:appKey/import/commit', wrap((req, res) => {
  if (!req.grants.import.length) throw httpError(403, 'Sin permiso de importación');
  const { token, mapping = [], default_center = null, match_field = '', dry_run = false } = req.body || {};
  const p = pendingImports.get(token);
  if (!p || p.userId !== req.user.id || p.appId !== req.appDef.id || p.companyId !== req.companyId) throw httpError(400, 'La importación ha caducado, vuelve a subir el fichero');
  const centers = companyCenters(req.companyId);
  const users = activeUsers();
  const findCenter = (v) => {
    const s = norm(v);
    if (!s) return undefined;
    const c = centers.find((x) => norm(x.code) === s || norm(x.name) === s || String(x.id) === String(v).trim());
    if (!c) throw new Error(`Centro "${v}" no encontrado`);
    return c.id;
  };
  const matchF = match_field ? req.fields.find((f) => f.key === match_field) : null;
  const pwKeys = req.fields.filter((f) => f.type === 'password').map((f) => f.key);
  const result = { created: 0, updated: 0, skipped: 0, errors: [] };

  const doImport = () => {
    p.rows.forEach((row, i) => {
      const line = i + 2;
      try {
        const input = {}; let centerId; let recId = null;
        mapping.forEach((target, col) => {
          if (!target) return;
          const v = row[col];
          if (target === '_id') { if (String(v).trim()) recId = Number(v); }
          else if (target === '_center') centerId = findCenter(v);
          else input[target] = v instanceof Date ? v : (v ?? '');
        });
        let existing = null;
        if (recId) existing = get('SELECT * FROM records WHERE id = ? AND app_id = ? AND company_id = ? AND deleted_at IS NULL', recId, req.appDef.id, req.companyId);
        if (!existing && matchF && input[matchF.key] !== undefined && String(input[matchF.key]).trim()) {
          const v = normalize(matchF, input[matchF.key], { users });
          existing = get(`SELECT * FROM records WHERE app_id = ? AND company_id = ? AND deleted_at IS NULL
            AND lower(CAST(json_extract(data, ?) AS TEXT)) = lower(?)`, req.appDef.id, req.companyId, `$.${matchF.key}`, String(v));
        }
        if (existing) {
          if (!can(req.grants, 'edit', req.user, existing)) throw new Error('sin permiso para modificar este registro');
          const newCenter = centerId === undefined ? existing.center_id : centerId;
          if (newCenter !== existing.center_id) checkCenter(req, newCenter, 'edit');
          const before = JSON.parse(existing.data);
          const data = buildData(req, input, before, { users });
          checkUnique(req, data, existing.id);
          const changes = diff({ ...before, _centro: existing.center_id }, { ...data, _centro: newCenter }, pwKeys);
          if (!changes.length) { result.skipped++; return; }
          if (!dry_run) {
            run(`UPDATE records SET data = ?, center_id = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`, JSON.stringify(data), newCenter, req.user.id, existing.id);
            audit(req, { entity: 'record', entityId: existing.id, action: 'update', appId: req.appDef.id, companyId: req.companyId, summary: 'Modificación por importación', changes });
          }
          result.updated++;
        } else {
          const cId = centerId === undefined ? (default_center ? Number(default_center) : null) : centerId;
          checkCenter(req, cId, 'create');
          const data = buildData(req, input, {}, { users });
          checkUnique(req, data);
          if (!dry_run) {
            const id = Number(run(`INSERT INTO records (app_id, company_id, center_id, data, created_by, updated_by) VALUES (?,?,?,?,?,?)`,
              req.appDef.id, req.companyId, cId, JSON.stringify(data), req.user.id, req.user.id).lastInsertRowid);
            audit(req, { entity: 'record', entityId: id, action: 'create', appId: req.appDef.id, companyId: req.companyId, summary: 'Alta por importación', changes: diff({}, data, pwKeys) });
          }
          result.created++;
        }
      } catch (e) {
        result.errors.push(`Fila ${line}: ${e.message}`);
      }
    });
  };
  tx(doImport);
  if (!dry_run) {
    pendingImports.delete(token);
    audit(req, { entity: 'app', entityId: req.appDef.id, action: 'import', appId: req.appDef.id, companyId: req.companyId,
      summary: `Importación: ${result.created} altas, ${result.updated} modificaciones, ${result.errors.length} errores` });
  }
  res.json(result);
}));

module.exports = { router, wrap, httpError, fail, sendSheet };
