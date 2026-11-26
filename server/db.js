'use strict';
// Capa de acceso a MariaDB: pool de conexiones, transacciones y creación del esquema.
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const mariadb = require('mariadb');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_NAME = process.env.DB_NAME || 'erp';
if (!/^[A-Za-z0-9_]+$/.test(DB_NAME)) throw new Error('DB_NAME no válido');

const pool = mariadb.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'erp',
  password: process.env.DB_PASSWORD ?? 'erp',
  database: DB_NAME,
  connectionLimit: Number(process.env.DB_POOL) || 10,
  charset: 'utf8mb4',
  dateStrings: true,
  bigIntAsNumber: true,
  insertIdAsNumber: true,
  decimalAsNumber: true,
  autoJsonMap: false, // las columnas JSON llegan como texto (se parsean en el código)
  initSql: "SET time_zone = '+00:00'", // todas las fechas se guardan en UTC
});

// Las consultas hechas dentro de tx() usan la misma conexión (y por tanto la misma transacción).
const txStore = new AsyncLocalStorage();

async function query(sql, params = []) {
  const conn = txStore.getStore();
  return conn ? conn.query(sql, params) : pool.query(sql, params);
}
const all = async (sql, ...p) => Array.from(await query(sql, p));
const get = async (sql, ...p) => (await query(sql, p))[0];
const run = async (sql, ...p) => { const r = await query(sql, p); return { lastInsertRowid: r.insertId, changes: r.affectedRows }; };

