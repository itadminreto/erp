// Utilidades compartidas del frontend: API, creación de elementos, modales, avisos.
import { announce, trapFocus, a11yOn } from './a11y.js';
export { announce, pressable, a11yOn } from './a11y.js';
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
  const t = h('div.toast', { class: type, 'aria-hidden': a11yOn() ? 'true' : null }, msg); // en modo accesible se lee por announce()
  document.getElementById('toasts').append(t);
  announce(type === 'error' ? 'Error: ' + msg : msg, type === 'error');
  setTimeout(() => t.remove(), type === 'error' ? 6000 : 3200);
}
export const toastErr = (e) => toast(e.message || String(e), 'error');

/** Modal genérico. Devuelve { el, body, foot, close }. */
export function modal({ title, size = '', content, footer, onClose, tabs } = {}) {
  const body = h('div.modal-body');
  const foot = h('div.modal-foot');
  const titleId = 'dlg-' + Math.random().toString(36).slice(2, 9);
  const box = h('div.modal', { class: size, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div.modal-head', h('h2', { id: titleId, tabindex: '-1' }, title), h('button.btn.ghost.icon', { title: 'Cerrar', 'aria-label': 'Cerrar ventana', onclick: () => close() }, '✕')),
    tabs || null, body, foot);
  const bg = h('div.modal-bg', { onmousedown: (e) => { if (e.target === bg) close(); } }, box);
  const opener = document.activeElement; // al cerrar, el foco vuelve a donde estaba
  const isTop = () => bg === [...document.querySelectorAll('.modal-bg')].pop();
  const onKey = (e) => {
    if (!isTop()) return;
    if (e.key === 'Escape') close();
    else trapFocus(box, e);
  };
  function close(v) {
    bg.remove(); document.removeEventListener('keydown', onKey);
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    onClose && onClose(v);
  }
  document.addEventListener('keydown', onKey);
  if (content) append(body, [content]);
  if (footer) append(foot, [footer]); else foot.hidden = true;
  document.body.append(bg);
  setTimeout(() => {
    const f = box.querySelector('.modal-body input:not([type=checkbox]):not([readonly]):not([disabled]), .modal-body select:not([disabled]), .modal-body textarea:not([disabled])');
    (f || box.querySelector('h2')).focus();
  }, 30);
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
      if (f.max_length && ['INPUT', 'TEXTAREA'].includes(inp.tagName) && inp.type !== 'checkbox') inp.maxLength = f.max_length;
      if (f.type === 'ip') ipMask(inp);
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
    m.body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); m.foot.querySelector('.primary').click(); } });
  });
}

