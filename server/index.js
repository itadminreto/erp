'use strict';
const path = require('path');
const express = require('express');
const db = require('./db');
const { get, run, all, tx } = db;
const { loadUser, requireAuth, requireSuper, createSession, destroySession, verify, hash, userCompanies } = require('./auth');
const { seed } = require('./seed');
const { audit } = require('./audit');
const { decrypt } = require('./crypto');
const { getSetting } = require('./mailer');
const radius = require('./radius');
const { router: recordsRouter, wrap, httpError, fail } = require('./routes/records');
const adminRouter = require('./routes/admin');

const app = express();
// Detrás de Nginx/Apache en la misma máquina: solo se confía en la cabecera X-Forwarded-For del proxy local.
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 'loopback' : false);
app.disable('x-powered-by');
app.use(express.json({ limit: '80mb' })); // admite varias fotos en un mismo guardado
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// La base de datos debe estar lista antes de atender peticiones.
app.ready = (async () => { await db.init(); await seed(); })();
app.use((req, res, next) => app.ready.then(() => next(), next));
app.use(loadUser);

// Protección CSRF básica: las peticiones de la API que modifican datos deben venir de la propia app.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-requested-with'] !== 'erp') return res.status(403).json({ error: 'Petición no permitida' });
  next();
});

// Comprobación de estado (para instaladores y monitorización)
app.get('/api/health', wrap(async (req, res) => { await get('SELECT 1 ok'); res.json({ ok: true }); }));

// ---------- autenticación ----------
const attempts = new Map();
app.post('/api/login', wrap(async (req, res) => {
  const { email = '', password = '' } = req.body || {};
  const ident = String(email).trim();
  const k = `${req.ip}|${ident.toLowerCase()}`;
  const a = attempts.get(k) || { n: 0, t: Date.now() };
  if (a.n >= 8 && Date.now() - a.t < 10 * 60e3) throw httpError(429, 'Demasiados intentos. Espera unos minutos.');
  const failed = async (detail) => {
    attempts.set(k, { n: a.n + 1, t: a.n === 0 ? Date.now() : a.t });
    await audit(req, { entity: 'auth', action: 'login_failed', summary: `Acceso fallido: ${ident}${detail ? ` (${detail})` : ''}` });
    throw httpError(401, 'Usuario o contraseña incorrectos');
  };
  const rcfg = await radius.radiusConfig();
  // se entra con el email o, si RADIUS está activo, también con el usuario RADIUS
  let u = await get('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL', ident);
  if (!u && rcfg.enabled && ident) u = await get('SELECT * FROM users WHERE radius_username = ? AND deleted_at IS NULL', ident);
  if (!u || !u.active || !password) await failed(u && !u.active ? 'usuario desactivado' : '');
  let ok = false, via = 'local';
  if (u.is_superadmin && verify(password, u.password_hash)) ok = true; // el super admin siempre puede entrar en local (emergencia)
  else if (radius.usesRadius(rcfg, u)) {
    try {
      const r = await radius.authenticate({ ...rcfg, username: radius.radiusUsername(rcfg, u), password, callingStation: req.ip });
      if (!r.ok) console.warn(`RADIUS ${r.server}: ${r.code} para «${radius.radiusUsername(rcfg, u)}»${r.message ? ` (${r.message})` : ''}`);
      ok = r.ok; via = `RADIUS ${r.server}`;
      if (!ok) await failed(`${r.code === 'challenge' ? 'RADIUS pide un segundo factor, no admitido' : 'rechazado por RADIUS'} ${r.server} como «${radius.radiusUsername(rcfg, u)}»${r.message ? `: ${r.message}` : ''}`);
    } catch (e) {
      if (e.status) throw e;
      if (rcfg.fallback && u.password_hash) { ok = verify(password, u.password_hash); via = 'local (RADIUS sin respuesta)'; }
      else {
        await audit(req, { entity: 'auth', action: 'login_failed', summary: `Acceso fallido: ${ident} (${e.message})` });
        throw httpError(503, 'No se puede contactar con el servidor de autenticación (RADIUS). Inténtalo en unos minutos o avisa al administrador.');
      }
    }
  } else ok = verify(password, u.password_hash);
  if (!ok) await failed();
  attempts.delete(k);
  await createSession(res, u.id);
  await run(`UPDATE users SET last_login = UTC_TIMESTAMP() WHERE id = ?`, u.id);
  await run('DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()');
  await audit({ user: u, ip: req.ip }, { entity: 'auth', entityId: u.id, action: 'login', summary: `Inicio de sesión${via === 'local' ? '' : ` (${via})`}` });
  res.json({ ok: true });
}));
app.post('/api/logout', wrap(async (req, res) => { await destroySession(req, res); res.json({ ok: true }); }));

