// Arranque, inicio de sesión, menú lateral y enrutado.
import { api, h, clear, toast, toastErr, state, modal } from './core.js';
import { renderApp } from './records.js';
import { renderCompanies, renderCenters, renderUsers, renderRoles, renderAppsAdmin, renderSettings, renderAudit } from './admin.js';

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
  buildShell();
  await refreshApps();
  window.addEventListener('hashchange', route);
  route();
  if (state.me.must_change_password) changePassword(true);
}

function renderLogin() {
  const email = h('input', { type: 'email', autocomplete: 'username', placeholder: 'usuario@empresa.com', required: true });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const err = h('p.error', { hidden: true });
  const btn = h('button.btn.primary.block', { type: 'submit' }, 'Entrar');
  document.body.classList.add('center-page');
  clear(root, h('form.card.login-card', {
    onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; err.hidden = true;
      try { await api('/login', { method: 'POST', body: { email: email.value, password: pass.value } }); document.body.classList.remove('center-page'); location.hash = '#/'; boot(); }
      catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
    },
  }, h('div.brand', { style: { padding: 0 } }, h('div.logo', 'G'), 'Gestión de Aplicaciones'),
  h('p.muted', 'Accede con tu usuario corporativo.'),
  h('div.field', h('label', 'Email'), email), h('div.field', h('label', 'Contraseña'), pass), err, btn));
}

function buildShell() {
  document.body.classList.remove('center-page');
  nav = h('nav.nav');
  content = h('main.content');
  const companySel = state.me.companies.length > 1
    ? h('select.company-select', { onchange: (e) => { state.companyId = Number(e.target.value); localStorage.setItem('companyId', state.companyId); refreshApps().then(route); } },
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
      h('button.btn.sm.ghost', { title: 'Cerrar sesión', onclick: async () => { await api('/logout', { method: 'POST' }); location.reload(); } }, '⎋ Salir')));
  const sidebar = h('aside.sidebar', h('div.brand', h('div.logo', 'G'), h('span', state.me.app_name)), companySel, nav, userMenu);
  const topbar = h('header.topbar', h('button.btn.ghost.icon', { onclick: () => shell.classList.toggle('nav-open') }, '☰'), h('strong', state.me.app_name));
  shell = h('div.shell', sidebar, h('div.backdrop', { onclick: () => shell.classList.remove('nav-open') }), h('div.main', topbar, content));
  clear(root, shell);
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
  const link = (href, ico, label, extra, color) => h('a', { href, class: cur === href || (href !== '#/' && cur.startsWith(href + '/')) ? 'active' : '', onclick: () => shell.classList.remove('nav-open') },
    h('span.ico', { style: color ? { background: color + '22' } : {} }, ico), h('span', label), extra != null ? h('span.count', extra) : null);
  clear(nav,
    link('#/', '🏠', 'Inicio'),
    state.apps.length ? h('div.section', 'Aplicaciones') : null,
    state.apps.map((a) => link('#/app/' + a.key, a.icon || '📁', a.name, a.count, a.color)),
    state.me.is_superadmin ? [h('div.section', 'Super admin'),
      link('#/admin/companies', '🏢', 'Empresas'), link('#/admin/centers', '📍', 'Centros'), link('#/admin/users', '👥', 'Usuarios'),
      link('#/admin/roles', '🛡️', 'Roles y políticas'), link('#/admin/apps', '🧩', 'Apps y campos'), link('#/admin/audit', '🕘', 'Auditoría'), link('#/admin/settings', '⚙️', 'Ajustes')] : null);
}

async function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [a, b] = hash.split('/');
  drawNav();
  clear(content, h('p.muted', 'Cargando…'));
  try {
    if (a === 'app' && b) return await renderApp(content, b, refreshApps);
    if (a === 'admin' && state.me.is_superadmin) {
      const refreshAll = async () => { state.me = await api('/me'); buildShell(); await refreshApps(); route(); };
      const views = { companies: () => renderCompanies(content, refreshAll), centers: () => renderCenters(content), users: () => renderUsers(content), roles: () => renderRoles(content),
        apps: () => renderAppsAdmin(content, refreshApps), settings: () => renderSettings(content), audit: () => renderAudit(content) };
      if (views[b]) return await views[b]();
    }
    renderHome();
  } catch (e) { clear(content, h('div.empty', h('div.big', '⚠️'), h('p', e.message))); }
}

function renderHome() {
  const company = state.me.companies.find((c) => c.id === state.companyId);
  clear(content,
    h('div.page-head', h('div.title', h('div', h('h1', `Hola, ${state.me.name.split(' ')[0]}`), h('div.muted', company ? company.name : 'Sin empresa asignada')))),
    state.apps.length ? h('div.grid-cards', state.apps.map((a) => h('a.card.app-card', { href: '#/app/' + a.key },
      h('div.top', h('div.app-ico', { style: { width: '44px', height: '44px', borderRadius: '12px', display: 'grid', placeItems: 'center', fontSize: '22px', background: a.color + '22' } }, a.icon), h('span.big', a.count)),
      h('div', h('h2', a.name), h('div.muted.small', a.description || ''))))) :
      h('div.card.empty', h('div.big', '🔒'), h('p', 'No tienes acceso a ninguna aplicación en esta empresa.'), h('p.muted.small', 'Pide a un administrador que te asigne un rol.')));
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
      h('div.field', h('label', 'Contraseña actual'), cur), h('div.field', h('label', 'Nueva contraseña'), n1), h('div.field', h('label', 'Repite la nueva'), n2)),
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
