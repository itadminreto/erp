'use strict';
// Tipos de campo dinámicos, validación y conversión desde/hacia texto (importación/exportación).
const { all, get } = require('./db');

const FIELD_TYPES = {
  text: 'Texto', textarea: 'Texto largo', number: 'Número entero', decimal: 'Número decimal',
  date: 'Fecha', datetime: 'Fecha y hora', email: 'Email', phone: 'Teléfono', url: 'URL',
  select: 'Lista desplegable', multiselect: 'Selección múltiple', checkbox: 'Sí / No',
  password: 'Contraseña (cifrada)', user: 'Usuario', color: 'Color',
};

function parseField(f) {
  let options = {};
  try { options = f.options ? JSON.parse(f.options) : {}; } catch { options = {}; }
  return { ...f, options, required: !!f.required, unique_value: !!f.unique_value, show_in_list: !!f.show_in_list, active: !!f.active };
}
function appFields(appId, includeInactive = false) {
  return all(`SELECT * FROM fields WHERE app_id = ? ${includeInactive ? '' : 'AND active = 1'} ORDER BY sort, id`, appId).map(parseField);
}

const YES = ['1', 'si', 'sí', 's', 'yes', 'y', 'true', 'x', 'verdadero'];

function toDateStr(v) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/); // dd/mm/aaaa
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  if (/^\d+(\.\d+)?$/.test(s)) { // número de serie de Excel
    const d = new Date(Math.round((Number(s) - 25569) * 864e5));
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Normaliza un valor según el tipo de campo. Lanza Error con mensaje legible si no es válido.
 * `ctx.users` (opcional) permite resolver usuarios por nombre/email en importaciones.
 */
function normalize(field, raw, ctx = {}) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    if (field.type === 'checkbox') return false;
    if (field.type === 'multiselect') return [];
    return '';
  }
  const L = field.label;
  switch (field.type) {
    case 'number': {
      const n = Number(String(raw).replace(/\./g, '').replace(',', '.'));
      if (!Number.isFinite(n)) throw new Error(`${L}: número no válido`);
      return Math.round(n);
    }
    case 'decimal': {
      let s = String(raw).trim();
      if (typeof raw !== 'number' && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
      const n = Number(s);
      if (!Number.isFinite(n)) throw new Error(`${L}: número no válido`);
      return n;
    }
    case 'checkbox': return typeof raw === 'boolean' ? raw : YES.includes(String(raw).trim().toLowerCase());
    case 'date': { const d = toDateStr(raw); if (!d) throw new Error(`${L}: fecha no válida`); return d; }
    case 'datetime': {
      if (raw instanceof Date) return raw.toISOString().slice(0, 16);
      const s = String(raw).trim();
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0, 16);
      const d = toDateStr(s); if (!d) throw new Error(`${L}: fecha no válida`);
      const t = s.match(/(\d{1,2}):(\d{2})/);
      return `${d}T${t ? t[1].padStart(2, '0') + ':' + t[2] : '00:00'}`;
    }
    case 'email': {
      const s = String(raw).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new Error(`${L}: email no válido`);
      return s;
    }
    case 'select': {
      const s = String(raw).trim();
      const choices = field.options.choices || [];
      const hit = choices.find((c) => c.toLowerCase() === s.toLowerCase());
      if (choices.length && !hit) throw new Error(`${L}: "${s}" no está entre las opciones`);
      return hit || s;
    }
    case 'multiselect': {
      const arr = Array.isArray(raw) ? raw : String(raw).split(/[,;|]/);
      const choices = field.options.choices || [];
      return arr.map((x) => String(x).trim()).filter(Boolean).map((s) => {
        const hit = choices.find((c) => c.toLowerCase() === s.toLowerCase());
        if (choices.length && !hit) throw new Error(`${L}: "${s}" no está entre las opciones`);
        return hit || s;
      });
    }
    case 'user': {
      if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
        const u = get('SELECT id FROM users WHERE id = ?', Number(raw));
        if (u) return u.id;
      }
      const s = String(raw).trim().toLowerCase();
      const list = ctx.users || all('SELECT id, name, email FROM users WHERE deleted_at IS NULL');
      const u = list.find((x) => x.email.toLowerCase() === s || x.name.toLowerCase() === s);
      if (!u) throw new Error(`${L}: usuario "${raw}" no encontrado`);
      return u.id;
    }
    case 'url': {
      let s = String(raw).trim();
      if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
      return s;
    }
    default: return String(raw).trim();
  }
}

/** Convierte un valor almacenado a texto legible (para exportar). */
function toText(field, v, usersById = {}) {
  if (v === undefined || v === null || v === '') return '';
  switch (field.type) {
    case 'checkbox': return v ? 'Sí' : 'No';
    case 'multiselect': return Array.isArray(v) ? v.join(', ') : String(v);
    case 'user': return usersById[v] ? usersById[v].name : String(v);
    default: return v;
  }
}

module.exports = { FIELD_TYPES, appFields, parseField, normalize, toText };
