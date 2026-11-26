'use strict';
// Tipos de campo dinámicos, validación y conversión desde/hacia texto (importación/exportación).
const { all } = require('./db');

const FIELD_TYPES = {
  text: 'Texto', textarea: 'Texto largo', number: 'Número entero', decimal: 'Número decimal',
  date: 'Fecha', datetime: 'Fecha y hora', email: 'Email', phone: 'Teléfono', url: 'URL',
  select: 'Lista desplegable', multiselect: 'Selección múltiple', checkbox: 'Sí / No',
  password: 'Contraseña (cifrada)', user: 'Usuario', color: 'Color', iban: 'Cuenta bancaria (IBAN)', ip: 'Dirección IP', signature: 'Firma (en pantalla)', image: 'Imagen / foto', group: 'Grupo de trabajo',
};

function parseField(f) {
  let options = {};
  try { options = f.options ? JSON.parse(f.options) : {}; } catch { options = {}; }
  return { ...f, options, max_length: f.max_length ? Number(f.max_length) : null, height: Math.min(Math.max(Number(f.height) || 1, 1), 8), required: !!f.required, unique_value: !!f.unique_value, show_in_list: !!f.show_in_list, active: !!f.active };
}
async function appFields(appId, includeInactive = false) {
  return (await all(`SELECT * FROM fields WHERE app_id = ? ${includeInactive ? '' : 'AND active = 1'} ORDER BY sort, id`, appId)).map(parseField);
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
 * `ctx.users` = lista de usuarios ({id, name, email}) para validar campos de tipo usuario.
 */
function normalize(field, raw, ctx = {}) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    if (field.type === 'checkbox') return false;
    if (field.type === 'multiselect') return [];
    return '';
  }
  const L = field.label;
  if (field.max_length && ['text', 'textarea', 'email', 'phone', 'url', 'password'].includes(field.type) && String(raw).trim().length > field.max_length) {
    throw new Error(`${L}: máximo ${field.max_length} caracteres (tiene ${String(raw).trim().length})`);
  }
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
      const list = ctx.users || [];
      if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
        const u = list.find((x) => x.id === Number(raw));
        if (u) return u.id;
      }
      const s = String(raw).trim().toLowerCase();
      const u = list.find((x) => x.email.toLowerCase() === s || x.name.toLowerCase() === s);
      if (!u) throw new Error(`${L}: usuario "${raw}" no encontrado`);
      return u.id;
    }
    case 'group': {
      // grupo de trabajo (de una sede): por id, código o nombre (importación)
      const list = ctx.groups || [];
      if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
        const g = list.find((x) => x.id === Number(raw));
        if (g) return g.id;
      }
      const s = String(raw).trim().toLowerCase();
      const hits = list.filter((x) => (x.code && x.code.toLowerCase() === s) || x.name.toLowerCase() === s);
      if (hits.length > 1 && ctx.centerId) { const g = hits.find((x) => x.center_id === ctx.centerId); if (g) return g.id; }
      if (hits.length !== 1) throw new Error(`${L}: grupo de trabajo "${raw}" ${hits.length ? 'repetido en varias sedes' : 'no encontrado'}`);
      return hits[0].id;
    }
    case 'iban': return normIban(raw, L);
    case 'ip': return normIp(raw, L);
    case 'signature': {
      // imagen PNG dibujada en pantalla; se guarda como { img, at }
      const img = typeof raw === 'object' && raw ? raw.img : raw;
      if (!img) return '';
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(String(img)) || String(img).length > 400000) throw new Error(`${L}: firma no válida`);
      return { img: String(img), at: (raw && raw.at) || new Date().toISOString() };
    }
    case 'url': {
      let s = String(raw).trim();
      if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
      return s;
    }
    default: return String(raw).trim();
  }
}

/** Valida un IBAN (longitud por país y dígitos de control ISO 13616). Devuelve el IBAN sin espacios. */
function normIban(v, label = 'IBAN') {
  const s = String(v || '').replace(/[\s.-]/g, '').toUpperCase();
  if (!s) return '';
  const LEN = { ES: 24, PT: 25, FR: 27, DE: 22, IT: 27, AD: 24, GB: 22, NL: 18, BE: 16, IE: 22, LU: 20, CH: 21, AT: 20 };
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s) || (LEN[s.slice(0, 2)] && s.length !== LEN[s.slice(0, 2)])) {
    throw new Error(`${label}: el IBAN no tiene un formato válido (ej. ES91 2100 0418 4502 0005 1332)`);
  }
  const num = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const d of num) rem = (rem * 10 + Number(d)) % 97;
  if (rem !== 1) throw new Error(`${label}: los dígitos de control del IBAN no son correctos (revisa el número)`);
  return s;
}
/** Valida una IP v4 o v6, con máscara CIDR opcional (/24). Quita ceros a la izquierda: 192.168.001.010 → 192.168.1.10 */
function normIp(v, label = 'IP') {
  const s = String(v || '').trim().replace(/\s+/g, '');
  if (!s) return '';
  const err = () => new Error(`${label}: dirección IP no válida (ej. 192.168.1.10 o 10.0.0.0/24)`);
  const [addr, mask, extra] = s.split('/');
  if (extra !== undefined) throw err();
  const net = require('net');
  let out;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) {
    const parts = addr.split('.').map(Number);
    if (parts.some((n) => n > 255)) throw err();
    out = parts.join('.');
    if (mask !== undefined && !(/^\d{1,2}$/.test(mask) && Number(mask) <= 32)) throw err();
  } else if (net.isIPv6(addr)) {
    out = addr.toLowerCase();
    if (mask !== undefined && !(/^\d{1,3}$/.test(mask) && Number(mask) <= 128)) throw err();
  } else throw err();
  return mask !== undefined ? `${out}/${Number(mask)}` : out;
}
const fmtIban = (s) => String(s || '').replace(/(.{4})/g, '$1 ').trim();

/** Convierte un valor almacenado a texto legible (para exportar). */
function toText(field, v, usersById = {}, groupsById = {}) {
  if (v === undefined || v === null || v === '') return '';
  switch (field.type) {
    case 'checkbox': return v ? 'Sí' : 'No';
    case 'multiselect': return Array.isArray(v) ? v.join(', ') : String(v);
    case 'user': return usersById[v] ? usersById[v].name : String(v);
    case 'group': return groupsById[v] ? groupsById[v].name : String(v);
    case 'iban': return fmtIban(v);
    case 'signature': return v && v.img ? `Firmado ${String(v.at || '').slice(0, 10)}` : '';
    case 'image': return Array.isArray(v) && v.length ? `${v.length} imagen${v.length > 1 ? 'es' : ''}` : '';
    default: return v;
  }
}

module.exports = { FIELD_TYPES, appFields, parseField, normalize, toText, normIban, normIp };
