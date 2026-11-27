'use strict';
// Cliente RADIUS (RFC 2865) para validar contraseñas con PAP. Sin dependencias: UDP + MD5/HMAC-MD5.
// Incluye Message-Authenticator (RFC 3579) como primer atributo y verifica el Response Authenticator
// y, si viene, el Message-Authenticator de la respuesta (protección frente a BlastRADIUS).
const dgram = require('dgram');
const crypto = require('crypto');
const net = require('net');

const CODE = { ACCESS_REQUEST: 1, ACCESS_ACCEPT: 2, ACCESS_REJECT: 3, ACCESS_CHALLENGE: 11 };
const ATTR = { USER_NAME: 1, USER_PASSWORD: 2, NAS_IP_ADDRESS: 4, SERVICE_TYPE: 6, REPLY_MESSAGE: 18, CALLING_STATION_ID: 31, NAS_IDENTIFIER: 32, MESSAGE_AUTHENTICATOR: 80 };

const md5 = (...bufs) => crypto.createHash('md5').update(Buffer.concat(bufs)).digest();
const attr = (type, value) => {
  const v = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  if (v.length > 253) throw new Error('Atributo RADIUS demasiado largo');
  return Buffer.concat([Buffer.from([type, v.length + 2]), v]);
};

/** Cifra la contraseña para el atributo User-Password (RFC 2865 §5.2). */
function hidePassword(password, secret, authenticator) {
  let p = Buffer.from(String(password), 'utf8');
  if (p.length > 128) throw new Error('Contraseña demasiado larga para RADIUS');
  const len = Math.max(16, Math.ceil(p.length / 16) * 16);
  p = Buffer.concat([p, Buffer.alloc(len - p.length)]);
  const out = Buffer.alloc(len);
  let prev = authenticator;
  for (let i = 0; i < len; i += 16) {
    const b = md5(secret, prev);
    for (let j = 0; j < 16; j++) out[i + j] = p[i + j] ^ b[j];
    prev = out.subarray(i, i + 16);
  }
  return out;
}

/** Construye un Access-Request. Devuelve { packet, id, authenticator }. */
function buildRequest({ username, password, secret, nasId, nasIp, callingStation }) {
  const sec = Buffer.from(secret, 'utf8');
  const id = crypto.randomInt(0, 256);
  const authenticator = crypto.randomBytes(16);
  const attrs = [
    attr(ATTR.MESSAGE_AUTHENTICATOR, Buffer.alloc(16)), // primero, a cero; se rellena al final
    attr(ATTR.USER_NAME, username),
    attr(ATTR.USER_PASSWORD, hidePassword(password, sec, authenticator)),
    attr(ATTR.SERVICE_TYPE, Buffer.from([0, 0, 0, 8])), // Authenticate-Only
    attr(ATTR.NAS_IDENTIFIER, nasId || 'erp'),
  ];
  if (nasIp && net.isIPv4(nasIp)) attrs.push(attr(ATTR.NAS_IP_ADDRESS, Buffer.from(nasIp.split('.').map(Number))));
  if (callingStation) attrs.push(attr(ATTR.CALLING_STATION_ID, String(callingStation).slice(0, 64)));
  const body = Buffer.concat(attrs);
  const packet = Buffer.concat([Buffer.from([CODE.ACCESS_REQUEST, id, 0, 0]), authenticator, body]);
  packet.writeUInt16BE(packet.length, 2);
  if (packet.length > 4096) throw new Error('Petición RADIUS demasiado grande');
  const ma = crypto.createHmac('md5', sec).update(packet).digest();
  ma.copy(packet, 20 + 2); // valor del primer atributo (tras cabecera de 20 bytes + tipo y longitud)
  return { packet, id, authenticator };
}

/** Lee los atributos de una respuesta. */
function parseAttrs(buf) {
  const out = [];
  for (let i = 20; i + 2 <= buf.length;) {
    const t = buf[i], l = buf[i + 1];
    if (l < 2 || i + l > buf.length) throw new Error('Respuesta RADIUS mal formada');
    out.push({ type: t, offset: i, value: buf.subarray(i + 2, i + l) });
    i += l;
  }
  return out;
}

/** Comprueba que la respuesta viene del servidor (secreto compartido correcto) y corresponde a nuestra petición. */
function verifyResponse(buf, req, secret) {
  if (buf.length < 20 || buf[1] !== req.id) return false;
  const len = buf.readUInt16BE(2);
  if (len !== buf.length) return false;
  const sec = Buffer.from(secret, 'utf8');
  const expected = md5(buf.subarray(0, 4), req.authenticator, buf.subarray(20), sec);
  if (!crypto.timingSafeEqual(expected, buf.subarray(4, 20))) return false;
  const ma = parseAttrs(buf).find((a) => a.type === ATTR.MESSAGE_AUTHENTICATOR);
  if (ma) {
    const copy = Buffer.from(buf);
    req.authenticator.copy(copy, 4);
    copy.fill(0, ma.offset + 2, ma.offset + 18);
    const calc = crypto.createHmac('md5', sec).update(copy).digest();
    if (ma.value.length !== 16 || !crypto.timingSafeEqual(calc, ma.value)) return false;
  }
  return true;
}

