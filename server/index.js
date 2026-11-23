'use strict';
const path = require('path');
const express = require('express');
const { get, run } = require('./db');
const { loadUser, requireAuth, requireSuper, createSession, destroySession, verify, hash, userCompanies } = require('./auth');
const { seed } = require('./seed');
const { audit } = require('./audit');
const { decrypt } = require('./crypto');
const { getSetting } = require('./mailer');
const { router: recordsRouter, wrap, httpError } = require('./routes/records');
const adminRouter = require('./routes/admin');

seed();

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === '1');
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(loadUser);

// Protección CSRF básica: las peticiones de la API que modifican datos deben venir de la propia app.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-requested-with'] !== 'erp') return res.status(403).json({ error: 'Petición no permitida' });
  next();
});

// ---------- autenticación ----------
const attempts = new Map();
app.post('/api/login', wrap((req, res) => {
  const { email = '', password = '' } = req.body || {};
  const k = `${req.ip}|${String(email).toLowerCase()}`;
  const a = attempts.get(k) || { n: 0, t: Date.now() };
  if (a.n >= 8 && Date.now() - a.t < 10 * 60e3) throw httpError(429, 'Demasiados intentos. Espera unos minutos.');
  const u = get('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL', String(email).trim());
  if (!u || !u.active || !verify(password, u.password_hash)) {
    attempts.set(k, { n: a.n + 1, t: a.n === 0 ? Date.now() : a.t });
    audit(req, { entity: 'auth', action: 'login_failed', summary: `Acceso fallido: ${email}` });
    throw httpError(401, 'Email o contraseña incorrectos');
  }
  attempts.delete(k);
  createSession(res, u.id);
  run(`UPDATE users SET last_login = datetime('now') WHERE id = ?`, u.id);
  audit({ user: u, ip: req.ip }, { entity: 'auth', entityId: u.id, action: 'login', summary: 'Inicio de sesión' });
  res.json({ ok: true });
}));
app.post('/api/logout', (req, res) => { destroySession(req, res); res.json({ ok: true }); });

app.get('/api/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({
    id: u.id, name: u.name, email: u.email, phone: u.phone, is_superadmin: u.is_superadmin,
    must_change_password: !!u.must_change_password,
    companies: req.companies, company_id: req.companyId,
    app_name: getSetting('app_name', 'Gestión de Aplicaciones'),
  });
});
app.put('/api/me', requireAuth, wrap((req, res) => {
  const { name, phone, current_password, new_password } = req.body || {};
  if (name !== undefined) run('UPDATE users SET name = ? WHERE id = ?', String(name).trim() || req.user.name, req.user.id);
  if (phone !== undefined) run('UPDATE users SET phone = ? WHERE id = ?', String(phone).trim(), req.user.id);
  if (new_password) {
    if (!verify(current_password || '', req.user.password_hash)) throw httpError(400, 'La contraseña actual no es correcta');
    if (String(new_password).length < 8) throw httpError(400, 'La nueva contraseña debe tener al menos 8 caracteres');
    run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', hash(new_password), req.user.id);
    audit(req, { entity: 'users', entityId: req.user.id, action: 'password', summary: 'Cambio de contraseña propia' });
  }
  res.json({ ok: true });
}));

// ---------- enlaces de un solo uso para contraseñas compartidas ----------
app.post('/api/share/:code', wrap((req, res) => {
  const s = get('SELECT * FROM share_links WHERE code = ?', String(req.params.code).toUpperCase());
  if (!s || s.expires_at < new Date().toISOString() || s.views >= s.max_views) throw httpError(410, 'El enlace no existe, ha caducado o ya se ha utilizado');
  const rec = get('SELECT r.*, a.name app_name, a.title_field FROM records r JOIN apps a ON a.id = r.app_id WHERE r.id = ? AND r.deleted_at IS NULL', s.record_id);
  if (!rec) throw httpError(410, 'El registro ya no está disponible');
  const f = get('SELECT label FROM fields WHERE app_id = ? AND key = ?', rec.app_id, s.field_key);
  const data = JSON.parse(rec.data);
  run('UPDATE share_links SET views = views + 1 WHERE code = ?', s.code);
  audit(req, { entity: 'record', entityId: rec.id, appId: rec.app_id, companyId: rec.company_id, action: 'share_open', summary: `Enlace de contraseña abierto (${s.code}) desde ${req.ip}` });
  res.json({ app: rec.app_name, title: data[rec.title_field] || '', label: f ? f.label : s.field_key, value: decrypt(data[s.field_key]), remaining: s.max_views - s.views - 1 });
}));
app.get('/s/:code', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'share.html')));

// ---------- API ----------
app.use('/api/apps', requireAuth, recordsRouter);
app.use('/api/admin', requireSuper, adminRouter);
app.get('/api/companies/:id/centers', requireAuth, wrap((req, res) => {
  const id = Number(req.params.id);
  if (!userCompanies(req.user).some((c) => c.id === id)) throw httpError(403, 'Sin acceso');
  res.json(require('./db').all('SELECT id, code, name, kind FROM centers WHERE company_id = ? AND deleted_at IS NULL ORDER BY code, name', id));
}));
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// ---------- frontend ----------
app.use('/vendor/sortable.min.js', (req, res) => res.sendFile(require.resolve('sortablejs/Sortable.min.js')));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const PORT = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`ERP escuchando en http://localhost:${PORT}`));
}
module.exports = app;
