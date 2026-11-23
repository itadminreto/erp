'use strict';
const { run } = require('./db');

/** Registra una acción en la tabla de trazabilidad. */
function audit(req, { entity, entityId = null, action, summary = '', changes = null, appId = null, companyId = null }) {
  const u = req && req.user;
  run(
    `INSERT INTO audit_log (user_id, user_name, company_id, app_id, entity, entity_id, action, summary, changes, ip)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    u ? u.id : null, u ? u.name : 'sistema', companyId, appId, entity, entityId, action, summary,
    changes ? JSON.stringify(changes) : null, req ? (req.ip || '') : ''
  );
}

/** Diferencia campo a campo entre dos objetos planos. */
function diff(before = {}, after = {}, maskKeys = []) {
  const out = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    const a = before ? before[k] : undefined, b = after ? after[k] : undefined;
    const norm = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    if (norm(a) !== norm(b)) {
      if (maskKeys.includes(k)) out.push({ field: k, from: a ? '••••' : '', to: b ? '•••• (cambiada)' : '' });
      else out.push({ field: k, from: a ?? '', to: b ?? '' });
    }
  }
  return out;
}

module.exports = { audit, diff };