async function tx(fn) {
  if (txStore.getStore()) return fn(); // transacción anidada: reutiliza la actual
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const r = await txStore.run(conn, fn);
    await conn.commit();
    return r;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/** Fecha JS → 'YYYY-MM-DD HH:MM:SS' (UTC) para columnas DATETIME. */
const sqlDate = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS companies (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    cif VARCHAR(30), address VARCHAR(300), email VARCHAR(200), phone VARCHAR(50), notes TEXT,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL
  )`,
  `CREATE TABLE IF NOT EXISTS centers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    company_id INT NOT NULL,
    code VARCHAR(50), name VARCHAR(200) NOT NULL,
    kind VARCHAR(20) NOT NULL DEFAULT 'trabajo',
    address VARCHAR(300), notes TEXT,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL,
    CONSTRAINT fk_centers_company FOREIGN KEY (company_id) REFERENCES companies(id)
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(200) NOT NULL,
    name VARCHAR(200) NOT NULL,
    phone VARCHAR(50),
    password_hash VARCHAR(100),
    is_superadmin TINYINT(1) NOT NULL DEFAULT 0,
    active TINYINT(1) NOT NULL DEFAULT 1,
    must_change_password TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME NULL,
    deleted_at DATETIME NULL,
    UNIQUE KEY uq_users_email (email)
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token VARCHAR(64) PRIMARY KEY,
    user_id INT NOT NULL,
    expires_at DATETIME NOT NULL,
    KEY idx_sessions_user (user_id),
    CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS apps (
    id INT AUTO_INCREMENT PRIMARY KEY,
    \`key\` VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    icon VARCHAR(20), color VARCHAR(20), description VARCHAR(500),
    sort INT NOT NULL DEFAULT 0,
    active TINYINT(1) NOT NULL DEFAULT 1,
    title_field VARCHAR(50),
    UNIQUE KEY uq_apps_key (\`key\`)
  )`,
  `CREATE TABLE IF NOT EXISTS fields (
    id INT AUTO_INCREMENT PRIMARY KEY,
    app_id INT NOT NULL,
    \`key\` VARCHAR(50) NOT NULL,
    label VARCHAR(150) NOT NULL,
    type VARCHAR(20) NOT NULL DEFAULT 'text',
    options TEXT,
    required TINYINT(1) NOT NULL DEFAULT 0,
    unique_value TINYINT(1) NOT NULL DEFAULT 0,
    show_in_list TINYINT(1) NOT NULL DEFAULT 1,
    width VARCHAR(10) NOT NULL DEFAULT 'md',
    max_length INT NULL,
    height TINYINT NOT NULL DEFAULT 1,
    help VARCHAR(500),
    sort INT NOT NULL DEFAULT 0,
    active TINYINT(1) NOT NULL DEFAULT 1,
    UNIQUE KEY uq_fields_app_key (app_id, \`key\`),
    CONSTRAINT fk_fields_app FOREIGN KEY (app_id) REFERENCES apps(id)
  )`,
  `CREATE TABLE IF NOT EXISTS roles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(500),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL
  )`,
  `CREATE TABLE IF NOT EXISTS role_permissions (
    role_id INT NOT NULL,
    app_id INT NOT NULL,
    can_view TINYINT(1) NOT NULL DEFAULT 0,
    can_create TINYINT(1) NOT NULL DEFAULT 0,
    can_edit TINYINT(1) NOT NULL DEFAULT 0,
    can_delete TINYINT(1) NOT NULL DEFAULT 0,
    can_view_trash TINYINT(1) NOT NULL DEFAULT 0,
    can_restore TINYINT(1) NOT NULL DEFAULT 0,
    can_purge TINYINT(1) NOT NULL DEFAULT 0,
    can_import TINYINT(1) NOT NULL DEFAULT 0,
    can_export TINYINT(1) NOT NULL DEFAULT 0,
    can_view_passwords TINYINT(1) NOT NULL DEFAULT 0,
    can_share_passwords TINYINT(1) NOT NULL DEFAULT 0,
    can_view_history TINYINT(1) NOT NULL DEFAULT 0,
    only_own TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (role_id, app_id),
    CONSTRAINT fk_rp_role FOREIGN KEY (role_id) REFERENCES roles(id),
    CONSTRAINT fk_rp_app FOREIGN KEY (app_id) REFERENCES apps(id)
  )`,
  `CREATE TABLE IF NOT EXISTS user_assignments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    role_id INT NOT NULL,
    company_id INT NOT NULL,
    center_id INT NULL,
    KEY idx_asg_user (user_id, company_id),
    CONSTRAINT fk_asg_user FOREIGN KEY (user_id) REFERENCES users(id),
    CONSTRAINT fk_asg_role FOREIGN KEY (role_id) REFERENCES roles(id),
    CONSTRAINT fk_asg_company FOREIGN KEY (company_id) REFERENCES companies(id),
    CONSTRAINT fk_asg_center FOREIGN KEY (center_id) REFERENCES centers(id)
  )`,
  `CREATE TABLE IF NOT EXISTS records (
    id INT AUTO_INCREMENT PRIMARY KEY,
    app_id INT NOT NULL,
    company_id INT NOT NULL,
    center_id INT NULL,
    data LONGTEXT NOT NULL CHECK (JSON_VALID(data)),
    created_by INT NULL, updated_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL, deleted_by INT NULL,
    KEY idx_records_app (app_id, company_id, deleted_at),
    KEY idx_records_center (center_id),
    CONSTRAINT fk_records_app FOREIGN KEY (app_id) REFERENCES apps(id),
    CONSTRAINT fk_records_company FOREIGN KEY (company_id) REFERENCES companies(id),
    CONSTRAINT fk_records_center FOREIGN KEY (center_id) REFERENCES centers(id)
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    ts DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    user_id INT NULL, user_name VARCHAR(200),
    company_id INT NULL, app_id INT NULL,
    entity VARCHAR(30) NOT NULL, entity_id INT NULL,
    action VARCHAR(30) NOT NULL,
    summary VARCHAR(1000),
    changes LONGTEXT,
    ip VARCHAR(64),
    KEY idx_audit_entity (entity, entity_id),
    KEY idx_audit_ts (ts),
    KEY idx_audit_app (app_id),
    KEY idx_audit_user (user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS user_layouts (
    user_id INT NOT NULL,
    app_id INT NOT NULL,
    kind VARCHAR(10) NOT NULL,
    config TEXT NOT NULL,
    PRIMARY KEY (user_id, app_id, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    \`key\` VARCHAR(50) PRIMARY KEY,
    value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS entity_fields (
    id INT AUTO_INCREMENT PRIMARY KEY,
    entity VARCHAR(20) NOT NULL,            -- centers | companies
    \`key\` VARCHAR(50) NOT NULL,
    label VARCHAR(150) NOT NULL,
    type VARCHAR(20) NOT NULL DEFAULT 'text',
    options TEXT,
    required TINYINT(1) NOT NULL DEFAULT 0,
    unique_value TINYINT(1) NOT NULL DEFAULT 0,
    show_in_list TINYINT(1) NOT NULL DEFAULT 1,
    width VARCHAR(10) NOT NULL DEFAULT 'md',
    max_length INT NULL,
    height TINYINT NOT NULL DEFAULT 1,
    help VARCHAR(500),
    sort INT NOT NULL DEFAULT 0,
    active TINYINT(1) NOT NULL DEFAULT 1,
    UNIQUE KEY uq_entity_fields (entity, \`key\`)
  )`,
  `CREATE TABLE IF NOT EXISTS share_links (
    code VARCHAR(20) PRIMARY KEY,
    record_id INT NOT NULL,
    field_key VARCHAR(50) NOT NULL,
    created_by INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    max_views INT NOT NULL DEFAULT 1,
    views INT NOT NULL DEFAULT 0,
    KEY idx_share_record (record_id)
  )`,
];

/** Crea la base de datos (si el usuario tiene permiso) y las tablas. */
async function init() {
  if (process.env.DB_CREATE !== '0') {
    const c = await mariadb.createConnection({
      host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'erp', password: process.env.DB_PASSWORD ?? 'erp',
    });
    try { await c.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); }
    catch { /* sin permiso para crear BD: se asume que ya existe */ }
    finally { await c.end(); }
  }
  for (const sql of SCHEMA) {
    await pool.query(sql.replace(/\)\s*$/, ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'));
  }
  for (const sql of MIGRATIONS) await pool.query(sql);
  // Vista calendario por aplicación: al crear la columna se activa solo en Recados.
  const hasCal = await pool.query(`SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'apps' AND COLUMN_NAME = 'calendar'`, [DB_NAME]);
  if (!hasCal.length) {
    await pool.query('ALTER TABLE apps ADD COLUMN calendar TINYINT(1) NOT NULL DEFAULT 0');
    await pool.query("UPDATE apps SET calendar = 1 WHERE `key` = 'recados'");
  }
  // Anchos de campo: de 3 tamaños (half/third/full) a 6 (xs, sm, md, lg, xl, full) conservando el aspecto.
  for (const t of ['fields', 'entity_fields']) {
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS max_length INT NULL`);
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS height TINYINT NOT NULL DEFAULT 1`);
    await pool.query(`ALTER TABLE ${t} ALTER COLUMN width SET DEFAULT 'md'`);
    await pool.query(`UPDATE ${t} SET width = CASE width WHEN 'half' THEN 'md' WHEN 'third' THEN 'sm' ELSE width END WHERE width IN ('half', 'third')`);
  }
  // Numeración propia por aplicación y empresa (Nº de trabajo), empezando en apps.number_start
  await pool.query('ALTER TABLE apps ADD COLUMN IF NOT EXISTS number_start INT NOT NULL DEFAULT 1000');
  await pool.query('ALTER TABLE records ADD COLUMN IF NOT EXISTS number INT NULL AFTER company_id');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_records_number ON records (app_id, company_id, number)');
  await pool.query(`CREATE TABLE IF NOT EXISTS record_counters (
    app_id INT NOT NULL, company_id INT NOT NULL, next_number INT NOT NULL,
    PRIMARY KEY (app_id, company_id)) ENGINE=InnoDB`);
  await assignMissingNumbers();
  // «IP fija» de Fibras pasa al nuevo tipo «Dirección IP» (una sola vez)
  const ipDone = await pool.query("SELECT 1 FROM settings WHERE `key` = 'migr_ip_type_v1'");
  if (!ipDone.length) {
    await pool.query("UPDATE fields f JOIN apps a ON a.id = f.app_id SET f.type = 'ip' WHERE a.`key` = 'fibras' AND f.`key` = 'ip_fija' AND f.type = 'text'");
    await pool.query("INSERT INTO settings (`key`, value) VALUES ('migr_ip_type_v1', '1')");
  }
  // Campos dinámicos de centros: la cuenta corriente pasa a ser un campo dinámico (una sola vez).
  const done = await pool.query("SELECT 1 FROM settings WHERE `key` = 'migr_entity_fields_v1'");
  if (!done.length) {
    await pool.query(`INSERT IGNORE INTO entity_fields (entity, \`key\`, label, type, help, sort)
      VALUES ('centers', 'iban', 'Cuenta corriente (IBAN)', 'iban', 'Se comprueban los dígitos de control', 0)`);
    const hasIban = await pool.query(`SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'centers' AND COLUMN_NAME = 'iban'`, [DB_NAME]);
    if (hasIban.length) {
      await pool.query(`UPDATE centers SET extra = JSON_SET(COALESCE(extra, '{}'), '$.iban', iban) WHERE iban IS NOT NULL AND iban <> ''`);
      await pool.query('ALTER TABLE centers DROP COLUMN iban');
    }
    await pool.query("INSERT INTO settings (`key`, value) VALUES ('migr_entity_fields_v1', '1')");
  }
}

