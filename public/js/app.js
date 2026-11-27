// Arranque, inicio de sesión, menú lateral y enrutado.
import { api, h, clear, toast, toastErr, state, modal, announce } from './core.js';
import { startA11y, getPrefs, setPrefs } from './a11y.js';
import { renderApp } from './records.js';
import { renderVoice } from './voice.js';
import { renderCompanies, renderCenters, renderWorkGroups, renderUsers, renderRoles, renderAppsAdmin, renderSettings, renderAudit, renderFormDesigner } from './admin.js';

const root = document.getElementById('root');
let shell = null, nav = null, content = null;

try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* sin almacenamiento */ }

async function boot() {
  try {
    state.me = await api('/me');
  } catch {
    return renderLogin();
  }
  if (!state.companyId || !state.me.companies.some((c) => c.id === state.companyId)) state.companyId = state.me.company_id;
  document.title = state.me.app_name;
  startA11y(state.me.accessible);
  buildShell();
  await refreshApps();
  window.addEventListener('hashchange', route);
  route();
  if (state.me.must_change_password) changePassword(true);
}

function renderLogin() {
  startA11y(false);
  // la pantalla de acceso es accesible para todos (aún no se sabe quién entra)
  const email = h('input', { id: 'login-email', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', placeholder: 'usuario@empresa.com', required: true });
  const pass = h('input', { id: 'login-pass', type: 'password', autocomplete: 'current-password', required: true });
  const err = h('p.error', { hidden: true, role: 'alert' });
  const btn = h('button.btn.primary.block', { type: 'submit' }, 'Entrar');
  document.body.classList.add('center-page');
  clear(root, h('form.card.login-card', {
    onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; err.hidden = true;
      try { await api('/login', { method: 'POST', body: { email: email.value, password: pass.value } }); document.body.classList.remove('center-page'); location.hash = '#/'; boot(); }
      catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
    },
  }, h('h1.brand', { style: { padding: 0 } }, h('div.logo', 'G'), 'Gestión de Aplicaciones'),
  h('p.muted', 'Accede con tu usuario corporativo.'),
  h('div.field', h('label', { for: 'login-email' }, 'Email o usuario'), email), h('div.field', h('label', { for: 'login-pass' }, 'Contraseña'), pass), err, btn));
  document.title = 'Iniciar sesión · Gestión de Aplicaciones';
  setTimeout(() => email.focus(), 0);
}

function buildShell() {
  document.body.classList.remove('center-page');
  nav = h('nav.nav', { 'aria-label': 'Menú principal' });
  content = h('main.content', { id: 'main', tabindex: '-1' });
  const companySel = state.me.companies.length > 1
    ? h('select.company-select', { onchange: (e) => { state.companyId = Number(e.target.value); localStorage.setItem('companyId', state.companyId); buildShell(); refreshApps().then(route); } },
      state.me.companies.map((c) => h('option', { value: c.id, selected: c.id === state.companyId }, '🏢 ' + c.name)))
    : state.me.companies.length ? h('div.company-select.muted.small', '🏢 ' + state.me.companies[0].name) : h('div.company-select.error.small', 'Sin empresa asignada');
  const initials = state.me.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  const userMenu = h('div.foot',
    h('div.who', h('div.avatar', initials), h('div', { style: { flex: 1, minWidth: 0 } },
      h('div', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, state.me.name),
      h('div.muted.small', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, state.me.is_superadmin ? 'Super admin' : state.me.email))),
    h('div.acts',
      h('button.btn.sm.ghost', { title: 'Mi perfil', onclick: () => changePassword(false) }, '⚙ Perfil'),
      h('button.btn.sm.ghost', { title: 'Cambiar tema claro/oscuro', onclick: toggleTheme }, '◐ Tema'),
      state.me.accessible ? h('button.btn.sm.ghost', { title: 'Accesibilidad: tamaño de letra, contraste, lector de pantalla', onclick: openA11y }, '♿ Accesibilidad') : null,
      h('button.btn.sm.ghost', { title: 'Cerrar sesión', onclick: async () => { await api('/logout', { method: 'POST' }); location.reload(); } }, '⎋ Salir')));
  const company = state.me.companies.find((c) => c.id === state.companyId);
  const brandIcon = company && company.has_logo ? h('img.logo-img', { src: `/api/companies/${company.id}/logo?v=${Date.now()}`, alt: '' }) : h('div.logo', 'G');
  const sidebar = h('aside.sidebar', h('div.brand', brandIcon, h('span', state.me.app_name)), companySel, nav, userMenu);
  const menuBtn = h('button.btn.ghost.icon', { 'aria-label': 'Abrir menú', 'aria-expanded': 'false', 'aria-controls': 'sidebar', onclick: () => {
    const open = shell.classList.toggle('nav-open'); menuBtn.setAttribute('aria-expanded', open);
    if (open) { const a = nav.querySelector('a'); a && a.focus(); }
  } }, '☰');
  sidebar.id = 'sidebar';
  sidebar.addEventListener('keydown', (e) => { if (e.key === 'Escape' && shell.classList.contains('nav-open')) { shell.classList.remove('nav-open'); menuBtn.setAttribute('aria-expanded', 'false'); menuBtn.focus(); } });
  const topbar = h('header.topbar', menuBtn, h('strong', state.me.app_name));
  const skip = h('a.skip-link', { href: '#main', onclick: (e) => { e.preventDefault(); content.focus(); } }, 'Saltar al contenido');
  shell = h('div.shell', sidebar, h('div.backdrop', { onclick: () => shell.classList.remove('nav-open') }), h('div.main', topbar, content));
  clear(root, state.me.accessible ? skip : null, shell);
}

function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch { /* ignorar */ }
}

