'use strict';
// Estructura de Vehículos (flota por centro de coste, con traspasos) y sus subapartados Revisiones y Siniestros.
// Recoge los datos del antiguo programa de vehículos (Delphi / SQL Server). Se instala con importStructure().

const ASEGURADORAS = ['Allianz', 'AXA', 'AZ', 'BAS', 'Caser', 'Catalana Occidente', 'Caja de Seguros Reunidos', 'Estrella', 'Fidelidade', 'FIATC',
  'Generali', 'Helvetia', 'Liberty', 'Lagun Aro', 'Línea Directa', 'Lepanto', 'Mapfre', 'MAAF', 'Mutua Valenciana', 'Pelayo', 'Plus Ultra',
  'Reale', 'Sensación Segur', 'UMAS', 'Winterthur', 'Zurich'];
const TIPOS = ['Turismo', 'Furgoneta', 'Vehículo ligero', 'Vehículo pesado', 'Camión', 'Autobús', 'Motocicleta', 'Ciclomotor', 'Cuadriciclo',
  'Todo terreno', 'Cabeza tractora', 'Tractor', 'Remolque', 'Semirremolque', 'Portacontenedores', 'Matrimonios Cantabria'];
const UBICACIONES = ['Adarzo', 'Avilés', 'Bezana', 'Compra-venta', 'Castellón', 'Cianca', 'Clásico', 'Desguace', 'Ecoreto', 'Finca', 'Gijón', 'Granada',
  'León', 'Matris', 'Nave roja', 'Oviedo', 'Pas', 'Pas chicas', 'Pedrosa', 'Rastro Adarzo', 'Rasines', 'Rastro Boo', 'Rescate', 'Santander',
  'Sustitución', 'Taller mecánica desguace', 'Torrelavega'];
const PIEZAS = ['Bomba de agua', 'Correa auxiliar', 'Valvulina caja de cambio', 'Correa de distribución', 'Filtro de aceite', 'Filtro de aire',
  'Filtro caja automática', 'Filtro de gasoil', 'Filtro de habitáculo', 'Pastillas de freno', 'Engrase', 'Niveles', 'Válvulas'];

const f = (key, label, type, width = 'md', extra = {}) => ({ key, label, type, width, show_in_list: 0, required: 0, unique_value: 0, height: 1, options: {}, ...extra });
const sel = (choices) => ({ options: { choices } });
const list = { show_in_list: 1 };
const due = { options: { due_alert: true } };

