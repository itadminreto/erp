'use strict';
const { get, run, all, tx } = require('./db');
const { hash, PERMS } = require('./auth');

const APPS = [
  {
    key: 'credenciales', name: 'Credenciales', icon: '🔑', color: '#6366f1', title: 'servicio',
    description: 'Usuarios y contraseñas de servicios, webs y plataformas',
    fields: [
      ['servicio', 'Servicio / plataforma', 'text', { required: 1 }],
      ['url', 'URL de acceso', 'url'],
      ['usuario', 'Usuario', 'text'],
      ['password', 'Contraseña', 'password'],
      ['email_asociado', 'Email asociado', 'email'],
      ['categoria', 'Categoría', 'select', { choices: ['Web', 'Software', 'Banca', 'Administración', 'Proveedor', 'Otro'] }],
      ['responsable', 'Responsable', 'user'],
      ['caducidad', 'Caducidad', 'date'],
      ['notas', 'Notas', 'textarea', { width: 'full', show_in_list: 0 }],
    ],
  },
  {
    key: 'correo', name: 'Correo', icon: '✉️', color: '#0ea5e9', title: 'direccion',
    description: 'Buzones, alias y listas de correo',
    fields: [
      ['direccion', 'Dirección de correo', 'email', { required: 1, unique_value: 1 }],
      ['titular', 'Titular', 'text'],
      ['tipo', 'Tipo', 'select', { choices: ['Personal', 'Compartido', 'Alias', 'Lista de distribución'] }],
      ['proveedor', 'Proveedor', 'select', { choices: ['Microsoft 365', 'Google Workspace', 'Hosting propio', 'Otro'] }],
      ['password', 'Contraseña', 'password'],
      ['cuota_gb', 'Cuota (GB)', 'number'],
      ['alias', 'Alias / redirecciones', 'textarea', { width: 'full', show_in_list: 0 }],
      ['activo', 'Activo', 'checkbox'],
    ],
  },
  {
    key: 'fibras', name: 'Fibras', icon: '🌐', color: '#10b981', title: 'ubicacion',
    description: 'Conexiones de fibra / internet por ubicación',
    fields: [
      ['ubicacion', 'Ubicación', 'text', { required: 1 }],
      ['operador', 'Operador', 'select', { choices: ['Movistar', 'Vodafone', 'Orange', 'Digi', 'MásMóvil', 'Otro'] }],
      ['num_contrato', 'Nº contrato', 'text'],
      ['velocidad_mb', 'Velocidad (Mb)', 'number'],
      ['ip_fija', 'IP fija', 'text'],
      ['router_usuario', 'Usuario router', 'text', { show_in_list: 0 }],
      ['router_password', 'Contraseña router', 'password', { show_in_list: 0 }],
      ['wifi_ssid', 'WiFi SSID', 'text'],
      ['wifi_password', 'Contraseña WiFi', 'password'],
      ['cuota_mensual', 'Cuota mensual (€)', 'decimal'],
      ['fecha_alta', 'Fecha de alta', 'date'],
      ['permanencia_hasta', 'Permanencia hasta', 'date'],
    ],
  },
  {
    key: 'lineas', name: 'Líneas', icon: '📱', color: '#f59e0b', title: 'numero',
    description: 'Líneas móviles, fijas y de datos',
    fields: [
      ['numero', 'Número', 'phone', { required: 1, unique_value: 1 }],
      ['titular', 'Titular / usuario', 'user'],
      ['tipo', 'Tipo', 'select', { choices: ['Móvil', 'Fijo', 'Datos', 'Centralita'] }],
      ['operador', 'Operador', 'select', { choices: ['Movistar', 'Vodafone', 'Orange', 'Digi', 'MásMóvil', 'Otro'] }],
      ['tarifa', 'Tarifa', 'text'],
      ['extension', 'Extensión', 'text'],
      ['icc', 'ICC (SIM)', 'text', { show_in_list: 0 }],
      ['pin', 'PIN', 'password', { show_in_list: 0 }],
      ['puk', 'PUK', 'password', { show_in_list: 0 }],
      ['terminal', 'Terminal', 'text'],
      ['imei', 'IMEI', 'text', { show_in_list: 0 }],
      ['fecha_alta', 'Fecha de alta', 'date'],
    ],
  },
  {
    key: 'vehiculos', name: 'Vehículos', icon: '🚐', color: '#ef4444', title: 'matricula',
    description: 'Flota de vehículos, ITV, seguros y tarjetas',
    fields: [
      ['matricula', 'Matrícula', 'text', { required: 1, unique_value: 1 }],
      ['marca', 'Marca', 'text'],
      ['modelo', 'Modelo', 'text'],
      ['tipo', 'Tipo', 'select', { choices: ['Turismo', 'Furgoneta', 'Camión', 'Moto', 'Otro'] }],
      ['bastidor', 'Nº bastidor', 'text', { show_in_list: 0 }],
      ['fecha_matriculacion', 'Fecha matriculación', 'date', { show_in_list: 0 }],
      ['itv_proxima', 'Próxima ITV', 'date'],
      ['seguro_compania', 'Aseguradora', 'text', { show_in_list: 0 }],
      ['seguro_poliza', 'Nº póliza', 'text', { show_in_list: 0 }],
      ['seguro_vencimiento', 'Vencimiento seguro', 'date'],
      ['km', 'Kilómetros', 'number'],
      ['conductor', 'Conductor habitual', 'user'],
      ['tarjeta_combustible', 'Tarjeta combustible', 'text', { show_in_list: 0 }],
      ['pin_tarjeta', 'PIN tarjeta', 'password', { show_in_list: 0 }],
    ],
  },
  {
    key: 'recados', name: 'Recados', icon: '📋', color: '#8b5cf6', title: 'titulo',
    description: 'Tareas, encargos y recados internos',
    fields: [
      ['titulo', 'Título', 'text', { required: 1, width: 'full' }],
      ['descripcion', 'Descripción', 'textarea', { width: 'full', show_in_list: 0 }],
      ['solicitante', 'Solicitante', 'user'],
      ['asignado_a', 'Asignado a', 'user'],
      ['prioridad', 'Prioridad', 'select', { choices: ['Baja', 'Media', 'Alta', 'Urgente'] }],
      ['estado', 'Estado', 'select', { choices: ['Pendiente', 'En curso', 'Hecho', 'Cancelado'] }],
      ['fecha_limite', 'Fecha límite', 'date'],
      ['fecha_realizado', 'Fecha realizado', 'date', { show_in_list: 0 }],
    ],
  },
];

