'use strict';
const nodemailer = require('nodemailer');
const { get } = require('./db');
const { decrypt } = require('./crypto');

async function getSetting(key, def = '') {
  const r = await get('SELECT value FROM settings WHERE `key` = ?', key);
  return r && r.value !== null ? r.value : def;
}

async function publicUrl(req) {
  const s = (await getSetting('public_url')) || process.env.PUBLIC_URL;
  if (s) return s.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

async function sendMail({ to, subject, text, attachments }) {
  const S = {};
  for (const k of ['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from']) S[k] = await getSetting(k);
  const host = S.smtp_host || process.env.SMTP_HOST;
  if (!host) throw Object.assign(new Error('El correo saliente (SMTP) no está configurado. Configúralo en Ajustes.'), { status: 400 });
  const transport = nodemailer.createTransport({
    host,
    port: Number(S.smtp_port || process.env.SMTP_PORT || 587),
    secure: (S.smtp_secure || process.env.SMTP_SECURE) === '1',
    auth: (S.smtp_user || process.env.SMTP_USER)
      ? { user: S.smtp_user || process.env.SMTP_USER, pass: decrypt(S.smtp_pass) || process.env.SMTP_PASS }
      : undefined,
  });
  const from = S.smtp_from || process.env.SMTP_FROM || S.smtp_user || process.env.SMTP_USER;
  try {
    await transport.sendMail({ from, to, subject, text, attachments });
  } catch (e) {
    throw Object.assign(new Error('No se pudo enviar el correo: ' + e.message), { status: 502 });
  }
}

module.exports = { sendMail, getSetting, publicUrl };
