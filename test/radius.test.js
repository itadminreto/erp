// Autenticación RADIUS: cliente propio contra un servidor de pruebas hecho con otra librería (paquete «radius»).
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');
const crypto = require('crypto');
const radiusLib = require('radius');
const radius = require('../server/radius');

const SECRET = 'secreto-de-prueba';
let srv, port, mode = 'normal'; const seen = [];
before(async () => {
  srv = dgram.createSocket('udp4');
  srv.on('message', (msg, rinfo) => {
    const req = radiusLib.decode({ packet: msg, secret: SECRET });
    // la petición debe llevar un Message-Authenticator válido (BlastRADIUS)
    const ma = msg.indexOf(Buffer.from([80, 18]), 20);
    const copy = Buffer.from(msg); copy.fill(0, ma + 2, ma + 18);
    const okMa = ma === 20 && crypto.createHmac('md5', SECRET).update(copy).digest().equals(msg.subarray(ma + 2, ma + 18));
    seen.push({ user: req.attributes['User-Name'], okMa, nas: req.attributes['NAS-Identifier'], cli: req.attributes['Calling-Station-Id'], nasIp: req.attributes['NAS-IP-Address'] });
    if (mode === 'silent') return;
    const good = req.attributes['User-Name'] === 'ana' && req.attributes['User-Password'] === 'clave larga con ñ y más de 16 caracteres';
    const res = radiusLib.encode_response({ packet: req, code: good ? 'Access-Accept' : 'Access-Reject', secret: mode === 'badsecret' ? 'otro' : SECRET,
      attributes: [['Reply-Message', good ? 'Bienvenida' : 'Credenciales no válidas']] });
    srv.send(res, rinfo.port, rinfo.address);
  });
  await new Promise((r) => srv.bind(0, '127.0.0.1', r));
  port = srv.address().port;
});
after(() => srv.close());

const base = () => ({ servers: [{ host: '127.0.0.1', port }], secret: SECRET, nasId: 'erp-test', timeout: 300, retries: 1 });

test('RADIUS: acepta, rechaza y envía Message-Authenticator', async () => {
  mode = 'normal';
  const ok = await radius.authenticate({ ...base(), username: 'ana', password: 'clave larga con ñ y más de 16 caracteres' });
  assert.equal(ok.ok, true); assert.equal(ok.code, 'accept'); assert.equal(ok.message, 'Bienvenida');
  const bad = await radius.authenticate({ ...base(), username: 'ana', password: 'mala' });
  assert.equal(bad.ok, false); assert.equal(bad.code, 'reject');
  assert.ok(seen.every((s) => s.okMa), 'Message-Authenticator correcto y como primer atributo');
  assert.equal(seen[0].nas, 'erp-test');
});

test('RADIUS: ignora respuestas con otro secreto y avisa si el servidor no responde', async () => {
  mode = 'badsecret';
  await assert.rejects(radius.authenticate({ ...base(), username: 'ana', password: 'x' }), (e) => e.unreachable === true);
  mode = 'silent';
  await assert.rejects(radius.authenticate({ ...base(), username: 'ana', password: 'x' }), /no responde/);
  // servidor secundario
  mode = 'normal';
  const r = await radius.authenticate({ ...base(), servers: [{ host: '127.0.0.1', port: 9 }, { host: '127.0.0.1', port }], username: 'ana', password: 'mala' });
  assert.equal(r.code, 'reject');
});

test('RADIUS: la IP del usuario (Calling-Station-Id) solo se envía si se activa; NAS-IP-Address opcional; DOMINIO\\usuario', async () => {
  mode = 'normal'; seen.length = 0;
  await radius.authenticate({ ...base(), username: 'ana', password: 'x', callingStation: '192.168.0.55' });
  assert.equal(seen[0].cli, undefined, 'por defecto no se envía');
  await radius.authenticate({ ...base(), username: 'ana', password: 'x', callingStation: '192.168.0.55', sendCallingStation: true, nasIp: '192.168.0.201' });
  assert.equal(seen[1].cli, '192.168.0.55');
  assert.equal(seen[1].nasIp, '192.168.0.201');
  const u = { email: 'ana.lopez@asociacion.org' };
  assert.equal(radius.radiusUsername({ userFormat: 'domain', domain: 'ASOCIACION' }, u), 'ASOCIACION\\ana.lopez');
  assert.equal(radius.radiusUsername({ userFormat: 'local' }, u), 'ana.lopez');
  assert.equal(radius.radiusUsername({ userFormat: 'email' }, { ...u, radius_username: 'alopez' }), 'alopez');
  assert.equal(await radius.sourceAddress('127.0.0.1', port), '127.0.0.1');
});

module.exports = { SECRET };
