// Accesibilidad para lectores de pantalla (NVDA, JAWS, VoiceOver, TalkBack) y uso solo con teclado.
// Solo se activa para los usuarios marcados como «Usuario invidente (modo accesible)» en Usuarios.
// Se aplica automáticamente sobre todo lo que se pinta en la página, así las pantallas nuevas también lo heredan:
//  · asocia cada etiqueta con su campo, marca los obligatorios y las ayudas;
//  · da nombre legible a los botones de solo icono y quita los emojis decorativos de lo que se lee;
//  · indica el estado de los botones conmutables (pulsado / pestaña seleccionada);
//  · preferencias de accesibilidad del usuario (tamaño de texto, alto contraste, subrayar enlaces, sin animaciones).

let seq = 0;
const uid = (p) => `${p}-${++seq}`;
const CONTROL = 'input:not([type=hidden]):not([type=file]), select, textarea';
// emojis, símbolos y flechas que se usan como iconos
const ICONS = /[\p{Extended_Pictographic}\p{So}\p{Sm}️‍⃣‹›«»⋮⋯•·]/gu;
const ICON_NAMES = {
  '‹': 'Anterior', '›': 'Siguiente', '✕': 'Cerrar', '⋯': 'Más acciones', '☰': 'Menú', '👁': 'Mostrar u ocultar', '📋': 'Copiar',
  '🎲': 'Generar contraseña', '📤': 'Enviar', '🗑️': 'Enviar a la papelera', '🗑': 'Enviar a la papelera', '↗': 'Abrir enlace', '＋': 'Nuevo', '✎': 'Editar',
};

/** Texto visible de un elemento, separando los trozos (textContent los pega: «📋Recados12»). */
function visibleText(el) {
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) out.push(c.nodeValue);
      else if (c.nodeType === 1 && !c.hidden && c.getAttribute('aria-hidden') !== 'true' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(c.tagName)) {
        if (c.tagName === 'IMG') out.push(c.alt || ''); else walk(c);
      }
    }
  };
  walk(el);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}
const clean = (s) => s.replace(ICONS, ' ').replace(/\s+/g, ' ').trim();

function nameButton(b) {
  if (b.hasAttribute('aria-label') && !b.dataset.a11y) return; // nombre puesto a mano
  const raw = visibleText(b);
  let name = clean(raw);
  if (!name || name.length < 2) name = (b.title || ICON_NAMES[raw.replace(/️/g, '')] || ICON_NAMES[raw] || name || '').trim();
  else if (b.title && b.title !== name && /^\d+$/.test(name)) name = `${b.title} ${name}`;
  if (name && name !== raw) { b.setAttribute('aria-label', name); b.dataset.a11y = '1'; }
  else if (b.dataset.a11y) { b.removeAttribute('aria-label'); delete b.dataset.a11y; }
}

function fixField(field) {
  const lbl = field.querySelector(':scope > label');
  if (!lbl) return;
  const req = lbl.querySelector('.req');
  if (req) req.setAttribute('aria-hidden', 'true');
  const text = clean(visibleText(lbl));
  if (!text) { lbl.setAttribute('aria-hidden', 'true'); return; } // hueco de alineación (celdas de botón)
  const help = field.querySelector(':scope > .help');
  if (help && !help.id) help.id = uid('h');
  const ctl = field.querySelector(CONTROL);
  if (ctl && !field.querySelector('.sig-field, .img-field')) {
    if (!ctl.id) ctl.id = uid('f');
    if (ctl.type === 'checkbox') { if (!lbl.id) lbl.id = uid('l'); ctl.setAttribute('aria-labelledby', lbl.id); }
    else if (lbl.htmlFor !== ctl.id) lbl.htmlFor = ctl.id;
    if (req) ctl.setAttribute('aria-required', 'true');
    if (help) ctl.setAttribute('aria-describedby', help.id);
  } else if (!field.hasAttribute('role')) {
    // campo sin control nativo (firma, imágenes): se agrupa con su etiqueta
    if (!lbl.id) lbl.id = uid('l');
    field.setAttribute('role', 'group');
    field.setAttribute('aria-labelledby', lbl.id);
  }
}

