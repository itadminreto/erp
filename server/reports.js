'use strict';
// Informes configurables por aplicación (listados para imprimir): columnas, agrupación, periodo, columnas en blanco y firma.

const META_COLS = ['_num', '_center', '_created_at', '_updated_at', '_updated_by'];
const GROUP_TYPES = ['select', 'user', 'group', 'checkbox'];
const PERIODS = ['', 'today', 'tomorrow', 'week', 'next7', 'month', 'future', 'past'];
const NO_COLUMN = ['password', 'signature', 'image'];

const err = (msg) => Object.assign(new Error(msg), { status: 400 });
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

/** Valida y normaliza la configuración de un informe contra los campos de la app. */
function cleanReport(input, fields, app) {
  const c = input && typeof input === 'object' ? input : {};
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  const okCol = (k) => META_COLS.includes(k) || (byKey[k] && !NO_COLUMN.includes(byKey[k].type));
  const columns = (Array.isArray(c.columns) ? c.columns : []).map(String).filter((k, i, a) => a.indexOf(k) === i && okCol(k)).slice(0, 30);
  if (!columns.length) throw err('Elige al menos un campo para el informe');
  const groupBy = str(c.group_by, 50);
  if (groupBy && groupBy !== '_center' && !(byKey[groupBy] && GROUP_TYPES.includes(byKey[groupBy].type))) throw err('Campo de agrupación no válido');
  const dateField = str(c.date_field, 50);
  if (dateField && !(byKey[dateField] && ['date', 'datetime'].includes(byKey[dateField].type))) throw err('Campo de fecha no válido');
  const period = PERIODS.includes(c.period) ? c.period : '';
  const sort = str(c.sort, 50);
  if (sort && !(okCol(sort) || (byKey[sort] && ['date', 'datetime'].includes(byKey[sort].type)))) throw err('Campo de orden no válido');
  const blank = (Array.isArray(c.blank_cols) ? c.blank_cols : String(c.blank_cols || '').split(','))
    .map((x) => str(x, 40)).filter(Boolean).slice(0, 6);
  return {
    columns,
    group_by: groupBy,
    page_per_group: !!c.page_per_group && !!groupBy,
    date_field: dateField,
    period: dateField ? period : '',
    sort, dir: c.dir === 'desc' ? 'desc' : 'asc',
    layout: c.layout === 'cards' ? 'cards' : 'table',
    landscape: !!c.landscape,
    only_open: !!c.only_open && !!app.status_field,
    blank_cols: blank,
    signature: str(c.signature, 120),
    notes: str(c.notes, 500),
  };
}

/** Informe por defecto de Recados: parte diario de trabajos por grupo (citas de hoy). */
function recadosDailyReport(fields) {
  const has = (k) => fields.some((f) => f.key === k);
  const cols = ['_num', 'fecha_realizado', 'titulo', 'solicitante', 'direccion', 'telefono', 'descripcion', 'prioridad', 'estado'].filter((k) => k.startsWith('_') || has(k));
  return {
    name: 'Parte diario por grupo',
    config: {
      columns: cols,
      group_by: has('grupo') ? 'grupo' : (has('asignado_a') ? 'asignado_a' : ''),
      page_per_group: true,
      date_field: has('fecha_realizado') ? 'fecha_realizado' : (has('fecha_limite') ? 'fecha_limite' : ''),
      period: 'today',
      sort: has('fecha_realizado') ? 'fecha_realizado' : '_num', dir: 'asc',
      layout: 'table', landscape: true, only_open: true,
      blank_cols: ['Hora llegada', 'Hora salida', 'Firma cliente'],
      signature: 'Firma del responsable del grupo',
      notes: '',
    },
  };
}

module.exports = { cleanReport, recadosDailyReport, META_COLS, GROUP_TYPES };