export function dropdown(button, items) {
  const wrap = h('div.dropdown', button);
  let menu = null;
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const closeMenu = (refocus) => {
    menu && menu.remove(); menu = null; button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', outside, true);
    if (refocus) button.focus();
  };
  const outside = (e) => { if (!wrap.contains(e.target)) closeMenu(); };
  button.addEventListener('click', () => {
    if (menu) return closeMenu();
    menu = h('div.dropdown-menu', { role: 'menu' }, items.filter(Boolean).map((it) => it === '-' ? h('hr', { role: 'separator' })
      : h('button', { role: 'menuitem', tabindex: '-1', onclick: () => { closeMenu(true); it.onclick(); } }, it.label)));
    menu.addEventListener('keydown', (e) => {
      const list = [...menu.querySelectorAll('[role=menuitem]')];
      const i = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
      else if (e.key === 'Tab') closeMenu();
    });
    wrap.append(menu);
    button.setAttribute('aria-expanded', 'true');
    const first = menu.querySelector('[role=menuitem]'); first && first.focus();
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
  purge: 'Borrado definitivo', import: 'Importar', export: 'Exportar', email: 'Enviar por correo', view_passwords: 'Ver contraseñas',
  share_passwords: 'Enviar contraseñas', view_history: 'Ver historial', only_own: 'Solo sus registros',
};
export const ACTION_LABELS = {
  create: ['Alta', 'ok'], update: ['Modificación', ''], delete: ['Papelera', 'danger'], restore: ['Restaurado', 'ok'], purge: ['Borrado definitivo', 'danger'],
  reveal: ['Contraseña vista', 'warn'], share: ['Contraseña enviada', 'warn'], share_open: ['Enlace abierto', 'warn'], export: ['Exportación', ''], import: ['Importación', ''],
  backup: ['Copia de seguridad', 'ok'], email: ['Correo enviado', 'warn'], login: ['Acceso', ''], login_failed: ['Acceso fallido', 'danger'], password: ['Cambio contraseña', 'warn'],
};

/**
 * Máscara de dirección IP para un <input>: solo números, puntos y «/» (o modo IPv6 si se escribe «:»),
 * pone el punto solo tras 3 cifras, impide más de 4 bloques y marca en rojo bloques > 255 o IP incompleta.
 */
export function ipMask(input) {
  input.setAttribute('inputmode', 'decimal');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('spellcheck', 'false');
  if (!input.placeholder) input.placeholder = '192.168.1.10';
  const valid = (v) => {
    if (!v) return true;
    const [a, m, x] = v.split('/');
    if (x !== undefined) return false;
    if (a.includes(':')) return /^[0-9a-f:.]+$/i.test(a) && a.split(':').length >= 3 && (m === undefined || (/^\d{1,3}$/.test(m) && +m <= 128));
    const p = a.split('.');
    return p.length === 4 && p.every((o) => /^\d{1,3}$/.test(o) && +o <= 255) && (m === undefined || (/^\d{1,2}$/.test(m) && +m <= 32));
  };
  const mark = (final) => {
    const v = input.value;
    const [a] = v.split('/');
    const over = !a.includes(':') && a.split('.').some((o) => +o > 255);
    const bad = over || (final && !valid(v));
    input.classList.toggle('invalid', bad);
    input.title = bad ? 'IP no válida: 4 bloques de 0 a 255 (ej. 192.168.1.10), máscara opcional /0-32' : '';
  };
  input.addEventListener('input', (e) => {
    let v = input.value;
    // IPv6 (lleva «:» o letras a-f): solo se filtran caracteres no válidos
    if (/[:a-f]/i.test(v)) { input.value = v.replace(/[^0-9a-fA-F:./]/g, ''); return mark(false); }
    v = v.replace(/,/g, '.').replace(/[^0-9./]/g, '');
    let [a, ...rest] = v.split('/');
    a = a.replace(/\.{2,}/g, '.').replace(/^\./, '');
    let blocks = a.split('.');
    if (blocks.length > 4) blocks = blocks.slice(0, 4);
    blocks = blocks.map((b) => b.replace(/^0+(?=\d)/, '').slice(0, 3)); // sin ceros a la izquierda (01 → 1)
    a = blocks.join('.');
    // Punto automático al escribir al final: el bloque está completo si tiene 3 cifras, es un «0»
    // o cualquier cifra más lo haría pasar de 255 (p. ej. «26»).
    const atEnd = input.selectionStart === input.value.length;
    const typing = e.inputType && e.inputType.startsWith('insert') && atEnd;
    const last = blocks[blocks.length - 1];
    const full = last.length === 3 || last === '0' || (last.length === 2 && Number(last) > 25);
    if (typing && blocks.length < 4 && full && !rest.length && !a.endsWith('.')) a += '.';
    const mask = rest.length ? '/' + rest.join('').replace(/\D/g, '').slice(0, 2) : '';
    input.value = a + mask;
    mark(false);
  });
  input.addEventListener('blur', () => { input.value = input.value.replace(/\.$/, ''); mark(true); });
  mark(false);
  return input;
}

/**
 * Ventana para firmar con el dedo, lápiz o ratón. Devuelve una imagen PNG (data URL) o null si se cancela.
 */
export function signaturePad(title = 'Firmar') {
  return new Promise((resolve) => {
    let result = null, drawn = false;
    const canvas = h('canvas.sig-canvas', { role: 'img', 'aria-label': 'Recuadro de firma' });
    const hint = h('div.sig-hint', 'Firme aquí');
    const wrap = h('div.sig-wrap', canvas, hint, h('div.sig-line'));
    const m = modal({
      title: '✍ ' + title, size: '',
      content: [h('p.muted.small', 'Firme dentro del recuadro con el dedo, un lápiz táctil o el ratón.'), wrap],
      footer: [h('button.btn', { onclick: () => clearPad() }, '↺ Borrar'),
        a11yOn() ? h('button.btn', { title: 'Alternativa accesible: escribe tu nombre y se convierte en firma', onclick: () => typed() }, '⌨ Firmar escribiendo el nombre') : null,
        h('div.spacer'),
        h('button.btn', { onclick: () => m.close() }, 'Cancelar'),
        h('button.btn.primary', { onclick: () => {
          if (!drawn) return toast('Firme antes de aceptar', 'error');
          result = trimmed(); m.close();
        } }, 'Aceptar firma')],
      onClose: () => resolve(result),
    });
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const setup = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = r.width * dpr; canvas.height = r.height * dpr;
      ctx.scale(dpr, dpr); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111827'; ctx.lineWidth = 2.4;
    };
    requestAnimationFrame(setup);
    function clearPad() { ctx.clearRect(0, 0, canvas.width, canvas.height); drawn = false; hint.hidden = false; }
    // firma tecleada: útil con lector de pantalla o sin poder dibujar
    async function typed() {
      const v = await promptDlg('Firmar escribiendo el nombre', [{ key: 'name', label: 'Nombre y apellidos', required: true, help: 'Se dibujará como firma en el recuadro.' }], { ok: 'Firmar' });
      const name = v && v.name.trim();
      if (!name) return;
      clearPad();
      const r = canvas.getBoundingClientRect();
      let size = 46;
      do { ctx.font = `italic ${size}px "Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive`; size -= 2; } while (ctx.measureText(name).width > r.width - 40 && size > 14);
      ctx.fillStyle = '#111827'; ctx.textBaseline = 'middle';
      ctx.fillText(name, 20, r.height / 2);
      drawn = true; hint.hidden = true;
      announce(`Firma generada con el nombre ${name}. Pulsa Aceptar firma para guardarla.`);
      m.foot.querySelector('.btn.primary').focus();
    }
    let last = null;
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); canvas.setPointerCapture(e.pointerId); last = pos(e); ctx.beginPath(); ctx.arc(last.x, last.y, 1.1, 0, Math.PI * 2); ctx.fillStyle = '#111827'; ctx.fill(); drawn = true; hint.hidden = true; });
    canvas.addEventListener('pointermove', (e) => {
      if (!last) return;
      const p = pos(e);
      const mid = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.quadraticCurveTo(last.x, last.y, mid.x, mid.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last = p;
    });
    const end = () => { last = null; };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    // recorta el espacio vacío y reduce a un tamaño razonable (fondo transparente)
    function trimmed() {
      const { width: w, height: hgt } = canvas;
      const px = ctx.getImageData(0, 0, w, hgt).data;
      let x0 = w, y0 = hgt, x1 = 0, y1 = 0;
      for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const pad = 8 * dpr; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w, x1 + pad); y1 = Math.min(hgt, y1 + pad);
      const scale = Math.min(1, 600 / (x1 - x0), 220 / (y1 - y0));
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round((x1 - x0) * scale)); out.height = Math.max(1, Math.round((y1 - y0) * scale));
      out.getContext('2d').drawImage(canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, out.width, out.height);
      return out.toDataURL('image/png');
    }
  });
}