/** Envía la petición a un servidor con reintentos. Resuelve con el paquete de respuesta o lanza error. */
function exchange(host, port, req, secret, { timeout = 5000, retries = 2 } = {}) {
  return new Promise((resolve, reject) => {
    const family = net.isIPv6(host) ? 'udp6' : 'udp4';
    const sock = dgram.createSocket(family);
    let tries = 0, timer = null, finished = false;
    const finish = (err, val) => {
      if (finished) return;
      finished = true; clearTimeout(timer); try { sock.close(); } catch { /* ya cerrado */ }
      if (err) reject(err); else resolve(val);
    };
    const send = () => {
      tries += 1;
      sock.send(req.packet, port, host, (e) => { if (e) finish(Object.assign(new Error(`No se puede enviar a ${host}:${port}: ${e.message}`), { unreachable: true })); });
      timer = setTimeout(() => (tries <= retries ? send() : finish(Object.assign(new Error(`El servidor RADIUS ${host}:${port} no responde`), { unreachable: true }))), timeout);
    };
    sock.on('message', (msg) => {
      if (!verifyResponse(msg, req, secret)) return; // se ignoran respuestas falsas o de otras peticiones
      finish(null, msg);
    });
    sock.on('error', (e) => finish(Object.assign(new Error(`Error de red RADIUS: ${e.message}`), { unreachable: true })));
    send();
  });
}

/**
 * Valida usuario y contraseña. `servers`: [{ host, port }] (se prueba el siguiente si uno no responde).
 * Devuelve { ok: boolean, code: 'accept'|'reject'|'challenge', message, server }. Lanza error (err.unreachable)
 * si ningún servidor responde.
 */
async function authenticate({ servers, secret, username, password, nasId, nasIp, callingStation, timeout, retries }) {
  if (!secret) throw new Error('Falta el secreto compartido de RADIUS');
  let lastErr = null;
  for (const s of servers.filter((x) => x && x.host)) {
    const req = buildRequest({ username, password, secret, nasId, nasIp, callingStation });
    try {
      const res = await exchange(s.host, Number(s.port) || 1812, req, secret, { timeout, retries });
      const msgs = parseAttrs(res).filter((a) => a.type === ATTR.REPLY_MESSAGE).map((a) => a.value.toString('utf8')).join(' ');
      const code = res[0] === CODE.ACCESS_ACCEPT ? 'accept' : res[0] === CODE.ACCESS_CHALLENGE ? 'challenge' : 'reject';
      return { ok: code === 'accept', code, message: msgs, server: `${s.host}:${Number(s.port) || 1812}` };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || Object.assign(new Error('No hay servidor RADIUS configurado'), { unreachable: true });
}

module.exports = { authenticate, buildRequest, verifyResponse, hidePassword, CODE, ATTR };

// ---------- configuración (Ajustes) ----------
/** Lee la configuración de RADIUS de los ajustes. */
async function radiusConfig() {
  const { all } = require('./db');
  const { decrypt } = require('./crypto');
  const s = Object.fromEntries((await all("SELECT `key`, value FROM settings WHERE `key` LIKE 'radius\\_%'")).map((r) => [r.key, r.value || '']));
  return {
    enabled: s.radius_enabled === '1',
    servers: [{ host: s.radius_host, port: Number(s.radius_port) || 1812 }, { host: s.radius_host2, port: Number(s.radius_port2) || Number(s.radius_port) || 1812 }].filter((x) => x.host),
    secret: s.radius_secret ? decrypt(s.radius_secret) : '',
    timeout: Math.min(Math.max(Number(s.radius_timeout) || 5, 1), 30) * 1000,
    retries: Math.min(Math.max(Number(s.radius_retries ?? 2) || 0, 0), 5),
    nasId: s.radius_nas_id || 'erp',
    userFormat: s.radius_user_format === 'local' ? 'local' : 'email',
    fallback: s.radius_fallback === '1',
  };
}
/** ¿Este usuario valida la contraseña con RADIUS? (los marcados «Siempre local» no). */
const usesRadius = (cfg, user) => cfg.enabled && user.auth_method !== 'local';
/** Nombre de usuario que se envía al servidor RADIUS. */
function radiusUsername(cfg, user) {
  if (user.radius_username) return user.radius_username;
  return cfg.userFormat === 'local' ? String(user.email).split('@')[0] : user.email;
}
module.exports.radiusConfig = radiusConfig;
module.exports.usesRadius = usesRadius;
module.exports.radiusUsername = radiusUsername;
