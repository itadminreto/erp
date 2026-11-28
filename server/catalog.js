'use strict';
// Listas maestras (p. ej. marcas y modelos de vehículo): valores que se eligen en los campos «Lista maestra».
// Renombrar o unificar un valor actualiza también los registros que lo usan.
const { all, get, run } = require('./db');

/** Listas conocidas. Una lista hija (modelos) cuelga de una lista padre (marcas). */
const LISTS = {
  vehiculo_marca: { label: 'Marcas de vehículo', singular: 'marca' },
  vehiculo_modelo: { label: 'Modelos de vehículo', singular: 'modelo', parent: 'vehiculo_marca' },
};
const childOf = (list) => Object.keys(LISTS).filter((k) => LISTS[k].parent === list);

/** Campos (de cualquier app) que usan la lista: { app_id, key, depends_on }. */
async function fieldsUsing(list) {
  const rows = await all("SELECT app_id, `key`, options FROM fields WHERE type = 'lookup' AND active = 1");
  return rows.map((r) => { let o = {}; try { o = JSON.parse(r.options || '{}'); } catch { /* nada */ } return { app_id: r.app_id, key: r.key, list: o.list, depends_on: o.depends_on || '' }; })
    .filter((f) => f.list === list);
}

/** Valores de la lista con cuántos registros los usan. */
async function listValues(list) {
  const items = await all('SELECT id, value, parent, active FROM catalog WHERE list_key = ? ORDER BY parent, value', list);
  const uses = {};
  for (const f of await fieldsUsing(list)) {
    const rows = await all(`SELECT JSON_VALUE(data, '$.${f.key}') v, ${f.depends_on ? `JSON_VALUE(data, '$.${f.depends_on}')` : "''"} p, COUNT(*) n
      FROM records WHERE app_id = ? AND deleted_at IS NULL AND COALESCE(JSON_VALUE(data, '$.${f.key}'), '') <> '' GROUP BY v, p`, f.app_id);
    for (const r of rows) { const k = `${String(r.p || '').toLowerCase()}|${String(r.v).toLowerCase()}`; uses[k] = (uses[k] || 0) + Number(r.n); }
  }
  return { items: items.map((i) => ({ ...i, uses: uses[`${i.parent.toLowerCase()}|${i.value.toLowerCase()}`] || 0 })), uses };
}

/** Valores usados en los registros que no están en la lista (p. ej. marcas mal escritas del programa antiguo). */
async function unknownValues(list) {
  const { items, uses } = await listValues(list);
  const known = new Map(items.map((i) => [`${i.parent.toLowerCase()}|${i.value.toLowerCase()}`, i]));
  // con otras tildes o mayúsculas también es conocido (se arregla con «Corregir mayúsculas»)
  const knownPlain = new Set(items.map((i) => `${plain(i.parent)}|${plain(i.value)}`));
  const out = [];
  for (const [k, n] of Object.entries(uses)) {
    const [parent, value] = k.split('|');
    if (known.has(k) || knownPlain.has(`${plain(parent)}|${plain(value)}`)) continue;
    out.push({ parent, value, n });
  }
  // con su escritura original
  const fields = await fieldsUsing(list);
  for (const u of out) {
    for (const f of fields) {
      const r = await get(`SELECT JSON_VALUE(data, '$.${f.key}') v ${f.depends_on ? `, JSON_VALUE(data, '$.${f.depends_on}') p` : ''} FROM records
        WHERE app_id = ? AND LOWER(JSON_VALUE(data, '$.${f.key}')) = ? LIMIT 1`, f.app_id, u.value);
      if (r) { u.value = r.v; if (r.p) u.parent = r.p; break; }
    }
  }
  // sugerencia de con cuál unificarlo
  const { ALIAS } = require('./templates/marcas');
  for (const u of out) {
    const cands = items.filter((i) => !LISTS[list].parent || plain(i.parent) === plain(u.parent)).map((i) => i.value);
    u.suggest = suggestFor(u.value, cands, list === 'vehiculo_marca' ? ALIAS : {});
  }
  return out.sort((a, b) => b.n - a.n);
}

