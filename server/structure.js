'use strict';
// Estructura de una aplicación (app + campos + diseño + informes + subapartados) en un fichero JSON:
// se exporta desde una instalación y se importa en otra (o se usa para instalar plantillas como Vehículos).
// Al importar sobre una app existente NUNCA se borra nada: se añaden campos, opciones, subapartados e informes.
const { all, get, run } = require('./db');
const { FIELD_TYPES } = require('./fields');

const FORMAT = 'erp-app-structure';
const KEY_RE = /^[a-z][a-z0-9_]{0,40}$/;
const APP_PROPS = ['title_field', 'calendar', 'status_field', 'closed_values', 'owner_field', 'number_start', 'voice_fields', 'transfers', 'center_kind'];
const FIELD_PROPS = ['label', 'type', 'options', 'required', 'unique_value', 'show_in_list', 'width', 'max_length', 'height', 'help'];
const parse = (s, def) => { try { return s ? JSON.parse(s) : def; } catch { return def; } };

/** Estructura de una app (y sus subapartados) lista para guardar en un fichero. */
async function exportStructure(appId) {
  const a = await get('SELECT * FROM apps WHERE id = ?', appId);
  if (!a) throw Object.assign(new Error('Aplicación no encontrada'), { status: 404 });
  const one = async (app) => ({
    key: app.key, name: app.name, icon: app.icon, color: app.color, description: app.description || '',
    ...Object.fromEntries(APP_PROPS.map((k) => [k, k === 'closed_values' || k === 'voice_fields' ? parse(app[k], null) : app[k]])),
    form_layout: parse(app.form_layout, null),
    fields: (await all('SELECT * FROM fields WHERE app_id = ? AND active = 1 ORDER BY sort, id', app.id)).map((f) => ({
      key: f.key, ...Object.fromEntries(FIELD_PROPS.map((k) => [k, k === 'options' ? parse(f.options, {}) : f[k]])),
    })),
    reports: (await all('SELECT name, config FROM app_reports WHERE app_id = ? AND deleted_at IS NULL ORDER BY sort, name', app.id)).map((r) => ({ name: r.name, config: parse(r.config, {}) })),
  });
  const out = { format: FORMAT, version: 1, exported_at: new Date().toISOString(), app: await one(a) };
  out.app.children = [];
  for (const c of await all('SELECT * FROM apps WHERE parent_app_id = ? ORDER BY sort, name', a.id)) out.app.children.push(await one(c));
  return out;
}

/** Comprueba que el fichero tiene el formato correcto (claves, tipos) antes de tocar nada. */
function validate(tpl) {
  if (!tpl || tpl.format !== FORMAT || !tpl.app) throw Object.assign(new Error('El fichero no es una estructura de aplicación válida'), { status: 400 });
  const check = (app, where) => {
    if (!KEY_RE.test(app.key || '')) throw Object.assign(new Error(`${where}: clave de aplicación no válida`), { status: 400 });
    if (!String(app.name || '').trim()) throw Object.assign(new Error(`${where}: falta el nombre`), { status: 400 });
    for (const f of app.fields || []) {
      if (!KEY_RE.test(f.key || '')) throw Object.assign(new Error(`${app.name}: clave de campo no válida «${f.key}»`), { status: 400 });
      if (!FIELD_TYPES[f.type]) throw Object.assign(new Error(`${app.name}: tipo de campo no válido «${f.type}»`), { status: 400 });
    }
  };
  check(tpl.app, 'Aplicación');
  for (const c of tpl.app.children || []) check(c, 'Subapartado');
}

/**
 * Crea o completa una app según la estructura. Devuelve un resumen de lo hecho.
 * `forceLayout`: aplica el diseño del fichero aunque la app ya tenga uno con secciones.
 */
