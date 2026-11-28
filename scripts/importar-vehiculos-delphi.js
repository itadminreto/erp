#!/usr/bin/env node
'use strict';
/**
 * Carga del maestro de vehículos del antiguo programa (Delphi / SQL Server) en la app Vehículos.
 * Lee la exportación a Excel (hoja RET001 y sus tablas de códigos) y, por defecto, solo SIMULA:
 * informa de lo que haría sin guardar nada. Con --ejecutar guarda.
 *
 *   node scripts/importar-vehiculos-delphi.js vehiculos.xls [--empresa "Nombre o id"] [--ejecutar] [--crear-centros] [--informe fichero.csv]
 *
 * - Cada delegación (CEN) va a un centro de coste: se busca por código o nombre; con --crear-centros se crean los que falten.
 * - Matrículas repetidas: se carga una (la que está en activo o la más reciente) y las demás salen en el informe.
 * - Matrículas que ya existen en el ERP: no se tocan (salen en el informe). Se puede repetir sin duplicar.
 * - Fechas imposibles: se dejan vacías y salen en el informe.
 */
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] || '') : null; };
const flag = (name) => args.includes(name);
const file = args.find((a) => !a.startsWith('--') && !['--empresa', '--informe'].includes(args[args.indexOf(a) - 1]));
if (!file || flag('--ayuda') || flag('-h')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 15).map((l) => l.replace(/^ \*\/?\s?/, '')).join('\n'));
  process.exit(file ? 0 : 1);
}
const EXECUTE = flag('--ejecutar');
const CREATE_CENTERS = flag('--crear-centros');

// ---------- utilidades ----------
const plain = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const clean = (s) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
const SMALL = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'en', 'a']);
const title = (s) => clean(s).toLowerCase().split(' ').map((w, i) => (i && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
const plate = (s) => clean(s).toUpperCase().replace(/\s+/g, ' ');
const plateKey = (s) => String(s ?? '').toUpperCase().replace(/[\s.-]/g, '');
const num = (v) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) && n !== 0 ? n : ''; };
/** 20170301 → 2017-03-01 (o null si es imposible). */
function date(v) {
  const s = String(v ?? '').trim();
  if (!s || s === '0') return '';
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(?:\.0+)?$/);
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1950 || y > 2040 || dt.getUTCMonth() !== mo - 1) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

