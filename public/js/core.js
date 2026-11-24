// Utilidades compartidas del frontend: API, creación de elementos, modales, avisos.
export const state = { me: null, companyId: Number(localStorage.getItem('companyId')) || null, apps: [] };

export async function api(path, { method = 'GET', body, raw = false, form } = {}) {
  const headers = { 'X-Requested-With': 'erp' };
  if (state.companyId) headers['X-Company-Id'] = state.companyId;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch('/api' + path, { method, headers, body: payload, credentials: 'same-origin' });
  if (raw) { if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText); return res; }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') { location.hash = '#/login'; throw new Error(data.error || 'Sesión caducada'); }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

/** Crea un elemento: h('div.card.pad', {onclick}, hijos...). El texto siempre se inserta como texto (sin HTML). */
export function h(tag, attrs, ...children) {
  if (attrs === null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) { children.unshift(attrs); attrs = {}; }
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (['value', 'checked', 'selected', 'disabled', 'hidden', 'indeterminate'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const clear = (el, ...children) => { el.replaceChildren(); append(el, children); return el; };

export function toast(msg, type = '') {
  const t = h('div.toast', { class: type }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), type === 'error' ? 6000 : 3200);
}
export const toastErr = (e) => toast(e.message || String(e), 'error');

/** Modal genérico. Devuelve { el, body, foot, close }. */
export function modal({ title, size = '', content, footer, onClose, tabs } = {}) {
  const body = h('div.modal-body');
  const foot = h('div.modal-foot');
  const box = h('div.modal', { class: size, role: 'dialog', 'aria-modal': 'true' },
    h('div.modal-head', h('h2', title), h('button.btn.ghost.icon', { title: 'Cerrar', onclick: () => close() }, '✕')),
    tabs || null, body, foot);
  const bg = h('div.modal-bg', { onmousedown: (e) => { if (e.target === bg) close(); } }, box);
  const onKey = (e) => { if (e.key === 'Escape' && document.querySelectorAll('.modal-bg').length && bg === [...document.querySelectorAll('.modal-bg')].pop()) close(); };
  function close(v) { bg.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(v); }
  document.addEventListener('keydown', onKey);
  if (content) append(body, [content]);
  if (footer) append(foot, [footer]); else foot.hidden = true;
  document.body.append(bg);
  setTimeout(() => { const f = box.querySelector('input:not([type=checkbox]):not([readonly]), select, textarea'); f && f.focus(); }, 30);
  return { el: box, body, foot, close };
}

export function confirmDlg(message, { ok = 'Aceptar', danger = false, title = 'Confirmar' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title, size: 'sm', content: h('p', message),
      footer: [h('div.spacer'), h('button.btn', { onclick: () => m.close() }, 'Cancelar'),
        h('button.btn', { class: danger ? 'danger solid' : 'primary', onclick: () => { done = true; m.close(); } }, ok)],
      onClose: () => resolve(done),
    });
  });
}

/**
 * Formulario en ventana. Tipos: text, textarea, select (options), multiselect (options), checkbox, number, decimal,
 * date, datetime, email, phone, url, color, iban. Con más de 7 campos se reparte en dos columnas.
 * Los campos con `section` muestran un título antes. Devuelve los valores o null si se cancela.
 */