async function importStructure(tpl, { forceLayout = false } = {}) {
  validate(tpl);
  const summary = { apps_created: [], apps_updated: [], fields_added: 0, fields_changed: 0, reports_added: 0 };
  const one = async (t, parentId = null) => {
    let app = await get('SELECT * FROM apps WHERE `key` = ?', t.key);
    if (!app) {
      const sort = ((await get('SELECT MAX(sort) m FROM apps')).m ?? -1) + 1;
      const id = Number((await run('INSERT INTO apps (`key`, name, icon, color, description, sort, parent_app_id) VALUES (?,?,?,?,?,?,?)',
        t.key, String(t.name).slice(0, 100), t.icon || '📁', t.color || '#64748b', t.description || '', sort, parentId)).lastInsertRowid);
      app = await get('SELECT * FROM apps WHERE id = ?', id);
      summary.apps_created.push(t.name);
    } else {
      summary.apps_updated.push(app.name);
      if (parentId && app.parent_app_id !== parentId) await run('UPDATE apps SET parent_app_id = ? WHERE id = ?', parentId, app.id);
    }
    // campos: se añaden los que faltan; en los existentes se suman opciones (y texto → lista si el fichero lo pide)
    const cur = Object.fromEntries((await all('SELECT * FROM fields WHERE app_id = ?', app.id)).map((f) => [f.key, f]));
    let sort = ((await get('SELECT MAX(sort) m FROM fields WHERE app_id = ?', app.id)).m ?? -1) + 1;
    for (const f of t.fields || []) {
      const opts = f.options && typeof f.options === 'object' ? f.options : {};
      const ex = cur[f.key];
      if (!ex) {
        await run(`INSERT INTO fields (app_id, \`key\`, label, type, options, required, unique_value, show_in_list, width, max_length, height, help, sort)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, app.id, f.key, String(f.label || f.key).slice(0, 150), f.type, Object.keys(opts).length ? JSON.stringify(opts) : null,
        f.required ? 1 : 0, f.unique_value ? 1 : 0, f.show_in_list === 0 || f.show_in_list === false ? 0 : 1, f.width || 'md', f.max_length || null, f.height || 1, f.help || null, sort++);
        summary.fields_added++;
        continue;
      }
      const exOpts = parse(ex.options, {});
      let type = ex.type; let changed = false;
      if (ex.type === 'text' && ['select', 'multiselect'].includes(f.type)) {
        // texto → lista: las opciones incluyen los valores que ya hay escritos
        const used = (await all(`SELECT DISTINCT JSON_VALUE(data, '$.${ex.key}') v FROM records WHERE app_id = ? AND JSON_VALUE(data, '$.${ex.key}') <> ''`, app.id)).map((r) => r.v);
        exOpts.choices = [...new Set([...(opts.choices || []), ...used])];
        type = f.type; changed = true;
      } else if (['select', 'multiselect'].includes(ex.type) && Array.isArray(opts.choices)) {
        const merged = [...new Set([...(exOpts.choices || []), ...opts.choices])];
        if (merged.length !== (exOpts.choices || []).length) { exOpts.choices = merged; changed = true; }
      }
      for (const k of ['due_alert', 'multiple', 'colors']) if (opts[k] !== undefined && exOpts[k] === undefined) { exOpts[k] = opts[k]; changed = true; }
      if (!ex.active) { await run('UPDATE fields SET active = 1 WHERE id = ?', ex.id); changed = true; }
      if (changed) { await run('UPDATE fields SET type = ?, options = ? WHERE id = ?', type, JSON.stringify(exOpts), ex.id); summary.fields_changed++; }
    }
    // propiedades de la app (título, estado, traspasos, tipo de centro…)
    const props = {};
    for (const k of APP_PROPS) {
      if (t[k] === undefined || t[k] === null) continue;
      props[k] = ['closed_values', 'voice_fields'].includes(k) ? JSON.stringify(t[k]) : ['calendar', 'transfers'].includes(k) ? (t[k] ? 1 : 0) : t[k];
    }
    // el diseño (secciones) se aplica si la app no tiene uno propio con secciones, o si se pide
    const lay = parse(app.form_layout, {});
    const hasSections = Array.isArray(lay.items) && lay.items.some((it) => it && typeof it === 'object' && 'section' in it);
    if (t.form_layout && (forceLayout || !hasSections)) props.form_layout = JSON.stringify(t.form_layout);
    if (forceLayout || !hasSections) { // con el diseño, también los anchos y altos de los campos
      for (const f of t.fields || []) if (f.width) await run('UPDATE fields SET width = ?, height = ? WHERE app_id = ? AND `key` = ?', f.width, f.height || 1, app.id, f.key);
    }
    const keys = Object.keys(props);
    if (keys.length) await run(`UPDATE apps SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => props[k]), app.id);
    // informes que no existan con ese nombre
    for (const r of t.reports || []) {
      if (!r || !r.name) continue;
      if (await get('SELECT id FROM app_reports WHERE app_id = ? AND name = ? AND deleted_at IS NULL', app.id, r.name)) continue;
      await run('INSERT INTO app_reports (app_id, name, config) VALUES (?,?,?)', app.id, String(r.name).slice(0, 150), JSON.stringify(r.config || {}));
      summary.reports_added++;
    }
    return app;
  };
  const root = await one(tpl.app);
  for (const c of tpl.app.children || []) await one(c, root.id);
  return summary;
}

module.exports = { exportStructure, importStructure, validate, FORMAT };
