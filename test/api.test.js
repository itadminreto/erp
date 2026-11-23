'use strict';
// Pruebas de integración de la API: permisos por centro, contraseñas, papelera, auditoría, campos dinámicos, import/export.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-test-'));
process.env.ADMIN_PASSWORD = 'superadmin123';
const app = require('../server/index');

let server, base;
before(() => new Promise((r) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
after(() => { server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const call = async (method, url, body, { form, company } = {}) => {
    const headers = { 'X-Requested-With': 'erp', cookie };
    if (company) headers['X-Company-Id'] = company;
    let payload;
    if (form) payload = form; else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + '/api' + url, { method, headers, body: payload });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  return { call, login: (email, password) => call('POST', '/login', { email, password }) };
}

const admin = client();
const ids = {};

test('login super admin', async () => {
  assert.equal((await admin.login('admin@erp.local', 'superadmin123')).status, 200);
  const me = await admin.call('GET', '/me');
  assert.equal(me.body.is_superadmin, true);
  ids.company = me.body.company_id;
  const centers = await admin.call('GET', '/admin/centers');
  ids.c1 = centers.body[0].id; ids.c2 = centers.body[1].id;
});

test('CSRF: sin cabecera X-Requested-With se rechaza', async () => {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
});

test('alta, validación y unicidad', async () => {
  let r = await admin.call('POST', '/apps/vehiculos/records', { center_id: ids.c1, data: { marca: 'Ford' } });
  assert.equal(r.status, 400); assert.match(r.body.error, /Matrícula: obligatorio/);
  r = await admin.call('POST', '/apps/vehiculos/records', { center_id: ids.c1, data: { matricula: '1234ABC', km: '12.500', itv_proxima: '05/03/2027', pin_tarjeta: '9876' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.km, 12500);
  assert.equal(r.body.data.itv_proxima, '2027-03-05');
  assert.equal(r.body.data.pin_tarjeta, '••••••••');
  ids.v1 = r.body.id;
  r = await admin.call('POST', '/apps/vehiculos/records', { center_id: ids.c2, data: { matricula: '1234abc' } });
  assert.equal(r.status, 409);
  r = await admin.call('POST', '/apps/vehiculos/records', { center_id: ids.c2, data: { matricula: '9999ZZZ' } });
  ids.v2 = r.body.id;
});

test('contraseñas cifradas en BD y visibles para super admin', async () => {
  const { get } = require('../server/db');
  const raw = JSON.parse(get('SELECT data FROM records WHERE id = ?', ids.v1).data);
  assert.match(raw.pin_tarjeta, /^enc:v1:/);
  const r = await admin.call('GET', `/apps/vehiculos/records/${ids.v1}/password/pin_tarjeta`);
  assert.equal(r.body.value, '9876');
});

test('usuario con rol limitado a un centro', async () => {
  const roles = (await admin.call('GET', '/admin/roles')).body.roles;
  const editor = roles.find((r) => r.name === 'Editor');
  const r = await admin.call('POST', '/admin/users', { name: 'Ana', email: 'ana@test.com', password: 'anapass123', assignments: [{ company_id: ids.company, center_id: ids.c1, role_id: editor.id }] });
  assert.equal(r.status, 201);
  const ana = client();
  assert.equal((await ana.login('ana@test.com', 'anapass123')).status, 200);
  const list = await ana.call('GET', '/apps/vehiculos/records');
  assert.deepEqual(list.body.rows.map((x) => x.id), [ids.v1]);
  assert.equal(list.body.rows[0].can.view_passwords, false);
  assert.equal((await ana.call('GET', `/apps/vehiculos/records/${ids.v2}`)).status, 403);
  assert.equal((await ana.call('GET', `/apps/vehiculos/records/${ids.v1}/password/pin_tarjeta`)).status, 403);
  assert.equal((await ana.call('DELETE', `/apps/vehiculos/records/${ids.v1}`)).status, 403);
  assert.equal((await ana.call('POST', '/apps/vehiculos/records', { center_id: ids.c2, data: { matricula: 'X1' } })).status, 403);
  assert.equal((await ana.call('POST', '/apps/vehiculos/records', { center_id: ids.c1, data: { matricula: 'X1' } })).status, 201);
  assert.equal((await ana.call('GET', '/admin/users')).status, 403);
  const upd = await ana.call('PUT', `/apps/vehiculos/records/${ids.v1}`, { data: { km: 13000 } });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.data.pin_tarjeta, '••••••••');
  const raw = await admin.call('GET', `/apps/vehiculos/records/${ids.v1}/password/pin_tarjeta`);
  assert.equal(raw.body.value, '9876', 'la contraseña no se pierde al editar otros campos');
});

test('papelera: borrar, ver en papelera, restaurar y purgar', async () => {
  assert.equal((await admin.call('DELETE', `/apps/vehiculos/records/${ids.v2}`)).status, 200);
  let l = await admin.call('GET', '/apps/vehiculos/records');
  assert.ok(!l.body.rows.some((r) => r.id === ids.v2));
  l = await admin.call('GET', '/apps/vehiculos/records?trash=1');
  const del = l.body.rows.find((r) => r.id === ids.v2);
  assert.ok(del && del.deleted_at && del.can.restore);
  assert.equal((await admin.call('POST', `/apps/vehiculos/records/${ids.v2}/restore`)).status, 200);
  assert.equal((await admin.call('DELETE', `/apps/vehiculos/records/${ids.v2}/purge`)).status, 400);
  await admin.call('DELETE', `/apps/vehiculos/records/${ids.v2}`);
  assert.equal((await admin.call('DELETE', `/apps/vehiculos/records/${ids.v2}/purge`)).status, 200);
});

test('historial con diferencias por campo', async () => {
  const h = await admin.call('GET', `/apps/vehiculos/records/${ids.v1}/history`);
  const upd = h.body.find((x) => x.action === 'update');
  assert.deepEqual(upd.changes, [{ field: 'km', from: 12500, to: 13000 }]);
  assert.ok(h.body.some((x) => x.action === 'reveal'));
});

test('campo dinámico nuevo desde super admin', async () => {
  const apps = (await admin.call('GET', '/admin/apps')).body;
  const veh = apps.find((a) => a.key === 'vehiculos');
  const r = await admin.call('POST', `/admin/apps/${veh.id}/fields`, { label: 'Combustible', type: 'select', choices: 'Diésel\nGasolina\nEléctrico' });
  assert.equal(r.body.key, 'combustible');
  const u = await admin.call('PUT', `/apps/vehiculos/records/${ids.v1}`, { data: { combustible: 'eléctrico' } });
  assert.equal(u.body.data.combustible, 'Eléctrico');
  assert.equal((await admin.call('PUT', `/apps/vehiculos/records/${ids.v1}`, { data: { combustible: 'Carbón' } })).status, 400);
});

test('importación CSV con mapeo, actualización por clave y errores por fila', async () => {
  const csv = 'Matrícula;Marca;Centro;Kilómetros;Combustible\n1234ABC;Ford;CC01;20000;Diésel\nNUEVA1;Seat;CC02;100;Gasolina\nNUEVA2;Kia;NOEXISTE;5;\n';
  const fd = new FormData(); fd.append('file', new Blob([csv], { type: 'text/csv' }), 'v.csv');
  const p = await admin.call('POST', '/apps/vehiculos/import/preview', undefined, { form: fd });
  assert.equal(p.status, 200);
  assert.deepEqual(p.body.mapping, ['matricula', 'marca', '_center', 'km', 'combustible']);
  const dry = await admin.call('POST', '/apps/vehiculos/import/commit', { token: p.body.token, mapping: p.body.mapping, match_field: 'matricula', dry_run: true });
  assert.deepEqual([dry.body.created, dry.body.updated, dry.body.errors.length], [1, 1, 1]);
  const c = await admin.call('POST', '/apps/vehiculos/import/commit', { token: p.body.token, mapping: p.body.mapping, match_field: 'matricula' });
  assert.deepEqual([c.body.created, c.body.updated, c.body.errors.length], [1, 1, 1]);
  const l = await admin.call('GET', '/apps/vehiculos/records?q=NUEVA1');
  assert.equal(l.body.rows[0].center_code, 'CC02');
});

test('exportación Excel y CSV', async () => {
  const x = await admin.call('GET', '/apps/vehiculos/export?format=xlsx');
  assert.equal(x.status, 200); assert.equal(x.body.subarray(0, 2).toString(), 'PK');
  const c = await admin.call('GET', '/apps/vehiculos/export?format=csv');
  const text = c.body.toString('utf8');
  assert.match(text, /^﻿ID;Centro;Matrícula/);
  assert.ok(!text.includes('9876'), 'sin contraseñas por defecto');
  const cp = await admin.call('GET', '/apps/vehiculos/export?format=csv&passwords=1');
  assert.ok(cp.body.toString('utf8').includes('9876'));
});

test('compartir contraseña con enlace de un solo uso', async () => {
  const s = await admin.call('POST', `/apps/vehiculos/records/${ids.v1}/share`, { field: 'pin_tarjeta', channel: 'whatsapp', to: '600111222' });
  assert.match(s.body.url, /^https:\/\/wa\.me\/600111222\?text=/);
  const anon = client();
  const o = await anon.call('POST', `/share/${s.body.code}`);
  assert.equal(o.body.value, '9876');
  assert.equal((await anon.call('POST', `/share/${s.body.code}`)).status, 410);
});

test('diseño de columnas por usuario', async () => {
  await admin.call('PUT', '/apps/vehiculos/layout/list', { columns: ['matricula', '_center'] });
  const m = await admin.call('GET', '/apps/vehiculos');
  assert.deepEqual(m.body.layouts.list.columns, ['matricula', '_center']);
});