// Cambios de estructura posteriores a la primera versión (idempotentes).
const MIGRATIONS = [
  'ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo MEDIUMTEXT NULL',
  'ALTER TABLE apps ADD COLUMN IF NOT EXISTS form_layout LONGTEXT NULL', // diseño del formulario (secciones, pestañas)
  'ALTER TABLE centers ADD COLUMN IF NOT EXISTS extra LONGTEXT NULL',
  'ALTER TABLE companies ADD COLUMN IF NOT EXISTS extra LONGTEXT NULL',
];

/**
 * Da número a los registros que no lo tienen (los existentes al actualizar, o los de una copia antigua restaurada),
 * en orden de creación, y deja los contadores por encima del mayor número usado.
 */
async function assignMissingNumbers() {
  const pending = await pool.query(`SELECT r.id, r.app_id, r.company_id FROM records r WHERE r.number IS NULL ORDER BY r.app_id, r.company_id, r.id`);
  if (pending.length) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const next = {};
      for (const r of pending) {
        const k = `${r.app_id}:${r.company_id}`;
        if (next[k] === undefined) {
          const [x] = await conn.query(`SELECT GREATEST(COALESCE(MAX(r.number) + 1, 0), a.number_start) n FROM apps a
            LEFT JOIN records r ON r.app_id = a.id AND r.company_id = ? WHERE a.id = ? GROUP BY a.id`, [r.company_id, r.app_id]);
          next[k] = x ? x.n : 1000;
        }
        await conn.query('UPDATE records SET number = ? WHERE id = ?', [next[k]++, r.id]);
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }
  await pool.query(`INSERT INTO record_counters (app_id, company_id, next_number)
    SELECT app_id, company_id, MAX(number) + 1 FROM records GROUP BY app_id, company_id
    ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, VALUES(next_number))`);
}