async function refreshApps() {
  try { state.apps = await api('/apps'); } catch (e) { toastErr(e); state.apps = []; }
  drawNav();
}

function drawNav() {
  const cur = location.hash || '#/';
  const link = (href, ico, label, extra, color) => {
    const on = cur === href || (href !== '#/' && cur.startsWith(href + '/'));
    return h('a', { href, class: on ? 'active' : '', 'aria-current': on ? 'page' : null, 'aria-label': extra != null ? `${label}, ${extra} registro${extra === 1 ? '' : 's'}` : null,
      onclick: () => shell.classList.remove('nav-open') },
    h('span.ico', { style: color ? { background: color + '22' } : {} }, ico), h('span', label), extra != null ? h('span.count', extra) : null);
  };
  clear(nav,
    link('#/', '🏠', 'Inicio'),
    voiceApps().length ? [h('div.section', { role: 'heading', 'aria-level': '2' }, 'Asistente por voz'), voiceApps().map((a) => link('#/voz/' + a.key, '📞', `Recoger · ${a.name}`))] : null,
    state.apps.length ? h('div.section', { role: 'heading', 'aria-level': '2' }, 'Aplicaciones') : null,
    state.apps.map((a) => link('#/app/' + a.key, a.icon || '📁', a.name, a.count, a.color)),
    state.me.is_superadmin ? [h('div.section', { role: 'heading', 'aria-level': '2' }, 'Super admin'),
      link('#/admin/companies', '🏢', 'Empresas'), link('#/admin/centers', '📍', 'Centros'), link('#/admin/groups', '🧑‍🤝‍🧑', 'Grupos de trabajo'), link('#/admin/users', '👥', 'Usuarios'),
      link('#/admin/roles', '🛡️', 'Roles y políticas'), link('#/admin/apps', '🧩', 'Apps y campos'), link('#/admin/audit', '🕘', 'Auditoría'), link('#/admin/settings', '⚙️', 'Ajustes')] : null);
}