export function promptDlg(title, fields, { ok = 'Guardar' } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const inputs = {};
    const wide = fields.length > 7;
    const INPUT = { number: { type: 'number', step: '1' }, decimal: { type: 'number', step: 'any' }, datetime: { type: 'datetime-local' },
      phone: { type: 'tel' }, iban: { type: 'text', placeholder: 'ES00 0000 0000 0000 0000 0000', autocomplete: 'off' } };
    const items = [];
    for (const f of fields) {
      if (f.section) items.push(h('h3.form-section', { style: wide ? { gridColumn: '1 / -1' } : {} }, f.section));
      const sel = (multi) => h('select', { multiple: multi, size: multi ? Math.min(6, f.options.length || 3) : undefined },
        f.options.map((o) => h('option', { value: o.value, selected: multi ? (Array.isArray(f.value) && f.value.map(String).includes(String(o.value))) : String(o.value) === String(f.value ?? '') }, o.label)));
      const inp = f.type === 'textarea' ? h('textarea', { value: f.value || '' })
        : f.type === 'select' ? sel(false)
        : f.type === 'multiselect' ? sel(true)
        : f.type === 'checkbox' ? h('input', { type: 'checkbox', checked: !!f.value })
        : f.type === 'color' ? h('input', { type: 'color', value: f.value || '#64748b' })
        : h('input', { type: f.type || 'text', ...(INPUT[f.type] || {}), value: f.type === 'iban' && f.value ? String(f.value).replace(/(.{4})/g, '$1 ').trim() : (f.value ?? ''), placeholder: f.placeholder || (INPUT[f.type] || {}).placeholder || '' });
      inp.dataset.kind = f.type || 'text';
      inputs[f.key] = inp;
      const full = wide && (f.type === 'textarea' || f.full) ? { gridColumn: '1 / -1' } : {};
      items.push(f.type === 'checkbox' ? h('label.check', { style: { ...full, minHeight: '34px' } }, inp, f.label)
        : h('div.field', { style: full }, h('label', f.label, f.required ? h('span.req', '*') : null), inp, f.help ? h('div.help', f.help) : null));
    }
    const content = wide ? h('div.two-col', { style: { gap: '14px 18px' } }, items) : h('div.stack', items);
    const read = (i) => (i.type === 'checkbox' ? i.checked : i.multiple ? [...i.selectedOptions].map((o) => o.value) : i.value);
    const m = modal({
      title, size: wide ? '' : 'sm', content,
      footer: [h('div.spacer'), h('button.btn', { onclick: () => m.close() }, 'Cancelar'),
        h('button.btn.primary', { onclick: () => { result = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, read(i)])); m.close(); } }, ok)],
      onClose: () => resolve(result),
    });
    m.body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') m.foot.querySelector('.primary').click(); });
  });
}

export function dropdown(button, items) {
  const wrap = h('div.dropdown', button);
  let menu = null;
  const closeMenu = () => { menu && menu.remove(); menu = null; document.removeEventListener('click', outside, true); };
  const outside = (e) => { if (!wrap.contains(e.target)) closeMenu(); };
  button.addEventListener('click', () => {
    if (menu) return closeMenu();
    menu = h('div.dropdown-menu', items.filter(Boolean).map((it) => it === '-' ? h('hr') : h('button', { onclick: () => { closeMenu(); it.onclick(); } }, it.label)));
    wrap.append(menu);
    document.addEventListener('click', outside, true);
  });
  return wrap;
}

export const fmtDate = (s) => { if (!s) return ''; const [y, m, d] = String(s).slice(0, 10).split('-'); return d ? `${d}/${m}/${y}` : s; };
export const fmtDateTime = (s) => { if (!s) return ''; const d = new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') || String(s).includes('T') ? '' : 'Z')); return isNaN(d) ? s : d.toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }); };
export const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export async function download(path, fallbackName) {
  try {
    const res = await api(path, { raw: true });
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const name = (cd.match(/filename="([^"]+)"/) || [])[1] || fallbackName;
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (e) { toastErr(e); }
}
export function genPassword(len = 16) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%&*?-_';
  const arr = crypto.getRandomValues(new Uint32Array(len));
  return Array.from(arr, (n) => abc[n % abc.length]).join('');
}
export const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast('Copiado al portapapeles', 'ok'); } catch { toast('No se pudo copiar', 'error'); } };
export const sortable = (el, opts) => (window.Sortable ? window.Sortable.create(el, { animation: 150, ...opts }) : null);

export const PERM_LABELS = {
  view: 'Ver', create: 'Crear', edit: 'Editar', delete: 'Borrar (papelera)', view_trash: 'Ver papelera', restore: 'Restaurar',
  purge: 'Borrado definitivo', import: 'Importar', export: 'Exportar', view_passwords: 'Ver contraseñas',
  share_passwords: 'Enviar contraseñas', view_history: 'Ver historial', only_own: 'Solo sus registros',
};
export const ACTION_LABELS = {
  create: ['Alta', 'ok'], update: ['Modificación', ''], delete: ['Papelera', 'danger'], restore: ['Restaurado', 'ok'], purge: ['Borrado definitivo', 'danger'],
  reveal: ['Contraseña vista', 'warn'], share: ['Contraseña enviada', 'warn'], share_open: ['Enlace abierto', 'warn'], export: ['Exportación', ''], import: ['Importación', ''],
  backup: ['Copia de seguridad', 'ok'], login: ['Acceso', ''], login_failed: ['Acceso fallido', 'danger'], password: ['Cambio contraseña', 'warn'],
};