app.get('/api/me', requireAuth, wrap(async (req, res) => {
  const u = req.user;
  res.json({
    id: u.id, name: u.name, email: u.email, phone: u.phone, is_superadmin: u.is_superadmin,
    ...(await (async () => {
      const managed = radius.usesRadius(await radius.radiusConfig(), u); // contraseña gestionada por RADIUS
      return { must_change_password: !!u.must_change_password && !managed, password_managed: managed ? 'radius' : '' };
    })()),
    accessible: !!u.is_accessible,
    companies: req.companies, company_id: req.companyId,
    app_name: await getSetting('app_name', 'Gestión de Aplicaciones'),
  });
}));
app.put('/api/me', requireAuth, wrap(async (req, res) => {
  const { name, phone, current_password, new_password } = req.body || {};
  if (name !== undefined) await run('UPDATE users SET name = ? WHERE id = ?', String(name).trim() || req.user.name, req.user.id);
  if (phone !== undefined) await run('UPDATE users SET phone = ? WHERE id = ?', String(phone).trim(), req.user.id);
  if (new_password) {
    if (radius.usesRadius(await radius.radiusConfig(), req.user)) throw httpError(400, 'Tu contraseña se gestiona en el servidor RADIUS (la de la red de la organización): cámbiala allí.');
    if (!verify(current_password || '', req.user.password_hash)) throw httpError(400, 'La contraseña actual no es correcta');
    if (String(new_password).length < 8) throw httpError(400, 'La nueva contraseña debe tener al menos 8 caracteres');
    await run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', hash(new_password), req.user.id);
    await audit(req, { entity: 'users', entityId: req.user.id, action: 'password', summary: 'Cambio de contraseña propia' });
  }
  res.json({ ok: true });
}));

// ---------- enlaces de un solo uso para contraseñas compartidas ----------
app.post('/api/share/:code', wrap(async (req, res) => {
  const out = await tx(async () => {
    const s = await get(`SELECT * FROM share_links WHERE code = ? AND expires_at > UTC_TIMESTAMP() AND views < max_views FOR UPDATE`,
      String(req.params.code).toUpperCase());
    if (!s) throw httpError(410, 'El enlace no existe, ha caducado o ya se ha utilizado');
    const rec = await get('SELECT r.*, a.name app_name, a.title_field FROM records r JOIN apps a ON a.id = r.app_id WHERE r.id = ? AND r.deleted_at IS NULL', s.record_id);
    if (!rec) throw httpError(410, 'El registro ya no está disponible');
    const f = await get('SELECT label FROM fields WHERE app_id = ? AND `key` = ?', rec.app_id, s.field_key);
    const data = JSON.parse(rec.data);
    await run('UPDATE share_links SET views = views + 1 WHERE code = ?', s.code);
    await audit(req, { entity: 'record', entityId: rec.id, appId: rec.app_id, companyId: rec.company_id, action: 'share_open', summary: `Enlace de contraseña abierto (${s.code}) desde ${req.ip}` });
    return { app: rec.app_name, title: data[rec.title_field] || '', label: f ? f.label : s.field_key, value: decrypt(data[s.field_key]), remaining: s.max_views - s.views - 1 };
  });
  res.json(out);
}));
app.get('/s/:code', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'share.html')));

// ---------- API ----------
app.use('/api/apps', requireAuth, recordsRouter);
app.use('/api/admin', requireSuper, adminRouter);
app.get('/api/companies/:id/centers', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!(await userCompanies(req.user)).some((c) => c.id === id)) throw httpError(403, 'Sin acceso');
  // Solo los centros asignados al usuario (todos si es super admin o tiene acceso a toda la empresa)
  const full = req.user.is_superadmin || await get('SELECT 1 FROM user_assignments WHERE user_id = ? AND company_id = ? AND center_id IS NULL LIMIT 1', req.user.id, id);
  res.json(await all(`SELECT id, code, name, kind FROM centers WHERE company_id = ? AND deleted_at IS NULL
    ${full ? '' : 'AND id IN (SELECT center_id FROM user_assignments WHERE user_id = ? AND company_id = ?)'} ORDER BY code, name`,
  ...(full ? [id] : [id, req.user.id, id])));
}));
app.get('/api/companies/:id/logo', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!(await userCompanies(req.user)).some((c) => c.id === id)) throw httpError(403, 'Sin acceso');
  const row = await get('SELECT logo FROM companies WHERE id = ?', id);
  const m = row && row.logo && row.logo.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/);
  if (!m) throw httpError(404, 'Sin logo');
  res.setHeader('Content-Type', m[1]);
  res.setHeader('Cache-Control', 'private, no-cache');
  res.send(Buffer.from(m[2], 'base64'));
}));
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// ---------- frontend ----------
app.use('/vendor/sortable.min.js', (req, res) => res.sendFile(require.resolve('sortablejs/Sortable.min.js')));
app.use('/vendor/html2pdf.bundle.min.js', (req, res) => res.sendFile(path.join(path.dirname(require.resolve('html2pdf.js/package.json')), 'dist', 'html2pdf.bundle.min.js')));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// Errores no controlados → JSON
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => fail(res, err));

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || undefined; // p. ej. 127.0.0.1 para escuchar solo detrás del proxy
if (require.main === module) {
  app.ready
    .then(() => { require('./backup').startScheduler(); return app.listen(PORT, HOST, () => console.log(`ERP escuchando en http://${HOST || 'localhost'}:${PORT} (MariaDB: ${db.DB_NAME})`)); })
    .catch((e) => { console.error('No se pudo conectar a MariaDB:', e.message); process.exit(1); });
}
module.exports = app;
