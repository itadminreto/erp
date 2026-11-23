'use strict';
const nodemailer = require('nodemailer');
const { get } = require('./db');
const { decrypt } = require('./crypto');

function getSetting(key, def = '') {
  const r = get('SELECT value FROM settings WHERE key = ?', key);
  return r && r.value !== null ? r.value : def;
}

function publicUrl(req) {
  const s = getSetting('public_url') || process.env.PUBLIC_URL;
  if (s) return s.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

async function sendMail({ to, subject, text }) {
  const host = getSetting('smtp_host') || process.env.SMTP_HOST;
  if (!host) throw Object.assign(new Error('El correo saliente (SMTP) no está configurado. Configúralo en Ajustes.'), { status: 400 });
  const transport = nodemailer.createTransport({
    host,
    port: Number(getSetting('smtp_port') || process.env.SMTP_PORT || 587),
    secure: (getSetting('smtp_secure') || process.env.SMTP_SECURE) === '1',
    auth: (getSetting('smtp_user') || process.env.SMTP_USER)
      ? { user: getSetting('smtp_user') || process.env.SMTP_USER, pass: decrypt(getSetting('smtp_pass')) || process.env.SMTP_PASS }
      : undefined,
  });
  const from = getSetting('smtp_from') || process.env.SMTP_FROM || getSetting('smtp_user');
  try {
    await transport.sendMail({ from, to, subject, text });
  } catch (e) {
    throw Object.assign(new Error('No se pudo enviar el correo: ' + e.message), { status: 502 });
  }
}

module.exports = { sendMail, getSetting, publicUrl };