/**
 * Prepara una imagen elegida o hecha con la cámara: la reduce a máx. 1600 px y la comprime en JPEG.
 * Los PNG pequeños (p. ej. firmas escaneadas con fondo transparente) se mantienen en PNG.
 * Devuelve { data (data URL), name, w, h }.
 */
export async function prepareImage(file, maxSide = 1600) {
  if (!/^image\//.test(file.type)) throw new Error(`«${file.name}» no es una imagen`);
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ko(new Error(`No se puede leer «${file.name}»`)); i.src = url; });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale), hgt = Math.round(img.naturalHeight * scale);
    const keepPng = file.type === 'image/png' && file.size < 1024 * 1024;
    const c = document.createElement('canvas'); c.width = w; c.height = hgt;
    const ctx = c.getContext('2d');
    if (!keepPng) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, hgt); } // JPEG no admite transparencia
    ctx.drawImage(img, 0, 0, w, hgt);
    const data = keepPng ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.82);
    return { data, name: file.name || 'foto.jpg', w, h: hgt };
  } finally { URL.revokeObjectURL(url); }
}

/** Visor de imágenes a pantalla completa con flechas para pasar entre ellas. */
export function imageViewer(urls, start = 0) {
  let i = start;
  const img = h('img.viewer-img', { alt: '' });
  const names = Array.isArray(urls.names) ? urls.names : [];
  const count = h('span.muted.small');
  const show = () => { img.src = urls[i]; img.alt = names[i] || `Imagen ${i + 1} de ${urls.length}`; count.textContent = urls.length > 1 ? `${i + 1} / ${urls.length}` : ''; };
  const m = modal({
    title: 'Imagen', size: 'lg',
    content: h('div.viewer', img),
    footer: [count, h('div.spacer'),
      urls.length > 1 ? h('button.btn', { onclick: () => { i = (i - 1 + urls.length) % urls.length; show(); } }, '‹ Anterior') : null,
      urls.length > 1 ? h('button.btn', { onclick: () => { i = (i + 1) % urls.length; show(); } }, 'Siguiente ›') : null,
      h('a.btn', { href: urls[start], target: '_blank', rel: 'noopener', onclick: (e) => { e.currentTarget.href = urls[i]; } }, '↗ Abrir'),
      h('button.btn.primary', { onclick: () => m.close() }, 'Cerrar')],
  });
  show();
}

/** Foto con la webcam del ordenador (necesita HTTPS). Devuelve un File JPEG o null. */
export function webcamPhoto() {
  return new Promise((resolve) => {
    let stream = null, result = null;
    const video = h('video.viewer-img', { autoplay: true, playsinline: true, muted: true });
    const m = modal({
      title: '📷 Hacer foto', size: 'lg', content: h('div.viewer', video),
      footer: [h('div.spacer'), h('button.btn', { onclick: () => m.close() }, 'Cancelar'),
        h('button.btn.primary', { onclick: () => {
          const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight;
          c.getContext('2d').drawImage(video, 0, 0);
          c.toBlob((b) => { result = new File([b], `foto_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg`, { type: 'image/jpeg' }); m.close(); }, 'image/jpeg', 0.9);
        } }, '📸 Capturar')],
      onClose: () => { if (stream) stream.getTracks().forEach((t) => t.stop()); resolve(result); },
    });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => { stream = s; video.srcObject = s; })
      .catch(() => { toast('No se puede acceder a la cámara', 'error'); m.close(); });
  });
}
export const canUseWebcam = () => !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
  && !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