function scan(root = document.body) {
  root.querySelectorAll('.field').forEach(fixField);
  root.querySelectorAll('button, a[href], [role=button]').forEach(nameButton);
  // conmutadores: segmentos y botones de filtro activos
  root.querySelectorAll('.seg > button').forEach((b) => b.setAttribute('aria-pressed', b.classList.contains('on')));
  root.querySelectorAll('.btn.on-toggle, .btn[data-toggle]').forEach((b) => { b.dataset.toggle = '1'; b.setAttribute('aria-pressed', b.classList.contains('on-toggle')); });
  // pestañas
  root.querySelectorAll('.tabs, .form-subtabs, .modal-tabs').forEach((t) => {
    t.setAttribute('role', 'tablist');
    t.querySelectorAll(':scope > button').forEach((b) => { b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', b.classList.contains('active')); });
  });
  // emojis decorativos sueltos (iconos de apps, del menú, tarjetas)
  root.querySelectorAll('.ico, .app-ico, .big, .logo, .grip, .sort, .cal-dow').forEach((e) => e.setAttribute('aria-hidden', 'true'));
  // campos sueltos sin etiqueta: se nombran con el texto de ayuda o la primera opción
  root.querySelectorAll('input:not([type=hidden]), select, textarea').forEach((i) => {
    if (i.hasAttribute('aria-label') || i.hasAttribute('aria-labelledby') || i.closest('label') || (i.id && document.querySelector(`label[for="${i.id}"]`))) return;
    const name = i.placeholder || i.title || (i.tagName === 'SELECT' && i.options[0] ? clean(i.options[0].text) : '');
    if (name) i.setAttribute('aria-label', name);
  });
}

let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; scan(); });
}

let observer = null;
/** ¿Está activo el modo accesible para el usuario actual? */
export const a11yOn = () => document.documentElement.dataset.access === '1';
/** Activa o desactiva el modo accesible (según la ficha del usuario). */
export function startA11y(on) {
  if (!on) {
    delete document.documentElement.dataset.access;
    if (observer) { observer.disconnect(); observer = null; }
    applyPrefs(false);
    return;
  }
  document.documentElement.dataset.access = '1';
  applyPrefs(true);
  scan();
  if (!observer) {
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  }
}

// ---------- avisos hablados ----------
let regions = null;
/** Lee un mensaje en voz alta con el lector de pantalla (sin mostrar nada). */
export function announce(msg, assertive = false) {
  if (!a11yOn()) return;
  if (!regions) {
    regions = {
      polite: Object.assign(document.createElement('div'), { className: 'sr-only' }),
      assertive: Object.assign(document.createElement('div'), { className: 'sr-only' }),
    };
    regions.polite.setAttribute('aria-live', 'polite'); regions.polite.setAttribute('role', 'status');
    regions.assertive.setAttribute('aria-live', 'assertive'); regions.assertive.setAttribute('role', 'alert');
    document.body.append(regions.polite, regions.assertive);
  }
  const r = assertive ? regions.assertive : regions.polite;
  r.textContent = '';
  setTimeout(() => { r.textContent = clean(String(msg)); }, 60); // vaciar y rellenar para que repita mensajes iguales
}

// ---------- foco atrapado en ventanas ----------
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
export function trapFocus(box, e) {
  if (e.key !== 'Tab') return;
  const list = [...box.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (!list.length) return;
  const first = list[0], last = list[list.length - 1];
  if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/** Hace accionable con teclado (Intro / Espacio) un elemento que se pulsa con el ratón. */
export function pressable(el, { role = 'button', label } = {}) {
  el.tabIndex = 0;
  if (role) el.setAttribute('role', role);
  if (label) el.setAttribute('aria-label', label);
  el.addEventListener('keydown', (e) => {
    if (e.target !== el) return;
    if (e.key === 'Enter' || (e.key === ' ' && role === 'button')) { e.preventDefault(); el.click(); }
  });
  return el;
}

// ---------- preferencias de accesibilidad (por dispositivo) ----------
const PREF_KEY = 'a11y';
export function getPrefs() {
  try { return { text: 'normal', contrast: false, links: false, motion: false, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch { return { text: 'normal' }; }
}
export function setPrefs(p) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* sin almacenamiento */ }
  applyPrefs(a11yOn());
}
function applyPrefs(on) {
  const p = on ? getPrefs() : {};
  const d = document.documentElement.dataset;
  d.text = p.text || 'normal';
  if (p.contrast) d.contrast = '1'; else delete d.contrast;
  if (p.links) d.links = '1'; else delete d.links;
  if (p.motion) d.motion = 'off'; else delete d.motion;
}
