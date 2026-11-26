'use strict';
// Pruebas de integración de la API: permisos por centro, contraseñas, papelera, auditoría, campos dinámicos, import/export.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Requiere un MariaDB accesible (DB_HOST, DB_USER, DB_PASSWORD). Usa la base de datos DB_NAME_TEST (erp_test), que se BORRA.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-test-'));
process.env.ADMIN_PASSWORD = 'superadmin123';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'erp_test';
const mariadb = require('mariadb');

let app, db, server, base;
before(async () => {
  const c = await mariadb.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT) || 3306, user: process.env.DB_USER || 'erp', password: process.env.DB_PASSWORD ?? 'erp' });
  await c.query(`DROP DATABASE IF EXISTS \`${process.env.DB_NAME}\``);
  await c.end();
  app = require('../server/index');
  db = require('../server/db');
  await app.ready;
  await new Promise((r) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
after(async () => { server.close(); await db.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

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
  const raw = JSON.parse((await db.get('SELECT data FROM records WHERE id = ?', ids.v1)).data);
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
  assert.match(text, /^﻿Nº;Centro;Matrícula/);
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

test('orden numérico y filtro por columna', async () => {
  const asc = await admin.call('GET', '/apps/vehiculos/records?sort=km&dir=asc');
  const kms = asc.body.rows.map((r) => r.data.km).filter((k) => k !== '');
  assert.deepEqual(kms, [...kms].sort((a, b) => a - b));
  const f = await admin.call('GET', '/apps/vehiculos/records?f_combustible=Gasolina');
  assert.deepEqual(f.body.rows.map((r) => r.data.matricula), ['NUEVA1']);
});

test('la simulación detecta duplicados dentro del mismo fichero y no guarda nada', async () => {
  const csv = 'Matrícula;Marca\nDUP1;A\nDUP1;B\n';
  const fd = new FormData(); fd.append('file', new Blob([csv], { type: 'text/csv' }), 'd.csv');
  const p = await admin.call('POST', '/apps/vehiculos/import/preview', undefined, { form: fd });
  const dry = await admin.call('POST', '/apps/vehiculos/import/commit', { token: p.body.token, mapping: p.body.mapping, dry_run: true });
  assert.deepEqual([dry.body.created, dry.body.errors.length], [1, 1]);
  const l = await admin.call('GET', '/apps/vehiculos/records?q=DUP1');
  assert.equal(l.body.total, 0);
});

test('logo de empresa: subir, ver y borrar', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData(); fd.append('file', new Blob([png], { type: 'image/png' }), 'logo.png');
  assert.equal((await admin.call('POST', `/admin/companies/${ids.company}/logo`, undefined, { form: fd })).status, 200);
  const me = await admin.call('GET', '/me');
  assert.equal(me.body.companies.find((c) => c.id === ids.company).has_logo, 1);
  const img = await admin.call('GET', `/companies/${ids.company}/logo`);
  assert.equal(img.status, 200); assert.deepEqual(img.body, png);
  const list = await admin.call('GET', '/admin/companies');
  assert.ok(!('logo' in list.body[0]), 'el listado no incluye el binario');
  const svg = new FormData(); svg.append('file', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'x.svg');
  assert.equal((await admin.call('POST', `/admin/companies/${ids.company}/logo`, undefined, { form: svg })).status, 400);
  const anaC = client(); await anaC.login('ana@test.com', 'anapass123');
  assert.equal((await anaC.call('GET', `/companies/${ids.company}/logo`)).status, 200, 'los usuarios de la empresa ven el logo');
  assert.equal((await admin.call('DELETE', `/admin/companies/${ids.company}/logo`)).status, 200);
  assert.equal((await admin.call('GET', `/companies/${ids.company}/logo`)).status, 404);
});

test('filtro por rango de fechas (calendario)', async () => {
  await admin.call('PUT', `/apps/vehiculos/records/${ids.v1}`, { data: { itv_proxima: '2027-03-05' } });
  const inR = await admin.call('GET', '/apps/vehiculos/records?date_field=itv_proxima&from=2027-03-01&to=2027-03-31');
  assert.deepEqual(inR.body.rows.map((r) => r.id), [ids.v1]);
  const outR = await admin.call('GET', '/apps/vehiculos/records?date_field=itv_proxima&from=2027-04-01&to=2027-04-30');
  assert.equal(outR.body.total, 0);
  assert.equal((await admin.call('GET', '/apps/vehiculos/records?date_field=marca')).status, 400);
});

test('copia de seguridad y restauración', async () => {
  const b = await admin.call('POST', '/admin/backups');
  assert.equal(b.status, 201); assert.match(b.body.name, /_manual\.json\.gz$/);
  const before = (await admin.call('GET', '/apps/vehiculos/records')).body.total;
  // cambio posterior a la copia: se perderá al restaurar
  await admin.call('POST', '/apps/vehiculos/records', { center_id: ids.c1, data: { matricula: 'TRAS-COPIA' } });
  const file = await admin.call('GET', `/admin/backups/${b.body.name}`);
  assert.equal(file.status, 200); assert.equal(file.body[0], 0x1f, 'gzip');
  const r = await admin.call('POST', `/admin/backups/${b.body.name}/restore`);
  assert.equal(r.status, 200); assert.match(r.body.safety, /antes-restaurar/);
  assert.equal((await admin.call('GET', '/me')).status, 401, 'la restauración cierra las sesiones');
  await admin.login('admin@erp.local', 'superadmin123');
  const after = await admin.call('GET', '/apps/vehiculos/records');
  assert.equal(after.body.total, before);
  assert.ok(!after.body.rows.some((x) => x.data.matricula === 'TRAS-COPIA'));
  const pw = await admin.call('GET', `/apps/vehiculos/records/${ids.v1}/password/pin_tarjeta`);
  assert.equal(pw.body.value, '9876', 'las contraseñas siguen descifrándose');
  const list = await admin.call('GET', '/admin/backups');
  assert.ok(list.body.list.some((x) => x.kind === 'antes-restaurar'));
  // subir un archivo de otra instalación (otra APP_SECRET): avisa y solo restaura con force
  const zlib = require('zlib');
  const doc = JSON.parse(zlib.gunzipSync(file.body)); doc.canary = 'enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const fd = new FormData(); fd.append('file', new Blob([zlib.gzipSync(JSON.stringify(doc))]), 'otra.json.gz');
  const up = await admin.call('POST', '/admin/backups-upload?restore=1', undefined, { form: fd });
  assert.equal(up.status, 409); assert.equal(up.body.code, 'secret_mismatch');
  const bad = new FormData(); bad.append('file', new Blob(['hola']), 'x.json.gz');
  assert.equal((await admin.call('POST', '/admin/backups-upload', undefined, { form: bad })).status, 400);
  assert.equal((await admin.call('GET', '/admin/backups/..%2F..%2Fetc%2Fpasswd')).status, 400);
});

test('cada usuario solo ve los centros que tiene asignados', async () => {
  const ana = client(); await ana.login('ana@test.com', 'anapass123');
  const m = await ana.call('GET', '/apps/vehiculos');
  assert.deepEqual(m.body.centers.map((c) => c.id), [ids.c1]);
  assert.equal(m.body.can_view_without_center, false);
  const me = await ana.call('GET', '/me');
  const cs = await ana.call('GET', `/companies/${me.body.company_id}/centers`);
  assert.deepEqual(cs.body.map((c) => c.id), [ids.c1]);
  // el super admin ve todos
  const all = await admin.call('GET', '/apps/vehiculos');
  assert.ok(all.body.centers.length >= 2 && all.body.can_view_without_center);
  // importar en un centro no asignado: "no encontrado"
  const fd = new FormData(); fd.append('file', new Blob(['Matrícula;Centro\nIMP-C2;CC02\n'], { type: 'text/csv' }), 'c.csv');
  const p = await ana.call('POST', '/apps/vehiculos/import/preview', undefined, { form: fd });
  if (p.status === 200) {
    const r = await ana.call('POST', '/apps/vehiculos/import/commit', { token: p.body.token, mapping: p.body.mapping, dry_run: true });
    assert.match(r.body.errors[0], /no encontrado/);
  } else assert.equal(p.status, 403); // el rol Editor no importa
});

test('vista calendario configurable por aplicación (por defecto solo en Recados)', async () => {
  const apps = (await admin.call('GET', '/admin/apps')).body;
  assert.deepEqual(apps.filter((a) => a.calendar).map((a) => a.key), ['recados']);
  const veh = apps.find((a) => a.key === 'vehiculos');
  await admin.call('PUT', `/admin/apps/${veh.id}`, { calendar: true });
  assert.equal((await admin.call('GET', '/apps/vehiculos')).body.app.calendar, 1);
  await admin.call('PUT', `/admin/apps/${veh.id}`, { calendar: false });
  assert.equal((await admin.call('GET', '/apps/vehiculos')).body.app.calendar, 0);
});

test('centros: cuenta corriente (IBAN) como campo dinámico validado', async () => {
  const fields = (await admin.call('GET', '/admin/entity-fields/centers')).body;
  assert.ok(fields.some((f) => f.key === 'iban' && f.type === 'iban'), 'la migración crea el campo IBAN');
  const ok = await admin.call('PUT', `/admin/centers/${ids.c1}`, { extra: { iban: 'es91 2100 0418 4502 0005 1332' } });
  assert.equal(ok.status, 200); assert.equal(ok.body.extra.iban, 'ES9121000418450200051332');
  const bad = await admin.call('PUT', `/admin/centers/${ids.c1}`, { extra: { iban: 'ES91 2100 0418 4502 0005 1333' } });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /dígitos de control/);
  // editar otro dato no borra el IBAN
  await admin.call('PUT', `/admin/centers/${ids.c1}`, { notes: 'nota' });
  const list = (await admin.call('GET', '/admin/centers')).body;
  assert.equal(list.find((c) => c.id === ids.c1).extra.iban, 'ES9121000418450200051332');
  const h = await admin.call('GET', `/admin/audit?entity=centers`);
  assert.ok(h.body.rows.some((r) => r.changes.some((c) => c.field === 'iban')), 'el cambio queda en la auditoría');
});

test('campos dinámicos de centros y empresas desde super admin', async () => {
  const f = await admin.call('POST', '/admin/entity-fields/centers', { label: 'Responsable del centro', type: 'text', required: true });
  assert.equal(f.status, 201); assert.equal(f.body.key, 'responsable_del_centro');
  const tel = await admin.call('POST', '/admin/entity-fields/companies', { label: 'Banco', type: 'select', choices: 'Santander\nBBVA\nCaixaBank' });
  assert.equal(tel.status, 201);
  // obligatorio
  const miss = await admin.call('PUT', `/admin/centers/${ids.c2}`, { extra: {} });
  assert.equal(miss.status, 400); assert.match(miss.body.error, /Responsable del centro: obligatorio/);
  const ok = await admin.call('PUT', `/admin/centers/${ids.c2}`, { extra: { responsable_del_centro: 'Marta' } });
  assert.equal(ok.body.extra.responsable_del_centro, 'Marta');
  const c = await admin.call('PUT', `/admin/companies/${ids.company}`, { extra: { banco: 'bbva' } });
  assert.equal(c.body.extra.banco, 'BBVA');
  assert.equal((await admin.call('PUT', `/admin/companies/${ids.company}`, { extra: { banco: 'Otro' } })).status, 400);
  // claves reservadas y contraseñas no permitidas
  assert.equal((await admin.call('POST', '/admin/entity-fields/centers', { label: 'Clave', type: 'password' })).status, 400);
  const r = await admin.call('POST', '/admin/entity-fields/centers', { label: 'Name', type: 'text' });
  assert.notEqual(r.body.key, 'name');
  assert.equal((await admin.call('GET', '/admin/entity-fields/usuarios')).status, 404);
  // desactivar el obligatorio para no afectar a otras pruebas
  await admin.call('PUT', `/admin/entity-fields/centers/${f.body.id}`, { active: false });
  assert.equal((await admin.call('PUT', `/admin/centers/${ids.c2}`, { name: 'Centro Norte' })).status, 200);
});

test('ancho de campo (6 tamaños) y máximo de caracteres', async () => {
  const apps = (await admin.call('GET', '/admin/apps')).body;
  const veh = apps.find((a) => a.key === 'vehiculos');
  assert.ok(veh.fields.every((f) => ['xs', 'sm', 'md', 'lg', 'xl', 'full'].includes(f.width)), 'los anchos antiguos se convierten');
  const mat = veh.fields.find((f) => f.key === 'matricula');
  assert.equal((await admin.call('PUT', `/admin/fields/${mat.id}`, { width: 'xs', max_length: 8 })).status, 200);
  const upd = (await admin.call('GET', '/admin/apps')).body.find((a) => a.key === 'vehiculos').fields.find((f) => f.key === 'matricula');
  assert.deepEqual([upd.width, upd.max_length], ['xs', 8]);
  const long = await admin.call('POST', '/apps/vehiculos/records', { center_id: ids.c1, data: { matricula: '123456789' } });
  assert.equal(long.status, 400); assert.match(long.body.error, /máximo 8 caracteres/);
  assert.equal((await admin.call('POST', '/apps/vehiculos/records', { center_id: ids.c1, data: { matricula: 'MAX8-OK' } })).status, 201);
  // valores antiguos se aceptan y se traducen; valores raros caen en «md»; límite inválido da error
  await admin.call('PUT', `/admin/fields/${mat.id}`, { width: 'half', max_length: '' });
  let f2 = (await admin.call('GET', '/admin/apps')).body.find((a) => a.key === 'vehiculos').fields.find((f) => f.key === 'matricula');
  assert.deepEqual([f2.width, f2.max_length], ['md', null]);
  assert.equal((await admin.call('PUT', `/admin/fields/${mat.id}`, { max_length: -3 })).status, 400);
  const pin = veh.fields.find((f) => f.key === 'pin_tarjeta');
  await admin.call('PUT', `/admin/fields/${pin.id}`, { max_length: 4 });
  assert.equal((await admin.call('PUT', `/apps/vehiculos/records/${ids.v1}`, { data: { pin_tarjeta: '123456' } })).status, 400, 'también en contraseñas');
  await admin.call('PUT', `/admin/fields/${pin.id}`, { max_length: '' });
});

test('tipo de campo Dirección IP: validación, normalización y orden', async () => {
  const apps = (await admin.call('GET', '/admin/apps')).body;
  const fib = apps.find((a) => a.key === 'fibras');
  assert.equal(fib.fields.find((f) => f.key === 'ip_fija').type, 'ip', 'IP fija de Fibras usa el tipo IP');
  const mk = (ip) => admin.call('POST', '/apps/fibras/records', { center_id: ids.c1, data: { ubicacion: 'Sede ' + ip, ip_fija: ip } });
  const a = await mk('192.168.001.010'); assert.equal(a.status, 201); assert.equal(a.body.data.ip_fija, '192.168.1.10');
  assert.equal((await mk('10.0.0.0/24')).body.data.ip_fija, '10.0.0.0/24');
  assert.equal((await mk('192.168.1.2')).status, 201);
  assert.equal((await mk('FE80::1')).body.data.ip_fija, 'fe80::1');
  for (const bad of ['192.168.1.256', '192.168.1', '1.2.3.4/33', 'abc', '1.2.3.4.5']) {
    const r = await mk(bad); assert.equal(r.status, 400, bad); assert.match(r.body.error, /IP no válida/);
  }
  const asc = await admin.call('GET', '/apps/fibras/records?sort=ip_fija&dir=asc');
  const ips = asc.body.rows.map((r) => r.data.ip_fija);
  assert.deepEqual(ips.slice(0, 3), ['10.0.0.0/24', '192.168.1.2', '192.168.1.10'], 'orden numérico, no alfabético');
});

test('diseñador de formularios: secciones, orden, anchos y pestañas', async () => {
  const apps = (await admin.call('GET', '/admin/apps')).body;
  const veh = apps.find((a) => a.key === 'vehiculos');
  const r = await admin.call('PUT', `/admin/apps/${veh.id}/design`, {
    items: ['matricula', 'marca', { section: '  Seguro  ' }, 'seguro_compania', 'seguro_poliza', 'no_existe', 'marca', { section: '' }, 'itv_proxima'],
    widths: { matricula: 'sm', seguro_poliza: 'lg', marca: 'enorme' }, tabs: true,
  });
  assert.equal(r.status, 200);
  const after = (await admin.call('GET', '/admin/apps')).body.find((a) => a.key === 'vehiculos');
  const layout = JSON.parse(after.form_layout);
  assert.deepEqual(layout, { tabs: true, items: ['matricula', 'marca', { section: 'Seguro' }, 'seguro_compania', 'seguro_poliza', { section: 'Sección' }, 'itv_proxima'], label_size: null, input_size: null },
    'limpia claves desconocidas, duplicados y títulos vacíos');
  const f = Object.fromEntries(after.fields.map((x) => [x.key, x]));
  assert.equal(f.matricula.width, 'sm'); assert.equal(f.seguro_poliza.width, 'lg'); assert.notEqual(f.marca.width, 'enorme');
  assert.ok(f.matricula.sort < f.seguro_compania.sort && f.seguro_compania.sort < f.itv_proxima.sort, 'el orden del diseño se guarda');
  assert.equal((await admin.call('GET', '/apps/vehiculos')).body.app.form_layout, after.form_layout, 'el formulario recibe el diseño');
  const ana = client(); await ana.login('ana@test.com', 'anapass123');
  assert.equal((await ana.call('PUT', `/admin/apps/${veh.id}/design`, { items: [] })).status, 403, 'solo super admin');
});

test('diseñador: altura en filas solo para texto largo y selección múltiple', async () => {
  const apps = (await admin.call('GET', '/admin/apps')).body;
  const cred = apps.find((a) => a.key === 'credenciales');
  const items = cred.fields.map((f) => f.key);
  const r = await admin.call('PUT', `/admin/apps/${cred.id}/design`, { items, widths: { notas: 'md' }, heights: { notas: 3, servicio: 4, usuario: 99 } });
  assert.equal(r.status, 200);
  const f = Object.fromEntries((await admin.call('GET', '/admin/apps')).body.find((a) => a.key === 'credenciales').fields.map((x) => [x.key, x]));
  assert.deepEqual([f.notas.height, f.notas.width], [3, 'md'], 'texto largo admite altura');
  assert.equal(f.servicio.height, 1, 'un campo de una línea no cambia de altura');
  await admin.call('PUT', `/admin/apps/${cred.id}/design`, { items, heights: { notas: 99 } });
  const n = (await admin.call('GET', '/admin/apps')).body.find((a) => a.key === 'credenciales').fields.find((x) => x.key === 'notas');
  assert.equal(n.height, 8, 'máximo 8 filas');
});

test('número de trabajo por app: empieza en 1000, se busca y no se reutiliza', async () => {
  const mk = (t) => admin.call('POST', '/apps/recados/records', { center_id: ids.c1, data: { titulo: t } });
  const a = await mk('Parte A'), b = await mk('Parte B');
  assert.equal(a.body.number, 1000); assert.equal(b.body.number, 1001);
  const v = await admin.call('POST', '/apps/vehiculos/records', { center_id: ids.c1, data: { matricula: 'NUM-1' } });
  assert.ok(v.body.number >= 1000, 'cada app tiene su propia numeración');
  const s = await admin.call('GET', '/apps/recados/records?q=1001');
  assert.deepEqual(s.body.rows.map((r) => r.number), [1001], 'búsqueda por número');
  // borrar definitivamente el último no hace que se reutilice su número
  await admin.call('DELETE', `/apps/recados/records/${b.body.id}`);
  await admin.call('DELETE', `/apps/recados/records/${b.body.id}/purge`);
  assert.equal((await mk('Parte C')).body.number, 1002);
  // cambiar el inicio de numeración
  const rec = (await admin.call('GET', '/admin/apps')).body.find((x) => x.key === 'recados');
  await admin.call('PUT', `/admin/apps/${rec.id}`, { number_start: 5000 });
  assert.equal((await mk('Parte D')).body.number, 5000);
  const csv = (await admin.call('GET', '/apps/recados/export?format=csv')).body.toString('utf8');
  assert.match(csv, /\n5000;/, 'la exportación lleva el Nº');
});

test('campo Firma: se guarda la imagen y la fecha, no se reenvía en listados ni en la auditoría', async () => {
  const rec = (await admin.call('GET', '/admin/apps')).body.find((x) => x.key === 'recados');
  await admin.call('POST', `/admin/apps/${rec.id}/fields`, { label: 'Firma del cliente', type: 'signature' });
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const r = await admin.call('POST', '/apps/recados/records', { center_id: ids.c1, data: { titulo: 'Firmado', firma_del_cliente: png } });
  assert.equal(r.status, 201); assert.equal(r.body.data.firma_del_cliente.img, png); assert.ok(r.body.data.firma_del_cliente.at);
  const at = r.body.data.firma_del_cliente.at;
  // editar otro campo enviando la misma firma conserva la fecha original
  const u = await admin.call('PUT', `/apps/recados/records/${r.body.id}`, { data: { titulo: 'Firmado 2', firma_del_cliente: png } });
  assert.equal(u.body.data.firma_del_cliente.at, at);
  const list = await admin.call('GET', `/apps/recados/records?q=${r.body.number}`);
  assert.deepEqual(list.body.rows[0].data.firma_del_cliente, { signed: true, at }, 'el listado no lleva la imagen');
  const hist = await admin.call('GET', `/apps/recados/records/${r.body.id}/history`);
  assert.ok(!JSON.stringify(hist.body).includes('base64'), 'la auditoría no guarda la imagen');
  assert.equal((await admin.call('POST', '/apps/recados/records', { center_id: ids.c1, data: { titulo: 'X', firma_del_cliente: 'data:text/html,<b>' } })).status, 400);
});

test('campo Imagen: varias fotos, se sirven con permisos, se quitan y se borran con el registro', async () => {
  const veh = (await admin.call('GET', '/admin/apps')).body.find((x) => x.key === 'vehiculos');
  const f = await admin.call('POST', `/admin/apps/${veh.id}/fields`, { label: 'Fotos', type: 'image', multiple: true });
  assert.equal(f.status, 201);
  const fld = (await admin.call('GET', '/admin/apps')).body.find((x) => x.key === 'vehiculos').fields.find((x) => x.key === 'fotos');
  assert.equal(fld.options.multiple, true);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const r = await admin.call('POST', '/apps/vehiculos/records', { center_id: ids.c1, data: { matricula: 'FOTO-1', fotos: [{ data: png, name: 'a.png' }, { data: png, name: 'b.png' }] } });
  assert.equal(r.status, 201);
  const imgs = r.body.data.fotos; assert.equal(imgs.length, 2); assert.ok(imgs[0].id && !imgs[0].b64);
  const file = await admin.call('GET', `/apps/vehiculos/records/${r.body.id}/files/${imgs[0].id}`);
  assert.equal(file.status, 200); assert.equal(file.body.subarray(1, 4).toString(), 'PNG');
  const list = await admin.call('GET', `/apps/vehiculos/records?q=FOTO-1`);
  assert.deepEqual(list.body.rows[0].data.fotos, { count: 2 }, 'el listado no lleva las imágenes');
  // el usuario del otro centro no puede verlas
  const ana = client(); await ana.login('ana@test.com', 'anapass123');
  await admin.call('PUT', `/apps/vehiculos/records/${r.body.id}`, { center_id: ids.c2 });
  assert.equal((await ana.call('GET', `/apps/vehiculos/records/${r.body.id}/files/${imgs[0].id}`)).status, 403);
  // quitar una imagen la borra
  const u = await admin.call('PUT', `/apps/vehiculos/records/${r.body.id}`, { data: { fotos: [{ id: imgs[1].id }] } });
  assert.deepEqual(u.body.data.fotos.map((x) => x.id), [imgs[1].id]);
  assert.equal((await admin.call('GET', `/apps/vehiculos/records/${r.body.id}/files/${imgs[0].id}`)).status, 404);
  assert.equal((await admin.call('POST', '/apps/vehiculos/records', { center_id: ids.c1, data: { matricula: 'FOTO-2', fotos: [{ data: 'data:text/html;base64,PGI+' }] } })).status, 400);
  const h = await admin.call('GET', `/apps/vehiculos/records/${r.body.id}/history`);
  assert.ok(!JSON.stringify(h.body).includes('iVBOR'), 'la auditoría no guarda la imagen');
  await admin.call('DELETE', `/apps/vehiculos/records/${r.body.id}`);
  await admin.call('DELETE', `/apps/vehiculos/records/${r.body.id}/purge`);
  const { get } = db; assert.equal((await get('SELECT COUNT(*) n FROM record_files WHERE record_id = ?', r.body.id)).n, 0);
  await admin.call('PUT', `/admin/fields/${fld.id}`, { active: false });
});

test('botones de acción en el diseño: validación y acción de correo', async () => {
  const apps = (await admin.call('GET', '/admin/apps')).body;
  const rec = apps.find((a) => a.key === 'recados');
  const items = rec.fields.map((f) => f.key);
  const ok = await admin.call('PUT', `/admin/apps/${rec.id}/design`, { items: [
    { button: { id: 'hecho01', label: '✔ Marcar hecho', action: 'set_fields', color: 'ok', sets: [{ field: 'estado', value: 'Hecho' }, { field: 'fecha_realizado', value: '{hoy}' }, { field: 'no_existe', value: 'x' }], save: true,
      condition: { field: 'estado', op: 'ne', value: 'Hecho' } } },
    { button: { id: 'mapa01', label: 'Mapa', action: 'open_url', url: 'https://maps.google.com/?q={titulo}' } },
    { button: { id: 'mail01', label: 'Enviar', action: 'email', to_fixed: 'jefe@empresa.com', subject: 'Parte {numero}', body: 'Trabajo {titulo} en {centro}' } },
    ...items] });
  assert.equal(ok.status, 200);
  const layout = JSON.parse((await admin.call('GET', '/apps/recados')).body.app.form_layout);
  const btns = layout.items.filter((x) => x.button).map((x) => x.button);
  assert.deepEqual(btns.map((b) => b.id), ['hecho01', 'mapa01', 'mail01']);
  assert.deepEqual(btns[0].sets.map((s) => s.field), ['estado', 'fecha_realizado'], 'descarta campos inexistentes');
  // enlaces peligrosos y botones mal configurados se rechazan
  const bad = (button) => admin.call('PUT', `/admin/apps/${rec.id}/design`, { items: [{ button }, ...items] });
  assert.equal((await bad({ label: 'X', action: 'open_url', url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await bad({ label: 'X', action: 'email', to_fixed: 'no-es-email' })).status, 400);
  assert.equal((await bad({ label: 'X', action: 'set_fields', sets: [] })).status, 400);
  // acción de correo: sin SMTP configurado avisa; un botón que no es de correo no envía nada
  const r = await admin.call('POST', '/apps/recados/records', { center_id: ids.c1, data: { titulo: 'Con botón' } });
  const mail = await admin.call('POST', `/apps/recados/records/${r.body.id}/action/mail01`);
  assert.equal(mail.status, 400); assert.match(mail.body.error, /SMTP/);
  assert.equal((await admin.call('POST', `/apps/recados/records/${r.body.id}/action/mapa01`)).status, 404);
  // vuelve a dejar el diseño sin botones para el resto de pruebas
  await admin.call('PUT', `/admin/apps/${rec.id}/design`, { items });
});

test('botón de correo: envía el parte en PDF como adjunto (SMTP de pruebas)', async () => {
  const { SMTPServer } = require('smtp-server');
  const { simpleParser } = require('mailparser');
  const received = [];
  const smtp = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS'], onData(stream, s, cb) { simpleParser(stream).then((m) => { received.push(m); cb(); }, cb); } });
  await new Promise((ok) => smtp.listen(0, '127.0.0.1', ok));
  try {
    await admin.call('PUT', '/admin/settings', { smtp_host: '127.0.0.1', smtp_port: String(smtp.server.address().port), smtp_user: '', smtp_from: 'partes@test.com', smtp_secure: '0' });
    const apps = (await admin.call('GET', '/admin/apps')).body;
    const rec = apps.find((a) => a.key === 'recados');
    const items = rec.fields.map((f) => f.key);
    await admin.call('PUT', `/admin/apps/${rec.id}/design`, { items: [...items,
      { button: { id: 'mailpdf1', label: 'Enviar parte', action: 'email', to_fixed: 'cliente@test.com', subject: 'Parte Nº {numero}', body: 'Adjunto el parte {titulo}', attach_pdf: true } }] });
    const r = await admin.call('POST', '/apps/recados/records', { center_id: ids.c1, data: { titulo: 'Parte con PDF' } });
    const pdf = Buffer.from('%PDF-1.4\n% prueba\n%%EOF').toString('base64');
    const s = await admin.call('POST', `/apps/recados/records/${r.body.id}/action/mailpdf1`, { pdf });
    assert.equal(s.status, 200);
    await new Promise((ok) => setTimeout(ok, 300));
    const m = received.pop();
    assert.equal(m.subject, `Parte Nº ${r.body.number}`);
    assert.match(m.text, /Adjunto el parte Parte con PDF/);
    assert.equal(m.attachments.length, 1);
    assert.equal(m.attachments[0].filename, `Recados_${r.body.number}.pdf`);
    assert.equal(m.attachments[0].contentType, 'application/pdf');
    // un adjunto que no es PDF se rechaza
    const bad = await admin.call('POST', `/apps/recados/records/${r.body.id}/action/mailpdf1`, { pdf: Buffer.from('<html>').toString('base64') });
    assert.equal(bad.status, 400);
    const h = await admin.call('GET', `/apps/recados/records/${r.body.id}/history`);
    assert.ok(h.body.some((x) => x.action === 'email' && /PDF/.test(x.summary)), 'queda en el historial');
    await admin.call('PUT', `/admin/apps/${rec.id}/design`, { items });
  } finally {
    await admin.call('PUT', '/admin/settings', { smtp_host: '' });
    await new Promise((ok) => smtp.close(ok));
  }
});

test('revisión: búsqueda sin falsos positivos, abiertos/cerrados, míos, usuarios por empresa y permisos de correo', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const me = (await admin.call('GET', '/me')).body;
  const a = await admin.call('POST', '/apps/recados/records', { center_id: ids.c1, data: { titulo: 'Revisión A', estado: 'Pendiente', asignado_a: me.id, firma_del_cliente: png } });
  const b = await admin.call('POST', '/apps/recados/records', { center_id: ids.c1, data: { titulo: 'Revisión B', estado: 'Hecho' } });
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  // la búsqueda no entra en la firma (base64) ni en contraseñas cifradas
  assert.equal((await admin.call('GET', '/apps/recados/records?q=iVBORw0KGgo')).body.total, 0);
  assert.equal((await admin.call('GET', '/apps/vehiculos/records?q=enc:v1')).body.total, 0);
  // se puede buscar por el nombre del usuario asignado
  assert.ok((await admin.call('GET', '/apps/recados/records?q=Administrador')).body.rows.some((r) => r.id === a.body.id));
  // abiertos / cerrados / míos
  const open = (await admin.call('GET', '/apps/recados/records?state=open&size=500')).body.rows.map((r) => r.id);
  const closed = (await admin.call('GET', '/apps/recados/records?state=closed&size=500')).body.rows.map((r) => r.id);
  assert.ok(open.includes(a.body.id) && !open.includes(b.body.id));
  assert.ok(closed.includes(b.body.id) && !closed.includes(a.body.id));
  const mine = (await admin.call('GET', '/apps/recados/records?mine=1&size=500')).body.rows.map((r) => r.id);
  assert.ok(mine.includes(a.body.id) && !mine.includes(b.body.id));
  // resumen del inicio
  const rec = (await admin.call('GET', '/apps')).body.find((x) => x.key === 'recados');
  assert.ok(rec.stats.open >= 1 && rec.stats.mine >= 1 && 'overdue' in rec.stats);
  // usuarios de otra empresa no aparecen en los desplegables
  const other = await admin.call('POST', '/admin/companies', { name: 'Otra Empresa' });
  const roles = (await admin.call('GET', '/admin/roles')).body.roles;
  await admin.call('POST', '/admin/users', { name: 'Ajeno', email: 'ajeno@otra.com', password: 'ajenopass1', assignments: [{ company_id: other.body.id, role_id: roles[0].id }] });
  const meta = await admin.call('GET', '/apps/recados', undefined, { company: ids.company });
  assert.ok(!meta.body.users.some((u) => u.email === 'ajeno@otra.com'));
  // configuración de estado validada
  assert.equal((await admin.call('PUT', `/admin/apps/${rec.id}`, { status_field: 'titulo' })).status, 400);
  // enviar por correo requiere exportar: Ana (Editor) sí; un rol de consulta no
  const items = (await admin.call('GET', '/admin/apps')).body.find((x) => x.key === 'recados').fields.map((f) => f.key);
  await admin.call('PUT', `/admin/apps/${rec.id}/design`, { items: [...items, { button: { id: 'mailrev1', label: 'Enviar', action: 'email', to_fixed: 'x@test.com' } }] });
  const consulta = roles.find((r) => r.name === 'Consulta');
  await admin.call('POST', '/admin/users', { name: 'Solo Ver', email: 'ver@test.com', password: 'verpass123', assignments: [{ company_id: ids.company, role_id: consulta.id }] });
  const ver = client(); await ver.login('ver@test.com', 'verpass123');
  assert.equal((await ver.call('POST', `/apps/recados/records/${a.body.id}/action/mailrev1`)).status, 403);
  // con el permiso «Enviar por correo» en su rol, sí puede (aunque no tenga «Exportar»)
  const recApp = (await admin.call('GET', '/admin/apps')).body.find((x) => x.key === 'recados');
  const perms = consulta.permissions.map((p) => (p.app_id === recApp.id ? { ...p, can_email: 1 } : p));
  await admin.call('PUT', `/admin/roles/${consulta.id}`, { permissions: perms });
  const r2 = await ver.call('POST', `/apps/recados/records/${a.body.id}/action/mailrev1`);
  assert.notEqual(r2.status, 403, 'ya no es un problema de permisos');
  await admin.call('PUT', `/admin/roles/${consulta.id}`, { permissions: consulta.permissions });
  await admin.call('PUT', `/admin/apps/${rec.id}/design`, { items });
});

test('revisión: los registros de un usuario desactivado siguen mostrando su nombre', async () => {
  const roles = (await admin.call('GET', '/admin/roles')).body.roles;
  const u = await admin.call('POST', '/admin/users', { name: 'Temporal', email: 'temp@test.com', password: 'temppass12', assignments: [{ company_id: ids.company, role_id: roles[0].id }] });
  await admin.call('POST', '/apps/recados/records', { center_id: ids.c1, data: { titulo: 'De Temporal', asignado_a: u.body.id } });
  await admin.call('PUT', `/admin/users/${u.body.id}`, { active: false });
  const meta = (await admin.call('GET', '/apps/recados')).body;
  assert.ok(!meta.users.some((x) => x.id === u.body.id), 'no se ofrece para elegir');
  assert.equal(meta.user_names[u.body.id], 'Temporal', 'pero se conoce su nombre');
});

test('modo accesible solo para los usuarios marcados como invidentes', async () => {
  const roles = (await admin.call('GET', '/admin/roles')).body.roles;
  const consulta = roles.find((r) => r.name === 'Consulta');
  const r = await admin.call('POST', '/admin/users', { name: 'Pepe', email: 'pepe@test.com', password: 'pepepass123', must_change_password: false, accessible: true,
    assignments: [{ company_id: ids.company, center_id: null, role_id: consulta.id }] });
  assert.equal(r.status, 201);
  const pepe = client();
  await pepe.login('pepe@test.com', 'pepepass123');
  assert.equal((await pepe.call('GET', '/me')).body.accessible, true);
  const ul = await admin.call('GET', '/admin/users');
  assert.equal(ul.status, 200, JSON.stringify(ul.body));
  const u = ul.body.find((x) => x.email === 'pepe@test.com');
  assert.equal(u.accessible, 1);
  await admin.call('PUT', `/admin/users/${u.id}`, { accessible: false });
  assert.equal((await pepe.call('GET', '/me')).body.accessible, false);
  assert.equal((await admin.call('GET', '/me')).body.accessible, false, 'por defecto, desactivado');
});
