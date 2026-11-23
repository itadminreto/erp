'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'erp.sqlite');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  cif TEXT, address TEXT, email TEXT, phone TEXT, notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS centers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  code TEXT, name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'trabajo',   -- trabajo | coste | ambos
  address TEXT, notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  phone TEXT,
  password_hash TEXT,
  is_superadmin INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  icon TEXT, color TEXT, description TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  title_field TEXT
);
CREATE TABLE IF NOT EXISTS fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL REFERENCES apps(id),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  options TEXT,                      -- JSON: { choices: [...] }
  required INTEGER NOT NULL DEFAULT 0,
  unique_value INTEGER NOT NULL DEFAULT 0,
  show_in_list INTEGER NOT NULL DEFAULT 1,
  width TEXT NOT NULL DEFAULT 'half', -- half | full
  help TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(app_id, key)
);
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id),
  app_id INTEGER NOT NULL REFERENCES apps(id),
  can_view INTEGER NOT NULL DEFAULT 0,
  can_create INTEGER NOT NULL DEFAULT 0,
  can_edit INTEGER NOT NULL DEFAULT 0,
  can_delete INTEGER NOT NULL DEFAULT 0,
  can_view_trash INTEGER NOT NULL DEFAULT 0,
  can_restore INTEGER NOT NULL DEFAULT 0,
  can_purge INTEGER NOT NULL DEFAULT 0,
  can_import INTEGER NOT NULL DEFAULT 0,
  can_export INTEGER NOT NULL DEFAULT 0,
  can_view_passwords INTEGER NOT NULL DEFAULT 0,
  can_share_passwords INTEGER NOT NULL DEFAULT 0,
  can_view_history INTEGER NOT NULL DEFAULT 0,
  only_own INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (role_id, app_id)
);
CREATE TABLE IF NOT EXISTS user_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  role_id INTEGER NOT NULL REFERENCES roles(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  center_id INTEGER REFERENCES centers(id)   -- NULL = todos los centros de la empresa
);
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL REFERENCES apps(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  center_id INTEGER REFERENCES centers(id),
  data TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER, updated_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, deleted_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_records_app ON records(app_id, company_id, deleted_at);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER, user_name TEXT,
  company_id INTEGER, app_id INTEGER,
  entity TEXT NOT NULL, entity_id INTEGER,
  action TEXT NOT NULL,
  summary TEXT,
  changes TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
CREATE TABLE IF NOT EXISTS user_layouts (
  user_id INTEGER NOT NULL,
  app_id INTEGER NOT NULL,
  kind TEXT NOT NULL,         -- list | form
  config TEXT NOT NULL,
  PRIMARY KEY (user_id, app_id, kind)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS share_links (
  code TEXT PRIMARY KEY,
  record_id INTEGER NOT NULL,
  field_key TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  max_views INTEGER NOT NULL DEFAULT 1,
  views INTEGER NOT NULL DEFAULT 0
);
`);

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

module.exports = { db, all, get, run, tx, DATA_DIR };
