// Panel del sistema en el inicio del super admin: tarjetas que se actualizan solas y se pueden elegir y ordenar.
import { api, h, clear, toast, toastErr, modal, confirmDlg, fmtDateTime, announce } from './core.js';

const WIDGETS = {
  database: { title: 'Base de datos', icon: '🗄️' },
  server: { title: 'Servidor', icon: '🖥️' },
  disk: { title: 'Disco', icon: '💽' },
  sessions: { title: 'Usuarios conectados', icon: '🟢', wide: true },
  activity: { title: 'Actividad (24 h)', icon: '📈' },
  backups: { title: 'Copias de seguridad', icon: '💾' },
};
const PREF = 'sysPanel';
const prefs = () => { try { return { order: Object.keys(WIDGETS), hidden: [], refresh: true, onlineOnly: true, ...JSON.parse(localStorage.getItem(PREF) || '{}') }; } catch { return { order: Object.keys(WIDGETS), hidden: [], refresh: true, onlineOnly: true }; } };
const savePrefs = (p) => { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch { /* nada */ } };

// ---------- formatos ----------
const bytes = (n) => { n = Number(n) || 0; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1).replace('.', ',')} ${u[i]}`; };
const dur = (s) => { s = Math.floor(Number(s) || 0); const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d} d ${hh} h` : hh ? `${hh} h ${m} min` : `${m} min`; };
const ago = (s) => (s === null || s === undefined ? '—' : s < 60 ? 'ahora mismo' : `hace ${dur(s)}`);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const bar = (used, total, label) => {
  const p = pct(used, total);
  return h('div.sys-bar', { role: 'img', 'aria-label': `${label}: ${p} % usado (${bytes(used)} de ${bytes(total)})` },
    h('div.sys-bar-fill', { class: p >= 90 ? 'danger' : p >= 75 ? 'warn' : '', style: { width: `${p}%` } }));
};
const kv = (rows) => h('dl.sys-kv', rows.filter(Boolean).map(([k, v]) => [h('dt', k), h('dd', v ?? '—')]));
/** «Chrome 120 · Windows» a partir del user-agent. */
function device(ua = '') {
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
  const o = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return o ? `${b} · ${o}` : b;
}