(async () => {
  const wb = XLSX.readFile(path.resolve(file));
  const sheet = (n) => (wb.Sheets[n] ? XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: '', raw: true }) : []);
  // tabla de códigos: primera columna = código, segunda = descripción (NOM o DES según la tabla)
  const lookup = (n) => Object.fromEntries(sheet(n).map((r) => { const v = Object.values(r); return [String(v[0]).trim(), String(v[1] ?? '').trim()]; }).filter(([k, v]) => k && v));
  const rows = sheet('RET001');
  if (!rows.length || !('MAT' in rows[0])) throw new Error('No encuentro la hoja RET001 (vehículos) en el fichero');
  const L = { cia: lookup('RET005'), del: lookup('RET006'), amb: lookup('RET008'), loc: lookup('RET010'), mot: lookup('RET011'), tipo: lookup('RET017') };

  const db = require('../server/db');
  await db.init();
  const { normalize, appFields } = require('../server/fields');
  const { audit } = require('../server/audit');
  const app = await db.get("SELECT * FROM apps WHERE `key` = 'vehiculos'");
  if (!app) throw new Error('No existe la app Vehículos: actualiza el ERP primero');
  const fields = Object.fromEntries((await appFields(app.id)).map((f) => [f.key, f]));

  // empresa
  const companies = await db.all('SELECT id, name FROM companies WHERE deleted_at IS NULL ORDER BY id');
  const want = opt('--empresa');
  const company = want ? companies.find((c) => String(c.id) === want || plain(c.name) === plain(want)) : companies.length === 1 ? companies[0] : null;
  if (!company) throw new Error(`Indica la empresa con --empresa. Empresas: ${companies.map((c) => `${c.id} = ${c.name}`).join(' · ')}`);
  const admin = await db.get('SELECT id, name FROM users WHERE is_superadmin = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1');

  // equivalencias de las listas (código Delphi → opción del ERP)
  const FIX = { mafre: 'Mapfre', wintertur: 'Winterthur', plusultraseguressa: 'Plus Ultra', plusultrasegurossa: 'Plus Ultra', compraventa: 'Compra-venta' };
  // nombres con tilde o recortados en el programa antiguo
  const NAMES = { norueg: 'Noruega', cacere: 'Cáceres', caceres: 'Cáceres', cadiz: 'Cádiz', castellon: 'Castellón', leon: 'León', cordoba: 'Córdoba',
    lerida: 'Lérida', merida: 'Mérida', malaga: 'Málaga', aviles: 'Avilés', gijon: 'Gijón', logrono: 'Logroño', coruna: 'Coruña', alicante: 'Alicante',
    santiago: 'Santiago', grecia: 'Grecia', chipre: 'Chipre', rusia: 'Rusia', polonia: 'Polonia' };
  const pretty = (v) => NAMES[plain(v)] || (v.length <= 3 ? v.toUpperCase() : title(v));
  const newChoices = {};
  const choice = (fkey, raw) => {
    const v = clean(raw);
    if (!v) return '';
    const ch = (fields[fkey].options && fields[fkey].options.choices) || [];
    const hit = ch.find((c) => plain(c) === plain(v)) || ch.find((c) => FIX[plain(v)] === c)
      || ch.find((c) => plain(c).startsWith(plain(v)) && plain(v).length >= 5) // recortado: GRANAD → Granada
      || ch.find((c) => plain(v).startsWith(plain(c)) && plain(c).length >= 4);
    if (hit) return hit;
    const t = pretty(v);
    (newChoices[fkey] = newChoices[fkey] || new Set()).add(t);
    return t;
  };
  // marcas y modelos: a los de la lista maestra (con alias como MERCEDES → Mercedes-Benz); si no, se guardan tal cual
  const { ALIAS } = require('../server/templates/marcas');
  const { suggestFor } = require('../server/catalog');
  const brands = (await db.all("SELECT value FROM catalog WHERE list_key = 'vehiculo_marca'")).map((x) => x.value);
  const models = await db.all("SELECT value, parent FROM catalog WHERE list_key = 'vehiculo_modelo'");
  const unknownBrands = new Set(), unknownModels = new Set();
  const brandOf = (raw) => {
    const v = clean(raw); if (!v) return '';
    const hit = suggestFor(v, brands, ALIAS); // MERCEDES → Mercedes-Benz, VOLSWAGEN → Volkswagen, B.M.W. → BMW…
    if (!hit) unknownBrands.add(v);
    return hit || v;
  };
  const modelOf = (brand, raw) => {
    const v = clean(raw); if (!v) return '';
    const hit = models.find((m) => m.parent === brand && plain(m.value) === plain(v));
    if (!hit) unknownModels.add(`${brand} ${v}`);
    return hit ? hit.value : v;
  };
  const MOT = { V: 'Vendido', D: 'Definitiva', T: 'Temporal', TC: 'Tránsito comunitario', E: 'Exportación', EV: 'En venta' };
  const AMB = { DP: 'Servicio público pesado', PC: 'Servicio particular', VP: 'Viajeros particular', XP: 'XPC' };
  const TIT = { A: 'Asociación', S: 'Cooperativa', P: 'Particular' };

  // centros (delegaciones)
  const centers = await db.all('SELECT id, code, name, kind FROM centers WHERE company_id = ? AND deleted_at IS NULL', company.id);
  const centerPlan = {}; // código Delphi → { id?, code, name, create?, fixKind? }
  const centerFor = (code) => {
    code = String(code || '').trim();
    if (!code) return null;
    if (centerPlan[code]) return centerPlan[code];
    const name = pretty(L.del[code] || code);
    const c = centers.find((x) => plain(x.code) === plain(code)) || centers.find((x) => plain(x.name) === plain(name));
    centerPlan[code] = c ? { id: c.id, code: c.code, name: c.name, fixKind: app.center_kind === 'coste' && c.kind === 'trabajo' } : { code, name, create: true };
    return centerPlan[code];
  };

  // informe
  const report = [];
  const note = (row, mat, kind, msg) => report.push([row, mat, kind, msg]);

  // matrículas repetidas en el fichero: se queda la que está en activo y, si no, la más reciente
  const byPlate = new Map();
  rows.forEach((r, i) => {
    const k = plateKey(r.MAT);
    if (!k) { note(i + 2, '', 'omitida', 'sin matrícula'); return; }
    (byPlate.get(k) || byPlate.set(k, []).get(k)).push({ r, row: i + 2 });
  });
  const score = ({ r }) => [date(r.FECBAJ) ? 0 : 1, Math.max(...['FECALT', 'FECCOM', 'FECCEN', 'FECMAT'].map((k) => Number(String(r[k]).slice(0, 8)) || 0))];
  const chosen = [];
  for (const list of byPlate.values()) {
    list.sort((a, b) => { const sa = score(a), sb = score(b); return sb[0] - sa[0] || sb[1] - sa[1] || b.row - a.row; });
    chosen.push(list[0]);
    for (const d of list.slice(1)) note(d.row, plate(d.r.MAT), 'omitida', `matrícula repetida en el fichero: se carga la fila ${list[0].row}`);
  }

  // ya existentes en el ERP
  const existing = new Set((await db.all(`SELECT JSON_VALUE(data, '$.matricula') m FROM records WHERE app_id = ? AND company_id = ? AND deleted_at IS NULL`, app.id, company.id)).map((x) => plateKey(x.m)));

  // conversión fila → datos del ERP
  const out = [];
  const tooLong = [];
  for (const { r, row } of chosen) {
    const mat = plate(r.MAT);
    if (existing.has(plateKey(mat))) { note(row, mat, 'omitida', 'ya existe en el ERP (no se modifica)'); continue; }
    const d = {}; const warn = (m) => note(row, mat, 'aviso', m);
    const dt = (col, key) => { const v = date(r[col]); if (v === null) { warn(`${fields[key].label}: fecha imposible «${r[col]}» (se deja vacía)`); return; } if (v) d[key] = v; };
    const txt = (col, key) => { const v = clean(r[col]); if (v) d[key] = v; };
    d.matricula = mat;
    const marca = brandOf(r.MAR); if (marca) d.marca = marca;
    const modelo = modelOf(marca, r.MOD); if (modelo) d.modelo = modelo;
    txt('BAS', 'bastidor');
    const tit = String(r.TIT).trim();
    if (TIT[tit]) d.titular = TIT[tit]; else if (tit) warn(`titular «${tit}» sin equivalencia (se deja vacío)`);
    if (L.tipo[String(r.TIPOVE).trim()]) d.tipo = choice('tipo', L.tipo[String(r.TIPOVE).trim()]);
    dt('FECMAT', 'fecha_matriculacion'); dt('FECCOM', 'fecha_compra'); dt('FECCEN', 'fecha_asignacion'); dt('FECALT', 'fecha_alta');
    dt('FECITV', 'itv_proxima'); dt('FECBAJ', 'fecha_baja');
    const tara = num(r.TARA), pma = num(r.PMA), val = num(r.VALCOM), imp = num(r.IMP);
    if (tara) d.tara = Math.round(tara); if (pma) d.pma = Math.round(pma); if (val) d.valor_compra = val; if (imp) d.seguro_importe = imp;
    txt('PRO', 'procedencia'); txt('OBS', 'observaciones');
    const loc = String(r.LOC).trim(); if (loc) d.ubicacion = choice('ubicacion', L.loc[loc] || loc);
    const cia = String(r.CIA).trim(); if (cia) d.seguro_compania = choice('seguro_compania', L.cia[cia] || cia);
    txt('POL', 'seguro_poliza'); dt('FASEGU', 'seguro_alta'); dt('FVSEGU', 'seguro_vencimiento'); dt('FBSEGU', 'seguro_baja'); txt('MBSEGU', 'seguro_motivo_baja');
    txt('NUMTAR', 'tarjeta_transporte'); dt('FATARJ', 'tarjeta_alta'); dt('FVTARJ', 'tarjeta_vencimiento'); dt('FBTARJ', 'tarjeta_baja'); txt('MBTARJ', 'tarjeta_motivo_baja');
    const amb = String(r.AMBTAR).trim(); if (amb) d.tarjeta_ambito = choice('tarjeta_ambito', AMB[amb] || amb);
    const mot = String(r.MOTBAJ).trim(); if (mot) d.motivo_baja = choice('motivo_baja', MOT[mot] || mot);
    d.estado = d.fecha_baja ? 'Baja' : mot === 'EV' ? 'En venta' : 'Activo';
    const center = centerFor(r.CEN);
    if (!center) { note(row, mat, 'omitida', 'sin delegación'); continue; }
    // misma validación que el ERP (formatos, máximos de caracteres…); las listas admiten las opciones nuevas
    const bad = [];
    for (const [k, v] of Object.entries(d)) {
      const f = newChoices[k] ? { ...fields[k], options: { ...fields[k].options, choices: [...(fields[k].options.choices || []), ...newChoices[k]] } } : fields[k];
      try { d[k] = normalize(f, v, {}); } catch (e) { bad.push(e.message); }
    }
    if (bad.length) { note(row, mat, 'omitida', bad.join(' · ')); (bad.some((m) => /máximo/.test(m)) ? tooLong : []).push(mat); continue; }
    out.push({ row, mat, data: d, center });
  }

  // resumen
  const toCreate = Object.values(centerPlan).filter((c) => c.create);
  const toFix = Object.values(centerPlan).filter((c) => c.fixKind);
  const count = (k) => report.filter((x) => x[2] === k).length;
  const states = out.reduce((a, x) => ((a[x.data.estado] = (a[x.data.estado] || 0) + 1), a), {});
  console.log(`\nEmpresa: ${company.name}   Fichero: ${path.basename(file)}   Modo: ${EXECUTE ? 'EJECUTAR (se guarda)' : 'SIMULACIÓN (no se guarda nada)'}`);
  console.log(`Filas en el fichero: ${rows.length} · se cargan: ${out.length} (${Object.entries(states).map(([k, v]) => `${v} ${k}`).join(', ')}) · omitidas: ${count('omitida')} · avisos: ${count('aviso')}`);
  console.log(`Centros de coste: ${Object.keys(centerPlan).length} delegaciones · ya existen ${Object.values(centerPlan).filter((c) => c.id).length} · a crear ${toCreate.length}${toFix.length ? ` · a marcar como «trabajo y coste» ${toFix.length}` : ''}`);
  if (toCreate.length) console.log('  A crear: ' + toCreate.map((c) => `${c.code} ${c.name}`).join(', '));
  console.log(`Marcas: ${unknownBrands.size} no están en la lista y ${unknownModels.size} modelos tampoco: se guardan tal cual y luego se unifican en Super admin → Listas maestras.`);
  for (const [k, set] of Object.entries(newChoices)) console.log(`Opciones nuevas en «${fields[k].label}»: ${[...set].join(', ')}`);
  if (tooLong.length) console.log(`⚠ ${tooLong.length} vehículos superan el máximo de caracteres de algún campo (p. ej. ${tooLong.slice(0, 3).join(', ')}): amplíalo en Apps y campos → Vehículos o se quedarán fuera.`);
  if (toCreate.length && !CREATE_CENTERS) console.log('\n⚠ Faltan centros: añade --crear-centros para crearlos (o créalos tú con el código de la delegación) y vuelve a lanzarlo.');

  const informe = opt('--informe') || path.join(path.dirname(path.resolve(file)), `informe-vehiculos-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`);
  fs.writeFileSync(informe, '﻿' + [['Fila', 'Matrícula', 'Tipo', 'Detalle'], ...report].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n'));
  console.log(`Informe con el detalle de omitidas y avisos: ${informe}`);

  if (!EXECUTE) { console.log('\nNo se ha guardado nada. Revisa el resumen y el informe, y lánzalo con --ejecutar.\n'); await db.close(); return; }
  if (toCreate.length && !CREATE_CENTERS) { console.log('No se ha guardado nada (faltan centros).'); await db.close(); process.exitCode = 1; return; }

  const t0 = Date.now();
  await db.tx(async () => {
    const who = { user: admin || null, ip: 'migración Delphi' };
    for (const c of toCreate) {
      c.id = Number((await db.run("INSERT INTO centers (company_id, code, name, kind) VALUES (?,?,?,'coste')", company.id, c.code, c.name)).lastInsertRowid);
      await audit(who, { entity: 'centers', entityId: c.id, action: 'create', companyId: company.id, summary: `Alta: ${c.code} · ${c.name} (migración de vehículos)` });
    }
    for (const c of toFix) await db.run("UPDATE centers SET kind = 'ambos' WHERE id = ?", c.id);
    // opciones nuevas en las listas
    for (const [k, set] of Object.entries(newChoices)) {
      const o = { ...(fields[k].options || {}) }; o.choices = [...new Set([...(o.choices || []), ...set])];
      await db.run('UPDATE fields SET options = ? WHERE id = ?', JSON.stringify(o), fields[k].id);
      fields[k].options = o;
    }
    let n = 0;
    for (const x of out) {
      const data = {};
      for (const [k, v] of Object.entries(x.data)) data[k] = v; // ya validado y normalizado como el resto del ERP
      const number = await db.nextNumber(app.id, company.id);
      const id = Number((await db.run('INSERT INTO records (app_id, company_id, number, center_id, data, created_by, updated_by) VALUES (?,?,?,?,?,?,?)',
        app.id, company.id, number, x.center.id, JSON.stringify(data), admin ? admin.id : null, admin ? admin.id : null)).lastInsertRowid);
      await audit(who, { entity: 'record', entityId: id, action: 'import', appId: app.id, companyId: company.id, summary: `Alta por migración (Delphi, fila ${x.row}) · Nº ${number} · ${x.mat}` });
      if (++n % 500 === 0) console.log(`  … ${n} vehículos`);
    }
  });
  console.log(`\n✔ Guardados ${out.length} vehículos${toCreate.length ? ` y ${toCreate.length} centros de coste` : ''} en ${((Date.now() - t0) / 1000).toFixed(1)} s.\n`);
  await db.close();
})().catch(async (e) => { console.error('\n✕ ' + e.message + '\n'); try { await require('../server/db').close(); } catch { /* nada */ } process.exit(1); });