let firstRoute = true;
async function route() {
  await routeInner();
  const h1 = content.querySelector('h1');
  const name = h1 ? h1.textContent.trim() : '';
  document.title = name ? `${name} · ${state.me.app_name}` : state.me.app_name;
  if (firstRoute) { firstRoute = false; return; }
  const act = document.activeElement;
  if (act && act !== content && content.contains(act)) return; // la pantalla ya colocó el foco (p. ej. el asistente)
  if (h1) { h1.tabIndex = -1; h1.focus({ preventScroll: true }); } else content.focus({ preventScroll: true });
}
async function routeInner() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [a, b, c] = hash.split('/');
  drawNav();
  clear(content, h('p.muted', { role: 'status' }, 'Cargando…'));
  try {
    if (a === 'app' && b) return await renderApp(content, b, refreshApps);
    if (a === 'voz' && b) return await renderVoice(content, b);
    if (a === 'admin' && state.me.is_superadmin) {
      const refreshAll = async () => { state.me = await api('/me'); buildShell(); await refreshApps(); route(); };
      const views = { companies: () => renderCompanies(content, refreshAll), centers: () => renderCenters(content), groups: () => renderWorkGroups(content), users: () => renderUsers(content), roles: () => renderRoles(content),
        apps: () => renderAppsAdmin(content, refreshApps), design: () => renderFormDesigner(content, c), settings: () => renderSettings(content), audit: () => renderAudit(content) };
      if (views[b]) return await views[b]();
    }
    renderHome();
  } catch (e) { clear(content, h('div.empty', h('div.big', '⚠️'), h('p', e.message))); }
}

/** Apps con asistente por voz que puede usar este usuario (solo usuarios marcados como invidentes). */
function voiceApps() {
  if (!state.me.accessible) return [];
  return state.apps.filter((a) => a.voice_fields && a.voice_fields !== '[]' && a.perms && a.perms.create);
}

function renderHome() {
  const company = state.me.companies.find((c) => c.id === state.companyId);
  clear(content,
    h('div.page-head', h('div.title', h('div', h('h1', `Hola, ${state.me.name.split(' ')[0]}`), h('div.muted', company ? company.name : 'Sin empresa asignada')))),
    voiceApps().length ? h('div.row', { style: { marginBottom: '16px' } }, voiceApps().map((a) => h('a.btn.primary.voice-start', { href: '#/voz/' + a.key }, `📞 Recoger ${a.name.toLowerCase()} por voz`))) : null,
    state.apps.length ? h('div.grid-cards', state.apps.map((a) => h('a.card.app-card', { href: '#/app/' + a.key },
      h('div.top', h('div.app-ico', { style: { width: '44px', height: '44px', borderRadius: '12px', display: 'grid', placeItems: 'center', fontSize: '22px', background: a.color + '22' } }, a.icon), h('span.big', a.count)),
      h('div', h('h2', a.name), h('div.muted.small', a.description || '')), homeStats(a)))) :
      h('div.card.empty', h('div.big', '🔒'), h('p', 'No tienes acceso a ninguna aplicación en esta empresa.'), h('p.muted.small', 'Pide a un administrador que te asigne un rol.')));
}

/** Resumen en la tarjeta de inicio: abiertos, vencidos y míos (al pulsar, abre la lista ya filtrada). */
function homeStats(a) {
  const s = a.stats || {};
  const go = (view) => (e) => {
    e.preventDefault(); e.stopPropagation();
    try {
      const k = `view:${a.key}`; const cur = JSON.parse(sessionStorage.getItem(k) || '{}');
      sessionStorage.setItem(k, JSON.stringify({ ...cur, q: '', filters: {}, view: 'list', state: '', mine: false, overdue: false, ...view }));
    } catch { /* sin almacenamiento */ }
    location.hash = '#/app/' + a.key;
  };
  const items = [
    s.open !== undefined ? h('span.chip', { onclick: go({ state: 'open' }) }, `${s.open} abierto${s.open === 1 ? '' : 's'}`) : null,
    s.overdue ? h('span.chip.danger', { onclick: go({ state: s.open !== undefined ? 'open' : '', overdue: true }) }, `⚠ ${s.overdue} vencido${s.overdue === 1 ? '' : 's'}`) : null,
    s.mine ? h('span.chip', { onclick: go({ state: s.open !== undefined ? 'open' : '', mine: true }) }, `👤 ${s.mine} mío${s.mine === 1 ? '' : 's'}`) : null,
  ].filter(Boolean);
  return items.length ? h('div.home-stats', items) : null; // forman parte del texto del enlace de la tarjeta
}