/** Cambia en los registros el valor `from` por `to` (dentro de `parent` si la lista depende de otra). */
async function replaceInRecords(list, from, to, parent = '') {
  let n = 0;
  for (const f of await fieldsUsing(list)) {
    const r = await run(`UPDATE records SET data = JSON_SET(data, '$.${f.key}', ?) WHERE app_id = ? AND JSON_VALUE(data, '$.${f.key}') = ?
      ${f.depends_on && parent !== null ? `AND COALESCE(JSON_VALUE(data, '$.${f.depends_on}'), '') = ?` : ''}`, to, f.app_id, from, ...(f.depends_on && parent !== null ? [parent] : []));
    n += Number(r.changes || 0);
  }
  return n;
}

/** Añade valores (y los de la lista hija colgando de ellos). Devuelve cuántos son nuevos. */
async function addValues(list, pairs) {
  let n = 0;
  for (const [value, parent = ''] of pairs) {
    const v = String(value || '').trim().slice(0, 150); const p = String(parent || '').trim().slice(0, 150);
    if (!v) continue;
    const r = await run('INSERT IGNORE INTO catalog (list_key, value, parent) VALUES (?,?,?)', list, v, p);
    n += Number(r.changes || 0);
  }
  return n;
}

// ---------- sugerencias para unificar valores mal escritos ----------
const plain = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
/**
 * Valor de la lista que probablemente corresponde a `value`: igual sin tildes ni signos (B.M.W. = BMW), alias conocido
 * (MERCEDES → Mercedes-Benz), «marca modelo» pegados (VOLKSWAGEN CRAFTER → Volkswagen) o error de escritura (VOLSWAGEN).
 */
function suggestFor(value, candidates, alias = {}) {
  const p = plain(value);
  if (!p) return null;
  const exact = candidates.find((c) => plain(c) === p);
  if (exact) return exact;
  if (alias[p] && candidates.includes(alias[p])) return alias[p];
  const words = String(value).trim().split(/\s+/);
  for (let n = words.length - 1; n >= 1; n--) { // quitando palabras del final (el modelo pegado)
    const q = plain(words.slice(0, n).join(' '));
    const hit = candidates.find((c) => plain(c) === q) || (alias[q] && candidates.includes(alias[q]) ? alias[q] : null);
    if (hit) return hit;
  }
  if (p.length >= 5) {
    let best = null, bestD = 99;
    for (const c of candidates) { const d = lev(p, plain(c)); if (d < bestD) { bestD = d; best = c; } }
    if (best && bestD <= (p.length >= 8 ? 3 : 2)) return best;
  }
  return null;
}

/** Unifica `from` en `to` (registros y lista). Devuelve los registros cambiados. */
async function mergeValues(list, from, to, parent = '') {
  const hasParent = !!LISTS[list].parent;
  const target = await get('SELECT * FROM catalog WHERE list_key = ? AND parent = ? AND value = ?', list, hasParent ? parent : '', to);
  if (!target) throw Object.assign(new Error(`«${to}» no está en la lista`), { status: 400 });
  let total = 0;
  for (const variant of new Set([from, String(from).toUpperCase(), String(from).toLowerCase()])) {
    total += await replaceInRecords(list, variant, target.value, hasParent ? parent : null);
  }
  const old = await get('SELECT * FROM catalog WHERE list_key = ? AND parent = ? AND value = ? AND id <> ?', list, hasParent ? parent : '', from, target.id);
  if (old) {
    for (const c of childOf(list)) {
      for (const m of await all('SELECT * FROM catalog WHERE list_key = ? AND parent = ?', c, old.value)) {
        if (await get('SELECT id FROM catalog WHERE list_key = ? AND parent = ? AND value = ?', c, target.value, m.value)) await run('DELETE FROM catalog WHERE id = ?', m.id);
        else await run('UPDATE catalog SET parent = ? WHERE id = ?', target.value, m.id);
      }
    }
    await run('DELETE FROM catalog WHERE id = ?', old.id);
  }
  return total;
}

module.exports = { LISTS, childOf, fieldsUsing, listValues, unknownValues, replaceInRecords, addValues, suggestFor, mergeValues, plain };
