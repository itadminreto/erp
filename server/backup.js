'use strict';
// Copias de seguridad de la aplicación: volcado de todas las tablas a JSON comprimido y restauración.
// No depende de mariadb-dump, así que funciona igual en servidor, Docker o desarrollo.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { all, run, tx, DATA_DIR, BACKUP_TABLES, assignMissingNumbers } = require('./db');
const { encrypt, decrypt } = require('./crypto');
const { getSetting } = require('./mailer');

const BACKUP_DIR = process.env.BACKUP_DIR_APP || path.join(DATA_DIR, 'backups');
const FORMAT = 'erp-backup';
const CANARY = 'erp-backup-canary';
const NAME_RE = /^erp_\d{4}-\d{2}-\d{2}_\d{6}_(manual|auto|antes-restaurar|subida)\.json\.gz$/;
const KINDS = { manual: 'Manual', auto: 'Automática', 'antes-restaurar': 'Antes de restaurar', subida: 'Archivo subido' };

const httpError = (status, msg, extra = {}) => Object.assign(new Error(msg), { status, ...extra });

function ensureDir() { fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 }); }
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15)
  .replace(/^(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');

/** Genera el contenido de una copia (Buffer gzip). */
async function dump() {
  const tables = {};
  for (const t of BACKUP_TABLES) tables[t] = await all(`SELECT * FROM \`${t}\``);
  const pkg = require('../package.json');
  const doc = { format: FORMAT, version: 1, app_version: pkg.version, created_at: new Date().toISOString(), canary: encrypt(CANARY), tables };
  return zlib.gzipSync(Buffer.from(JSON.stringify(doc)), { level: 6 });
}

/** Crea una copia y la guarda en el servidor. Devuelve su descripción. */
async function createBackup(kind = 'manual') {
  if (!KINDS[kind]) throw new Error('Tipo de copia no válido');
  ensureDir();
  const name = `erp_${stamp()}_${kind}.json.gz`;
  const file = path.join(BACKUP_DIR, name);
  fs.writeFileSync(file, await dump(), { mode: 0o600 });
  return describe(name);
}

function describe(name) {
  const st = fs.statSync(path.join(BACKUP_DIR, name));
  const kind = name.match(NAME_RE)[1];
  return { name, kind, kind_label: KINDS[kind], size: st.size, created_at: st.mtime.toISOString() };
}

function listBackups() {
  ensureDir();
  return fs.readdirSync(BACKUP_DIR).filter((n) => NAME_RE.test(n)).map(describe)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function backupPath(name) {
  if (!NAME_RE.test(String(name))) throw httpError(400, 'Nombre de copia no válido');
  const file = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(file)) throw httpError(404, 'La copia no existe');
  return file;
}

function deleteBackup(name) { fs.unlinkSync(backupPath(name)); }

/** Guarda un archivo subido como copia (para poder restaurarlo y conservarlo). */
function saveUploaded(buf) {
  parse(buf); // valida antes de guardar
  ensureDir();
  const name = `erp_${stamp()}_subida.json.gz`;
  fs.writeFileSync(path.join(BACKUP_DIR, name), buf, { mode: 0o600 });
  return name;
}

function parse(buf) {
  let doc;
  try { doc = JSON.parse(zlib.gunzipSync(buf).toString('utf8')); }
  catch { throw httpError(400, 'El archivo no es una copia de seguridad válida (.json.gz)'); }
  if (!doc || doc.format !== FORMAT || !doc.tables) throw httpError(400, 'El archivo no es una copia de seguridad de esta aplicación');
  return doc;
}

/** ¿La copia se hizo con la misma APP_SECRET? (si no, las contraseñas guardadas no se podrán descifrar) */
function sameSecret(doc) {
  try { return decrypt(doc.canary) === CANARY; } catch { return false; }
}

/**
 * Restaura una copia sustituyendo todos los datos. Antes guarda una copia de seguridad del estado actual.
 * Cierra todas las sesiones (los usuarios tienen que volver a entrar).
 */
async function restoreBackup(buf, { force = false } = {}) {
  const doc = parse(buf);
  if (!sameSecret(doc) && !force) {
    throw httpError(409, 'La copia se hizo con otra clave APP_SECRET: las contraseñas guardadas no se podrán leer.', { code: 'secret_mismatch' });
  }
  const safety = await createBackup('antes-restaurar');
  const counts = {};
  await tx(async () => {
    await run('SET FOREIGN_KEY_CHECKS = 0');
    try {
      for (const t of BACKUP_TABLES) {
        const rows = doc.tables[t];
        if (!Array.isArray(rows)) { if (t === 'record_files') await run('DELETE FROM record_files'); continue; } // copia sin imágenes
        const cols = new Set((await all(`SHOW COLUMNS FROM \`${t}\``)).map((c) => c.Field));
        await run(`DELETE FROM \`${t}\``);
        // Inserciones por lotes de hasta ~4 MB (para no superar max_allowed_packet)
        // Copias anteriores a los campos dinámicos: la cuenta corriente iba en la columna centers.iban
        if (t === 'centers' && !cols.has('iban')) {
          for (const r of rows) {
            if (r.iban) { const x = r.extra ? JSON.parse(r.extra) : {}; x.iban = r.iban; r.extra = JSON.stringify(x); }
            if (rows.length && !('extra' in r)) r.extra = null;
          }
        }
        const keys = rows.length ? Object.keys(rows[0]).filter((k) => cols.has(k)) : [];
        const ph = `(${keys.map(() => '?').join(',')})`;
        const flush = async (batch) => {
          if (!batch.length || !keys.length) return;
          await run(`INSERT INTO \`${t}\` (${keys.map((k) => '`' + k + '`').join(',')}) VALUES ${batch.map(() => ph).join(',')}`,
            ...batch.flatMap((r) => keys.map((k) => (r[k] === undefined ? null : r[k]))));
        };
        let batch = [], bytes = 0;
        for (const r of rows) {
          const size = JSON.stringify(r).length;
          if (batch.length && (bytes + size > 4e6 || batch.length >= 500)) { await flush(batch); batch = []; bytes = 0; }
          batch.push(r); bytes += size;
        }
        await flush(batch);
        counts[t] = rows.length;
      }
      await run('DELETE FROM sessions');
    } finally {
      await run('SET FOREIGN_KEY_CHECKS = 1');
    }
  });
  await assignMissingNumbers(); // copias anteriores a la numeración por app
  return { counts, safety: safety.name, created_at: doc.created_at, same_secret: sameSecret(doc) };
}

/** Copia automática diaria según los ajustes (backup_auto, backup_keep). */
async function autoBackupTick() {
  try {
    if ((await getSetting('backup_auto', '1')) !== '1') return;
    const keepDays = Math.max(Number(await getSetting('backup_keep', '14')) || 14, 1);
    const list = listBackups();
    const lastAuto = list.find((b) => b.kind === 'auto');
    if (!lastAuto || Date.now() - new Date(lastAuto.created_at).getTime() > 23.5 * 3600e3) await createBackup('auto');
    const limit = Date.now() - keepDays * 864e5;
    for (const b of listBackups()) {
      if (['auto', 'antes-restaurar'].includes(b.kind) && new Date(b.created_at).getTime() < limit) deleteBackup(b.name);
    }
  } catch (e) {
    console.error('Copia automática:', e.message);
  }
}
function startScheduler() {
  setTimeout(autoBackupTick, 60e3).unref();
  setInterval(autoBackupTick, 30 * 60e3).unref();
}

module.exports = { createBackup, listBackups, backupPath, deleteBackup, saveUploaded, restoreBackup, startScheduler, autoBackupTick, BACKUP_DIR };