/** Preferencias de accesibilidad (se guardan en este navegador). */
function openA11y() {
  const p = getPrefs();
  const text = h('select', [['normal', 'Normal'], ['lg', 'Grande (115 %)'], ['xl', 'Muy grande (130 %)'], ['xxl', 'Enorme (150 %)']]
    .map(([v, l]) => h('option', { value: v, selected: p.text === v }, l)));
  const cb = (k, label, help) => {
    const i = h('input', { type: 'checkbox', checked: !!p[k], 'aria-describedby': null });
    return [h('label.check', i, label), help ? h('div.help', { style: { marginLeft: '26px', marginTop: '-6px' } }, help) : null, i];
  };
  const [cLbl, cHelp, contrast] = cb('contrast', 'Alto contraste', 'Texto negro sobre blanco, bordes marcados y foco muy visible.');
  const [lLbl, , links] = cb('links', 'Subrayar enlaces');
  const [mLbl, , motion] = cb('motion', 'Quitar animaciones');
  const apply = () => setPrefs({ text: text.value, contrast: contrast.checked, links: links.checked, motion: motion.checked });
  [text, contrast, links, motion].forEach((x) => x.addEventListener('change', apply));
  modal({
    title: '♿ Accesibilidad', size: 'sm',
    content: h('div.stack',
      h('div.field', h('label', 'Tamaño del texto'), text), cLbl, cHelp, lLbl, mLbl,
      h('h3', 'Lector de pantalla y teclado'),
      h('ul.small', { style: { margin: 0, paddingLeft: '18px' } },
        h('li', 'Funciona con NVDA, JAWS, Narrador (Windows), VoiceOver (Mac, iPhone) y TalkBack (Android).'),
        h('li', 'Tab / Mayús+Tab recorren los controles; Intro abre; Esc cierra ventanas y menús.'),
        h('li', 'En las listas, cada fila tiene un botón «Abrir»; los encabezados de columna ordenan con Intro.'),
        h('li', 'Para firmar sin dibujar, usa «Firmar escribiendo el nombre».'),
        h('li', 'Los cambios se guardan en este navegador.'))),
    footer: [h('button.btn', { onclick: () => { setPrefs({}); announce('Preferencias restablecidas'); text.value = 'normal'; [contrast, links, motion].forEach((x) => { x.checked = false; }); } }, 'Restablecer'), h('div.spacer')],
  });
}

function changePassword(forced) {
  const name = h('input', { value: state.me.name });
  const phone = h('input', { type: 'tel', value: state.me.phone || '' });
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const n1 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Mínimo 8 caracteres' });
  const n2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const m = modal({
    title: forced ? 'Cambia tu contraseña' : 'Mi perfil', size: 'sm',
    content: h('div.stack', forced ? h('p.muted', 'Por seguridad debes establecer una contraseña nueva antes de continuar.') : [h('div.field', h('label', 'Nombre'), name), h('div.field', h('label', 'Teléfono'), phone), h('h3', 'Cambiar contraseña')],
      state.me.password_managed === 'radius' && !forced ? h('p.muted.small', '🔐 Tu contraseña es la de la red de la organización (RADIUS): se cambia allí, no en esta aplicación.')
        : [h('div.field', h('label', 'Contraseña actual'), cur), h('div.field', h('label', 'Nueva contraseña'), n1), h('div.field', h('label', 'Repite la nueva'), n2)]),
    footer: [h('div.spacer'), forced ? null : h('button.btn', { onclick: () => m.close() }, 'Cancelar'), h('button.btn.primary', { onclick: async () => {
      if (n1.value !== n2.value) return toast('Las contraseñas no coinciden', 'error');
      if (forced && !n1.value) return toast('Introduce una contraseña nueva', 'error');
      try {
        await api('/me', { method: 'PUT', body: forced ? { current_password: cur.value, new_password: n1.value } : { name: name.value, phone: phone.value, current_password: cur.value, new_password: n1.value || undefined } });
        toast('Perfil actualizado', 'ok'); state.me.must_change_password = false; forced = false; m.close();
      } catch (e) { toastErr(e); }
    } }, 'Guardar')],
    onClose: () => { if (forced && state.me.must_change_password) setTimeout(() => changePassword(true), 0); },
  });
}

boot();