const ROLES = [
  ['Admin centro', 'Control total de sus centros: ve y envía contraseñas, papelera, importación/exportación', PERMS.filter((p) => p !== 'purge')],
  ['Editor', 'Consulta, alta y modificación de registros; exportación', ['view', 'create', 'edit', 'export', 'view_history']],
  ['Consulta', 'Solo lectura', ['view']],
];

function seed() {
  if (get('SELECT COUNT(*) n FROM users').n > 0) return;
  tx(() => {
    const email = process.env.ADMIN_EMAIL || 'admin@erp.local';
    const pass = process.env.ADMIN_PASSWORD || 'admin1234';
    run(`INSERT INTO users (email, name, password_hash, is_superadmin, must_change_password) VALUES (?,?,?,1,?)`,
      email, 'Super Administrador', hash(pass), process.env.ADMIN_PASSWORD ? 0 : 1);
    console.log(`\n  ➜ Super admin creado: ${email} / ${pass}  (cámbiala tras el primer acceso)\n`);

    APPS.forEach((a, i) => {
      const appId = Number(run('INSERT INTO apps (key, name, icon, color, description, sort, title_field) VALUES (?,?,?,?,?,?,?)',
        a.key, a.name, a.icon, a.color, a.description, i, a.title).lastInsertRowid);
      a.fields.forEach(([key, label, type, o = {}], j) => {
        const { choices, ...rest } = o;
        run(`INSERT INTO fields (app_id, key, label, type, options, required, unique_value, show_in_list, width, sort)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
          appId, key, label, type, choices ? JSON.stringify({ choices }) : null,
          rest.required || 0, rest.unique_value || 0, rest.show_in_list ?? 1,
          rest.width || (type === 'textarea' ? 'full' : 'half'), j);
      });
    });

    const apps = all('SELECT id FROM apps');
    for (const [name, desc, perms] of ROLES) {
      const roleId = Number(run('INSERT INTO roles (name, description) VALUES (?,?)', name, desc).lastInsertRowid);
      for (const app of apps) {
        const cols = PERMS.map((p) => 'can_' + p);
        run(`INSERT INTO role_permissions (role_id, app_id, ${cols.join(',')}) VALUES (?,?,${cols.map(() => '?').join(',')})`,
          roleId, app.id, ...PERMS.map((p) => (perms.includes(p) ? 1 : 0)));
      }
    }

    if (process.env.SEED_DEMO !== '0') {
      const cid = Number(run(`INSERT INTO companies (name, cif) VALUES ('Empresa Demo', 'B00000000')`).lastInsertRowid);
      run(`INSERT INTO centers (company_id, code, name, kind) VALUES (?, 'CC01', 'Sede central', 'ambos')`, cid);
      run(`INSERT INTO centers (company_id, code, name, kind) VALUES (?, 'CC02', 'Centro Norte', 'trabajo')`, cid);
    }
  });
}

module.exports = { seed };