export async function renderSystemPanel(container) {
  let data = null, timer = null, showAll = false;
  const p = prefs();
  const grid = h('div.sys-grid');
  const stamp = h('span.muted.small', { 'aria-live': 'off' });
  const refreshCb = h('input', { type: 'checkbox', checked: p.refresh, onchange: () => { const q = prefs(); q.refresh = refreshCb.checked; savePrefs(q); schedule(); } });
  clear(container,
    h('div.sys-head', h('h2', '🛠 Estado del sistema'), h('div.spacer'), stamp,
      h('label.check.small', refreshCb, 'Actualizar cada 30 s'),
      h('button.btn.sm', { onclick: () => load(true) }, '↻ Actualizar'),
      h('button.btn.sm', { onclick: customize }, '⚙ Personalizar')),
    grid);

  function schedule() {
    clearInterval(timer);
    if (prefs().refresh) timer = setInterval(() => { if (!document.body.contains(grid)) return clearInterval(timer); if (!document.hidden && !document.querySelector('.modal-bg')) load(); }, 30e3);
  }
  async function load(manual = false) {
    try {
      data = await api('/admin/system');
      draw();
      stamp.textContent = `Actualizado ${new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      if (manual) announce('Estado del sistema actualizado');
    } catch (e) { if (manual) toastErr(e); }
  }

  function card(key, ...body) {
    const w = WIDGETS[key];
    return h('section.card.sys-card', { class: w.wide ? 'wide' : '', 'aria-labelledby': `sys-${key}` },
      h('h3.sys-title', { id: `sys-${key}` }, h('span', { 'aria-hidden': 'true' }, w.icon), ' ', w.title), body);
  }

  const W = {
    server(d) {
      const s = d.server, m = s.memory;
      const load1 = s.load[0];
      return card('server',
        h('div.sys-big', `${pct(m.used, m.total)} %`, h('small', ' memoria usada')), bar(m.used, m.total, 'Memoria'),
        h('div.muted.small', `${bytes(m.used)} de ${bytes(m.total)} · libres ${bytes(m.available)}`),
        kv([['Equipo', s.hostname], ['Sistema', s.platform], ['Encendido', dur(s.uptime)], ['Aplicación', `v${s.app_version} · ${dur(s.process_uptime)} sin reiniciar`],
          ['CPU', `${s.cpus} núcleos · carga ${s.load.map((x) => x.toFixed(2).replace('.', ',')).join(' / ')}`],
          ['Memoria del ERP', bytes(m.process_rss)], ['Node.js', s.node]]),
        load1 > s.cpus ? h('div.chip.warn', '⚠ Carga alta del procesador') : null);
    },
    disk(d) {
      const k = d.disk.data;
      const same = d.disk.root && d.disk.root.total === k.total && d.disk.root.free === k.free;
      return card('disk',
        k.error ? h('p.error', k.error) : [h('div.sys-big', `${pct(k.used, k.total)} %`, h('small', ' ocupado')), bar(k.used, k.total, 'Disco de datos'),
          h('div.muted.small', `Libres ${bytes(k.free)} de ${bytes(k.total)}`)],
        !same && d.disk.root && !d.disk.root.error ? [h('div.small', { style: { marginTop: '8px' } }, 'Disco del sistema (/)'), bar(d.disk.root.used, d.disk.root.total, 'Disco del sistema'),
          h('div.muted.small', `Libres ${bytes(d.disk.root.free)} de ${bytes(d.disk.root.total)}`)] : null,
        kv([['Carpeta de datos', k.path], ['Ocupa la carpeta', bytes(d.disk.data_dir_size)], ['Copias de seguridad', bytes(d.disk.backups_size)]]),
        k.free < 2 * 1024 ** 3 ? h('div.chip.danger', '⚠ Queda poco espacio en disco') : null);
    },
    database(d) {
      const b = d.database, c = b.counts;
      return card('database',
        h('div.sys-big', bytes(b.size), h('small', ` · ${b.name}`)),
        kv([['Versión', b.version], ['Encendida', dur(b.uptime)], ['Conexiones', `${b.connections} ahora · máx. usadas ${b.max_used}${b.max_connections ? ` de ${b.max_connections}` : ''}`],
          ['Registros', `${c.records.toLocaleString('es-ES')} (+${c.trash} en papelera)`], ['Imágenes y firmas', `${c.files} · ${bytes(c.files_size)}`],
          ['Auditoría', `${c.audit.toLocaleString('es-ES')} eventos`], ['Usuarios activos', c.users], ['Empresas', c.companies],
          b.slow_queries ? ['Consultas lentas', b.slow_queries] : null]),
        h('details.sys-details', h('summary', 'Tablas más grandes'),
          h('table.data.sys-mini', h('tbody', b.tables.slice(0, 8).map((t) => h('tr', h('td', t.name), h('td.num', bytes(t.size)), h('td.num.muted', `${t.rows.toLocaleString('es-ES')} filas`)))))));
    },
    activity(d) {
      const a = d.activity.actions;
      const n = (k) => a[k] || 0;
      return card('activity',
        h('div.sys-stats', [['Accesos', n('login'), ''], ['Fallidos', n('login_failed'), n('login_failed') ? 'danger' : ''], ['Altas', n('create'), ''], ['Cambios', n('update'), ''],
          ['Papelera', n('delete'), ''], ['Contraseñas vistas', n('reveal'), n('reveal') ? 'warn' : ''], ['Exportaciones', n('export'), ''], ['Correos', n('email'), '']]
          .map(([l, v, c]) => h('div.sys-stat', { class: c }, h('strong', String(v)), h('span', l)))),
        d.activity.by_app.length ? h('div.small', { style: { marginTop: '8px' } }, 'Más movimiento: ', d.activity.by_app.map((x) => `${x.name} (${x.n})`).join(' · ')) : null,
        d.activity.failed.length ? h('details.sys-details', h('summary', 'Últimos accesos fallidos'),
          h('ul.small', d.activity.failed.map((f) => h('li', `${fmtDateTime(f.ts)} · ${f.summary.replace(/^Acceso fallido: /, '')}${f.ip ? ` · ${f.ip}` : ''}`)))) : null,
        h('a.small', { href: '#/admin/audit' }, 'Ver auditoría →'));
    },
    backups(d) {
      const b = d.backups;
      return card('backups',
        b.last ? [h('div.sys-big', ago((Date.now() - new Date(b.last.created_at).getTime()) / 1000).replace(/^hace /, ''), h('small', ' desde la última')),
          kv([['Última', `${fmtDateTime(b.last.created_at)} · ${b.last.kind_label || b.last.kind} · ${bytes(b.last.size)}`], ['Copias guardadas', b.count], ['Automáticas', b.auto ? 'Sí, cada noche' : 'No']])]
          : h('p.chip.warn', '⚠ No hay ninguna copia de seguridad'),
        b.last && Date.now() - new Date(b.last.created_at).getTime() > 2 * 864e5 ? h('div.chip.warn', '⚠ Hace más de 2 días de la última copia') : null,
        h('div.row', { style: { marginTop: '8px' } },
          h('button.btn.sm', { onclick: async (e) => {
            e.currentTarget.disabled = true;
            try { await api('/admin/backups', { method: 'POST' }); toast('Copia de seguridad creada', 'ok'); load(); } catch (err) { toastErr(err); } finally { e.target.disabled = false; }
          } }, '💾 Hacer copia ahora'), h('a.btn.sm.ghost', { href: '#/admin/settings' }, 'Gestionar →')));
    },
    sessions(d) {
      const q = prefs();
      const all = d.sessions.filter((s) => !q.onlineOnly || s.online);
      const list = showAll ? all : all.slice(0, 10);
      const online = d.sessions.filter((s) => s.online);
      const users = new Set(online.map((s) => s.user_id));
      const only = h('input', { type: 'checkbox', checked: q.onlineOnly, onchange: () => { const x = prefs(); x.onlineOnly = only.checked; savePrefs(x); draw(); } });
      const hours = h('input', { id: 'sess-hours', type: 'number', min: 1, max: 2160, value: d.session_config.hours, style: { width: '90px' } });
      const idle = h('input', { id: 'sess-idle', type: 'number', min: 0, max: 1440, value: d.session_config.idle_minutes, style: { width: '90px' } });
      const kill = async (s) => {
        if (!(await confirmDlg(s.current ? 'Es tu sesión actual: se cerrará y tendrás que volver a entrar. ¿Continuar?' : `¿Desconectar a ${s.name} (${device(s.user_agent)}, ${s.ip || 'IP desconocida'})?`, { danger: true, ok: 'Desconectar' }))) return;
        try { await api(`/admin/sessions/${s.id}`, { method: 'DELETE' }); toast(`${s.name} desconectado`, 'ok'); if (s.current) location.reload(); else load(); } catch (e) { toastErr(e); }
      };
      const killAll = async (s) => {
        if (!(await confirmDlg(`¿Cerrar todas las sesiones de ${s.name} en todos sus dispositivos?${s.user_id === d.me_id ? ' (la tuya actual se mantiene)' : ''}`, { danger: true, ok: 'Desconectar todas' }))) return;
        try { const r = await api(`/admin/users/${s.user_id}/sessions`, { method: 'DELETE' }); toast(`${r.closed} sesión(es) cerrada(s)`, 'ok'); load(); } catch (e) { toastErr(e); }
      };
      return card('sessions',
        h('div.sys-stats', h('div.sys-stat.ok', h('strong', String(users.size)), h('span', 'usuarios en línea')),
          h('div.sys-stat', h('strong', String(online.length)), h('span', 'sesiones activas (5 min)')),
          h('div.sys-stat', h('strong', String(d.sessions.length)), h('span', 'sesiones abiertas'))),
        h('div.row', { style: { margin: '8px 0', gap: '10px' } }, h('label.check.small', only, 'Solo en línea'),
          h('button.btn.sm.ghost', { title: 'Cierra las sesiones sin actividad en las últimas 24 horas', onclick: async () => {
            if (!(await confirmDlg('¿Cerrar todas las sesiones sin actividad en las últimas 24 horas? Esas personas tendrán que volver a entrar.', { ok: 'Cerrar inactivas' }))) return;
            try { const r = await api('/admin/sessions?idle_hours=24', { method: 'DELETE' }); toast(`${r.closed} sesión(es) inactiva(s) cerrada(s)`, 'ok'); load(); } catch (e) { toastErr(e); }
          } }, '🧹 Cerrar inactivas (+24 h)'),
          h('div.spacer'),
          h('label.small', { for: 'sess-hours' }, 'Duración máx. (h)'), hours, h('label.small', { for: 'sess-idle' }, 'Cerrar tras inactividad (min, 0 = no)'), idle,
          h('button.btn.sm', { onclick: async () => {
            try { await api('/admin/settings', { method: 'PUT', body: { session_hours: hours.value, session_idle_minutes: idle.value } }); toast('Sesiones: ajustes guardados (la duración se aplica a los nuevos accesos)', 'ok'); } catch (e) { toastErr(e); }
          } }, 'Guardar')),
        list.length ? h('div.table-wrap', h('table.data.sys-sessions',
          h('caption.sr-only', 'Sesiones abiertas'),
          h('thead', h('tr', ['', 'Usuario', 'IP', 'Dispositivo', 'Inicio', 'Última actividad', 'Caduca', h('span.sr-only', 'Acciones')].map((t) => h('th.nosort', { scope: 'col' }, t)))),
          h('tbody', list.map((s) => h('tr', { style: { cursor: 'default' } },
            h('td', h('span.sys-dot', { class: s.online ? 'on' : '', 'aria-hidden': 'true' }), h('span.sr-only', s.online ? 'En línea' : 'Inactivo')),
            h('td', h('strong', s.name), s.current ? h('span.chip.ok', { style: { marginLeft: '6px' } }, 'tú') : null, s.is_superadmin ? h('span.chip.warn', { style: { marginLeft: '6px' } }, 'admin') : null, h('div.muted.small', s.email)),
            h('td.small', s.ip || '—'), h('td.small', { title: s.user_agent || '' }, device(s.user_agent)),
            h('td.small', s.created_at ? fmtDateTime(s.created_at) : '—'), h('td.small', ago(s.idle_s)), h('td.small', fmtDateTime(s.expires_at)),
            h('td.actions', h('div.btn-group', { style: { flexWrap: 'nowrap' } },
              h('button.btn.sm.danger', { 'aria-label': `Desconectar a ${s.name} (${device(s.user_agent)})`, onclick: () => kill(s) }, '⏏ Desconectar'),
              h('button.btn.sm.ghost', { title: 'Cerrar todas sus sesiones', 'aria-label': `Desconectar a ${s.name} de todos sus dispositivos`, onclick: () => killAll(s) }, 'Todas'))))))))
          : h('p.muted', 'No hay sesiones' + (q.onlineOnly ? ' en línea.' : '.')),
        all.length > 10 ? h('button.btn.sm.ghost', { style: { alignSelf: 'flex-start' }, onclick: () => { showAll = !showAll; draw(); } },
          showAll ? 'Ver menos' : `Ver todas (${all.length})`) : null);
    },
  };

  function draw() {
    if (!data) return;
    const q = prefs();
    const order = [...q.order.filter((k) => W[k]), ...Object.keys(WIDGETS).filter((k) => !q.order.includes(k))];
    const open = [...grid.querySelectorAll('details[open] > summary')].map((x) => x.textContent);
    clear(grid, order.filter((k) => !q.hidden.includes(k)).map((k) => { try { return W[k](data); } catch (e) { return card(k, h('p.error', e.message)); } }));
    grid.querySelectorAll('details > summary').forEach((s) => { if (open.includes(s.textContent)) s.parentElement.open = true; });
  }

  function customize() {
    const q = prefs();
    const order = [...q.order.filter((k) => WIDGETS[k]), ...Object.keys(WIDGETS).filter((k) => !q.order.includes(k))];
    const list = h('div.sort-list', order.map((k) => h('div.sort-item', { dataset: { k } },
      h('label.check.grow', h('input', { type: 'checkbox', checked: !q.hidden.includes(k) }), `${WIDGETS[k].icon} ${WIDGETS[k].title}`),
      h('button.btn.ghost.sm', { type: 'button', 'aria-label': `Subir ${WIDGETS[k].title}`, onclick: (e) => { const it = e.currentTarget.parentElement; if (it.previousElementSibling) it.previousElementSibling.before(it); } }, '▲'),
      h('button.btn.ghost.sm', { type: 'button', 'aria-label': `Bajar ${WIDGETS[k].title}`, onclick: (e) => { const it = e.currentTarget.parentElement; if (it.nextElementSibling) it.nextElementSibling.after(it); } }, '▼'))));
    const m = modal({ title: '⚙ Personalizar el panel', size: 'sm', content: [h('p.muted.small', 'Elige qué tarjetas ver y en qué orden (se guarda en este navegador).'), list],
      footer: [h('button.btn.ghost', { onclick: () => { savePrefs({ ...prefs(), order: Object.keys(WIDGETS), hidden: [] }); m.close(); draw(); } }, 'Restablecer'), h('div.spacer'),
        h('button.btn.primary', { onclick: () => {
          const items = [...list.children];
          savePrefs({ ...prefs(), order: items.map((x) => x.dataset.k), hidden: items.filter((x) => !x.querySelector('input').checked).map((x) => x.dataset.k) });
          m.close(); draw();
        } }, 'Aplicar')] });
  }

  await load();
  schedule();
}
