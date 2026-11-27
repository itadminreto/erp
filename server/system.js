'use strict';
// Estado del sistema para el panel del super admin: servidor, disco, base de datos, sesiones, actividad y copias.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { all, get, DATA_DIR, DB_NAME } = require('./db');

const pkg = (() => { try { return require('../package.json'); } catch { return {}; } })();

/** Memoria del servidor: en Linux «disponible» (MemAvailable) es lo realista; si no, la libre. */
function memory() {
  const total = os.totalmem();
  let available = os.freemem();
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m);
    if (m) available = Number(m[1]) * 1024;
  } catch { /* no es Linux */ }
  const p = process.memoryUsage();
  return { total, available, used: total - available, process_rss: p.rss, process_heap: p.heapUsed };
}

function disk(dir) {
  try {
    const s = fs.statfsSync(dir);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { path: dir, total, free, used: total - free };
  } catch (e) { return { path: dir, error: e.message }; }
}

function dirSize(dir) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) n += dirSize(p); else if (e.isFile()) n += fs.statSync(p).size;
    }
  } catch { /* no existe */ }
  return n;
}

async function database() {
  const tables = await all(`SELECT table_name name, table_rows \`rows\`, data_length + index_length size, data_free free
    FROM information_schema.tables WHERE table_schema = ? ORDER BY size DESC`, DB_NAME);
  const v = await get('SELECT VERSION() v');
  const st = Object.fromEntries((await all("SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime', 'Threads_connected', 'Max_used_connections', 'Questions', 'Slow_queries')"))
    .map((r) => [r.Variable_name, Number(r.Value)]));
  const maxConn = await get("SHOW VARIABLES LIKE 'max_connections'");
  const counts = await get(`SELECT (SELECT COUNT(*) FROM records WHERE deleted_at IS NULL) records, (SELECT COUNT(*) FROM records WHERE deleted_at IS NOT NULL) trash,
    (SELECT COUNT(*) FROM audit_log) audit, (SELECT COUNT(*) FROM record_files) files, (SELECT COALESCE(SUM(size), 0) FROM record_files) files_size,
    (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND active = 1) users, (SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL) companies`);
  return {
    name: DB_NAME, version: v.v, size: tables.reduce((a, t) => a + Number(t.size || 0), 0),
    tables: tables.map((t) => ({ name: t.name, rows: Number(t.rows || 0), size: Number(t.size || 0) })),
    uptime: st.Uptime || 0, connections: st.Threads_connected || 0, max_used: st.Max_used_connections || 0,
    max_connections: maxConn ? Number(maxConn.Value) : null, queries: st.Questions || 0, slow_queries: st.Slow_queries || 0,
    counts: Object.fromEntries(Object.entries(counts).map(([k, x]) => [k, Number(x)])),
  };
}

/** Sesiones abiertas; «en línea» = actividad en los últimos 5 minutos. */
async function sessions() {
  return (await all(`SELECT s.id, s.user_id, u.name, u.email, u.is_superadmin, s.ip, s.user_agent, s.created_at, s.last_seen, s.expires_at,
      TIMESTAMPDIFF(SECOND, COALESCE(s.last_seen, s.created_at), UTC_TIMESTAMP()) idle_s
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.expires_at > UTC_TIMESTAMP()
    ORDER BY COALESCE(s.last_seen, s.created_at) DESC LIMIT 500`)).map((r) => ({ ...r, idle_s: r.idle_s === null ? null : Number(r.idle_s), online: r.idle_s !== null && Number(r.idle_s) < 300 }));
}

async function activity() {
  const rows = await all(`SELECT action, COUNT(*) n FROM audit_log WHERE ts > UTC_TIMESTAMP() - INTERVAL 1 DAY GROUP BY action`);
  const byApp = await all(`SELECT ap.name, COUNT(*) n FROM audit_log a JOIN apps ap ON ap.id = a.app_id
    WHERE a.ts > UTC_TIMESTAMP() - INTERVAL 1 DAY AND a.action IN ('create', 'update', 'delete') GROUP BY ap.name ORDER BY n DESC LIMIT 6`);
  const failed = await all(`SELECT summary, ip, ts FROM audit_log WHERE action = 'login_failed' AND ts > UTC_TIMESTAMP() - INTERVAL 1 DAY ORDER BY id DESC LIMIT 5`);
  return { actions: Object.fromEntries(rows.map((r) => [r.action, Number(r.n)])), by_app: byApp.map((r) => ({ name: r.name, n: Number(r.n) })), failed };
}

async function systemStatus() {
  const backup = require('./backup');
  const backups = backup.listBackups();
  return {
    now: new Date().toISOString(),
    server: {
      hostname: os.hostname(), platform: `${os.type()} ${os.release()}`, arch: os.arch(), node: process.version, app_version: pkg.version || '',
      uptime: os.uptime(), process_uptime: process.uptime(), cpus: os.cpus().length, cpu_model: (os.cpus()[0] || {}).model || '', load: os.loadavg(),
      memory: memory(),
    },
    disk: { data: disk(DATA_DIR), root: disk('/'), data_dir_size: dirSize(DATA_DIR), backups_size: backups.reduce((a, b) => a + (b.size || 0), 0) },
    database: await database(),
    sessions: await sessions(),
    activity: await activity(),
    backups: { count: backups.length, last: backups[0] || null, auto: (await get("SELECT value FROM settings WHERE `key` = 'backup_auto'") || {}).value !== '0' },
  };
}

module.exports = { systemStatus, sessions };
