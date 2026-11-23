'use strict';
// Cifrado reversible (AES-256-GCM) para campos de tipo "password".
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./db');

function loadKey() {
  if (process.env.APP_SECRET) return crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
  const f = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
}
const KEY = loadKey();
const PREFIX = 'enc:v1:';

function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(value) {
  if (!value || typeof value !== 'string' || !value.startsWith(PREFIX)) return value || '';
  const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}
const isEncrypted = (v) => typeof v === 'string' && v.startsWith(PREFIX);
const token = (n = 32) => crypto.randomBytes(n).toString('base64url');
function shortCode(len = 8) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(len)) s += abc[b % abc.length];
  return s;
}

module.exports = { encrypt, decrypt, isEncrypted, token, shortCode };