const fields = [
  // Identificación
  f('matricula', 'Matrícula', 'text', 'sm', { required: 1, show_in_list: 1, unique_value: 1 }),
  f('marca', 'Marca', 'lookup', 'sm', { ...list, options: { list: 'vehiculo_marca' } }),
  f('modelo', 'Modelo', 'lookup', 'sm', { ...list, options: { list: 'vehiculo_modelo', depends_on: 'marca' } }),
  f('tipo', 'Tipo de vehículo', 'select', 'sm', { ...list, ...sel(TIPOS) }),
  f('bastidor', 'Nº bastidor', 'text', 'md'),
  f('titular', 'Titular', 'select', 'sm', { ...list, ...sel(['Asociación', 'Cooperativa', 'Particular']) }),
  f('fecha_matriculacion', 'Fecha matriculación', 'date', 'sm'),
  f('tara', 'Tara (kg)', 'number', 'xs'), f('pma', 'PMA (kg)', 'number', 'xs'),
  // Estado y ubicación
  f('estado', 'Estado', 'select', 'sm', { ...list, options: { choices: ['Activo', 'En venta', 'Baja'], colors: { Activo: '#10b981', 'En venta': '#0ea5e9', Baja: '#94a3b8' } } }),
  f('centro_trabajo', 'Centro de trabajo', 'center', 'md', { options: { kind: 'trabajo' } }),
  f('ubicacion', 'Ubicación', 'select', 'sm', sel(UBICACIONES)),
  f('fecha_asignacion', 'Asignado al centro desde', 'date', 'sm'),
  f('km', 'Kilómetros', 'number', 'sm'),
  f('conductor', 'Conductor habitual', 'user', 'md'),
  // Compra
  f('procedencia', 'Procedencia / proveedor', 'text', 'md'), f('fecha_compra', 'Fecha de compra', 'date', 'sm'),
  f('valor_compra', 'Valor de compra (€)', 'decimal', 'sm'), f('fecha_alta', 'Fecha de alta', 'date', 'sm'),
  // Seguro
  f('seguro_compania', 'Aseguradora', 'select', 'sm', sel(ASEGURADORAS)), f('seguro_poliza', 'Nº póliza', 'text', 'sm'),
  f('seguro_importe', 'Importe (€)', 'decimal', 'xs'), f('seguro_alta', 'Alta del seguro', 'date', 'sm'),
  f('seguro_vencimiento', 'Vencimiento seguro', 'date', 'sm', { ...due, show_in_list: 1 }),
  f('seguro_baja', 'Baja del seguro', 'date', 'sm'), f('seguro_motivo_baja', 'Motivo baja seguro', 'text', 'md'),
  // Tarjeta de transporte
  f('tarjeta_transporte', 'Nº tarjeta de transporte', 'text', 'sm'),
  f('tarjeta_ambito', 'Ámbito', 'select', 'sm', sel(['Servicio público pesado', 'Servicio particular', 'Viajeros particular', 'XPC', 'DL'])),
  f('tarjeta_alta', 'Alta tarjeta', 'date', 'sm'), f('tarjeta_vencimiento', 'Vencimiento tarjeta', 'date', 'sm', due),
  f('tarjeta_baja', 'Baja tarjeta', 'date', 'sm'), f('tarjeta_motivo_baja', 'Motivo baja tarjeta', 'text', 'md'),
  // ITV y combustible
  f('itv_proxima', 'Próxima ITV', 'date', 'sm', { ...due, show_in_list: 1 }),
  f('tarjeta_combustible', 'Tarjeta combustible', 'text', 'sm'), f('pin_tarjeta', 'PIN tarjeta', 'password', 'xs'),
  // Baja
  f('fecha_baja', 'Fecha de baja', 'date', 'sm'),
  f('motivo_baja', 'Motivo de baja', 'select', 'sm', sel(['Vendido', 'Definitiva', 'Temporal', 'Tránsito comunitario', 'Exportación', 'En venta', 'DE', 'VE'])),
  f('observaciones', 'Observaciones', 'textarea', 'full', { height: 2 }),
];
const sections = [
  ['Identificación', ['matricula', 'marca', 'modelo', 'tipo', 'bastidor', 'titular', 'fecha_matriculacion', 'tara', 'pma']],
  ['Estado y ubicación', ['estado', 'centro_trabajo', 'ubicacion', 'fecha_asignacion', 'km', 'conductor']],
  ['Compra', ['procedencia', 'fecha_compra', 'valor_compra', 'fecha_alta']],
  ['Seguro', ['seguro_compania', 'seguro_poliza', 'seguro_importe', 'seguro_alta', 'seguro_vencimiento', 'seguro_baja', 'seguro_motivo_baja']],
  ['Tarjeta de transporte', ['tarjeta_transporte', 'tarjeta_ambito', 'tarjeta_alta', 'tarjeta_vencimiento', 'tarjeta_baja', 'tarjeta_motivo_baja']],
  ['ITV y combustible', ['itv_proxima', 'tarjeta_combustible', 'pin_tarjeta']],
  ['Baja', ['fecha_baja', 'motivo_baja', 'observaciones']],
];
const layout = (secs) => ({ tabs: false, items: secs.flatMap(([title, keys]) => [{ section: title }, ...keys]) });