/** Siguiente número de la app en la empresa (llamar dentro de tx: bloquea el contador). */
async function nextNumber(appId, companyId) {
  const app = (await query('SELECT number_start FROM apps WHERE id = ?', [appId]))[0];
  const start = app ? app.number_start : 1000;
  await query('INSERT IGNORE INTO record_counters (app_id, company_id, next_number) VALUES (?,?,?)', [appId, companyId, start]);
  const row = (await query('SELECT next_number FROM record_counters WHERE app_id = ? AND company_id = ? FOR UPDATE', [appId, companyId]))[0];
  const n = Math.max(row.next_number, start);
  await query('UPDATE record_counters SET next_number = ? WHERE app_id = ? AND company_id = ?', [n + 1, appId, companyId]);
  return n;
}

/** Tablas que se incluyen en las copias de seguridad (las sesiones no). */
const BACKUP_TABLES = ['companies', 'centers', 'users', 'apps', 'fields', 'roles', 'role_permissions', 'user_assignments',
  'records', 'audit_log', 'user_layouts', 'settings', 'share_links', 'entity_fields'];

const close = () => pool.end();

module.exports = { pool, all, get, run, tx, init, close, sqlDate, DATA_DIR, DB_NAME, BACKUP_TABLES, nextNumber, assignMissingNumbers };
