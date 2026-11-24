'use strict';
const bcrypt = require('bcryptjs');
const { all, get, run, sqlDate } = require('./db');
const { token } = require('./crypto');

const COOKIE = 'erp_session';
const SESSION_DAYS = 7;

const PERMS = [
  'view', 'create', 'edit', 'delete', 'view_trash', 'restore', 'purge',
  'import', 'export', 'view_passwords', 'share_passwords', 'view_history',
];

function parseCookies(header = '') {
  const out = {};
  header.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

async function createSession(res, userId) {
  const t = token();
  const exp = sqlDate(Date.now() + SESSION_DAYS * 864e5);
  await run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)', t, userId, exp);
  res.setHeader('Set-Cookie', `${COOKIE}=${t}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`);
}
async function destroySession(req, res) {
  const t = parseCookies(req.headers.cookie)[COOKIE];
  if (t) await run('DELETE FROM sessions WHERE token = ?', t);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
}

/** Middleware: carga req.user y req.companyId (empresa activa) si hay sesión. */
async function loadUser(req, _res, next) {
  try {
    const t = parseCookies(req.headers.cookie)[COOKIE];
    if (t) {
      const row = await get(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > UTC_TIMESTAMP() AND u.active = 1 AND u.deleted_at IS NULL`, t);
      if (row) {
        req.user = row;
        req.user.is_superadmin = !!row.is_superadmin;
        const companies = await userCompanies(row);
        req.companies = companies;
        const wanted = Number(req.headers['x-company-id']) || null;
        req.companyId = companies.some((c) => c.id === wanted) ? wanted : (companies[0] ? companies[0].id : null);
      }
    }
  } catch (e) { return next(e); }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'No autenticado' });
  next();
}
function requireSuper(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'No autenticado' });
  if (!req.user.is_superadmin) return res.status(403).json({ error: 'Solo super administrador' });
  next();
}

async function userCompanies(user) {
  if (user.is_superadmin) {
    return all('SELECT id, name, (logo IS NOT NULL) has_logo FROM companies WHERE deleted_at IS NULL AND active = 1 ORDER BY name');
  }
  return all(
    `SELECT DISTINCT c.id, c.name, (c.logo IS NOT NULL) has_logo FROM user_assignments a JOIN companies c ON c.id = a.company_id
     WHERE a.user_id = ? AND c.deleted_at IS NULL AND c.active = 1 ORDER BY c.name`, user.id
  );
}

/**
 * Concesiones de un usuario para una app dentro de una empresa.
 * Devuelve { perm: [{center: id|null, own: bool}] } — null center = todos los centros.
 */
async function grantsFor(user, companyId, appId) {
  const grants = Object.fromEntries(PERMS.map((p) => [p, []]));
  if (user.is_superadmin) {
    PERMS.forEach((p) => grants[p].push({ center: null, own: false }));
    return grants;
  }
  const rows = await all(
    `SELECT a.center_id, rp.* FROM user_assignments a
     JOIN roles r ON r.id = a.role_id AND r.deleted_at IS NULL
     JOIN role_permissions rp ON rp.role_id = a.role_id AND rp.app_id = ?
     WHERE a.user_id = ? AND a.company_id = ?`, appId, user.id, companyId
  );
  for (const r of rows) {
    for (const p of PERMS) {
      if (r['can_' + p]) grants[p].push({ center: r.center_id, own: !!r.only_own && !['view_passwords', 'share_passwords'].includes(p) });
    }
  }
  return grants;
}

/** ¿Tiene permiso `perm` sobre el registro (o sobre un centro, si se pasa un objeto parcial)? */
function can(grants, perm, user, rec = {}) {
  return (grants[perm] || []).some((g) =>
    (g.center === null || g.center === rec.center_id) &&
    (!g.own || rec.created_by === undefined || rec.created_by === user.id));
}
/** Resumen booleano (al menos en algún centro) para la UI. */
function summary(grants) {
  return Object.fromEntries(PERMS.map((p) => [p, grants[p].length > 0]));
}
/** Fragmento SQL para filtrar registros visibles según una concesión. */
function sqlFilter(grants, perm, user, alias = 'r') {
  const list = grants[perm] || [];
  if (!list.length) return { sql: '0', params: [] };
  const parts = [], params = [];
  for (const g of list) {
    const c = [];
    if (g.center !== null) { c.push(`${alias}.center_id = ?`); params.push(g.center); }
    if (g.own) { c.push(`${alias}.created_by = ?`); params.push(user.id); }
    if (!c.length) return { sql: '1', params: [] };
    parts.push('(' + c.join(' AND ') + ')');
  }
  return { sql: '(' + parts.join(' OR ') + ')', params };
}

const hash = (p) => bcrypt.hashSync(p, 10);
const verify = (p, h) => !!h && bcrypt.compareSync(p, h);

module.exports = {
  PERMS, loadUser, requireAuth, requireSuper, createSession, destroySession,
  grantsFor, can, summary, sqlFilter, userCompanies, hash, verify,
};