const VEHICULOS = {
  format: 'erp-app-structure', version: 1,
  app: {
    key: 'vehiculos', name: 'Vehículos', icon: '🚐', color: '#ef4444', description: 'Flota por centro de coste: ITV, seguros, tarjetas, revisiones, siniestros y traspasos',
    title_field: 'matricula', status_field: 'estado', closed_values: ['Baja'], transfers: 1, center_kind: 'coste', state_filter: 0,
    form_layout: layout(sections),
    fields,
    reports: [
      { name: 'Flota por centro de coste', config: { columns: ['matricula', 'marca', 'modelo', 'tipo', 'titular', 'itv_proxima', 'seguro_compania', 'seguro_vencimiento', 'tarjeta_vencimiento'],
        group_by: '_center', page_per_group: false, date_field: '', period: '', sort: 'matricula', dir: 'asc', layout: 'table', landscape: true, only_open: true, blank_cols: [], signature: '', notes: '' } },
      { name: 'Vencimientos de ITV del mes', config: { columns: ['matricula', 'marca', 'modelo', '_center', 'itv_proxima', 'conductor'],
        group_by: '_center', page_per_group: false, date_field: 'itv_proxima', period: 'month', sort: 'itv_proxima', dir: 'asc', layout: 'table', landscape: false, only_open: true, blank_cols: ['Cita ITV'], signature: '', notes: '' } },
    ],
    children: [
      {
        key: 'vehiculos_documentos', name: 'Documentos', icon: '📎', color: '#64748b', description: 'Seguros, permiso de circulación, ficha técnica, ITV y demás documentación en PDF',
        title_field: 'descripcion',
        fields: [
          f('tipo', 'Tipo de documento', 'select', 'sm', { ...list, ...sel(['Seguro / póliza', 'Permiso de circulación', 'Ficha técnica', 'ITV', 'Tarjeta de transporte', 'Factura', 'Contrato / renting', 'Otro']) }),
          f('descripcion', 'Descripción', 'text', 'lg', list),
          f('fecha', 'Fecha', 'date', 'sm', list), f('vencimiento', 'Vence', 'date', 'sm', { ...list, ...due }),
          f('archivos', 'Archivos (PDF, imagen, Word, Excel)', 'file', 'full', { required: 1, show_in_list: 1 }),
          f('observaciones', 'Observaciones', 'textarea', 'full'),
        ],
        form_layout: layout([['Documento', ['tipo', 'descripcion', 'fecha', 'vencimiento', 'archivos', 'observaciones']]]),
      },
      {
        key: 'vehiculos_revisiones', name: 'Revisiones', icon: '🔧', color: '#0ea5e9', description: 'Revisiones y trabajos de taller de cada vehículo',
        title_field: 'descripcion',
        fields: [
          f('fecha', 'Fecha', 'date', 'sm', { required: 1, show_in_list: 1 }), f('km', 'Kilómetros', 'number', 'sm', list),
          f('descripcion', 'Trabajo realizado', 'text', 'lg', list), f('realizado_por', 'Realizado por', 'text', 'md', list),
          f('piezas_revisadas', 'Revisado / cambiado', 'multiselect', 'lg', { ...sel(PIEZAS), height: 2 }),
          f('km_proxima', 'Km próxima revisión', 'number', 'sm', list),
          f('piezas_proxima', 'A revisar en la próxima', 'multiselect', 'lg', { ...sel(PIEZAS), height: 2 }),
          f('observaciones', 'Observaciones', 'textarea', 'full', { height: 2 }),
        ],
        form_layout: layout([['Revisión', ['fecha', 'km', 'descripcion', 'realizado_por']], ['Piezas', ['piezas_revisadas', 'km_proxima', 'piezas_proxima']], ['Notas', ['observaciones']]]),
      },
      {
        key: 'vehiculos_siniestros', name: 'Siniestros', icon: '💥', color: '#f59e0b', description: 'Partes de accidente y siniestros de cada vehículo',
        title_field: 'descripcion', status_field: 'situacion', closed_values: ['Cerrado'],
        fields: [
          f('fecha', 'Fecha', 'date', 'sm', { required: 1, show_in_list: 1 }), f('aseguradora', 'Aseguradora', 'select', 'sm', { ...list, ...sel(ASEGURADORAS) }),
          f('referencia', 'Referencia del siniestro', 'text', 'sm', list), f('situacion', 'Situación', 'select', 'sm', { ...list, options: { choices: ['Abierto', 'Cerrado'], colors: { Abierto: '#f59e0b', Cerrado: '#94a3b8' } } }),
          f('descripcion', 'Descripción', 'textarea', 'full', { ...list, height: 2 }),
        ],
        form_layout: layout([['Siniestro', ['fecha', 'aseguradora', 'referencia', 'situacion', 'descripcion']]]),
      },
    ],
  },
};

module.exports = { VEHICULOS, ASEGURADORAS, TIPOS, UBICACIONES, PIEZAS };
