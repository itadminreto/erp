// Configuración de informes / listados imprimibles: campos y su orden, agrupación, periodo, columnas en blanco y firma.
// La usan el super admin (informes guardados de cada app) y cualquier usuario («Imprimir eligiendo campos»).
import { h, modal, toast, sortable, announce } from './core.js';

export const REPORT_META_COLS = { _num: 'Nº', _center: 'Centro', _created_at: 'Creado', _updated_at: 'Modificado', _updated_by: 'Modificado por' };
const NO_COLUMN = ['password', 'signature', 'image'];
const GROUP_TYPES = ['select', 'user', 'group', 'checkbox'];
export const REPORT_PERIODS = [['', 'Sin filtro de fecha'], ['today', 'Hoy'], ['tomorrow', 'Mañana'], ['week', 'Esta semana'], ['next7', 'Próximos 7 días'],
  ['month', 'Este mes'], ['future', 'De hoy en adelante'], ['past', 'Anteriores a hoy']];

/**
 * Ventana de configuración. `fields`: campos de la app; `app`: { status_field };
 * `report`: { name, config } a editar (o null); `mode`: 'admin' (con nombre, para guardar) o 'print' (imprimir ahora).
 * Devuelve { name, config, action } con action = 'save' | 'print' | 'pdf' | 'saveas', o null si se cancela.
 */
export function editReport({ fields, app, report = null, mode = 'admin', defaults = {}, canSave = false }) {
  return new Promise((resolve) => {
    const c = { columns: [], group_by: '', page_per_group: false, date_field: '', period: '', sort: '', dir: 'asc', layout: 'table',
      landscape: false, only_open: false, blank_cols: [], signature: '', notes: '', ...defaults, ...(report ? report.config : {}) };
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
    const label = (k) => REPORT_META_COLS[k] || (byKey[k] ? byKey[k].label : k);
    const allCols = [...Object.keys(REPORT_META_COLS), ...fields.filter((f) => !NO_COLUMN.includes(f.type)).map((f) => f.key)];
    const order = [...c.columns.filter((k) => allCols.includes(k)), ...allCols.filter((k) => !c.columns.includes(k))];
    let result = null;

    const move = (item, dir) => {
      const sib = dir < 0 ? item.previousElementSibling : item.nextElementSibling;
      if (!sib) return;
      if (dir < 0) sib.before(item); else sib.after(item);
      item.querySelector(dir < 0 ? '.up' : '.down').focus();
      announce(`${label(item.dataset.col)}: posición ${[...list.children].indexOf(item) + 1}`);
    };
    const list = h('div.sort-list.rep-cols', order.map((k) => h('div.sort-item', { dataset: { col: k } },
      h('span.grip', '⋮⋮'),
      h('label.check.grow', h('input', { type: 'checkbox', checked: c.columns.includes(k) }), label(k)),
      h('button.btn.ghost.sm.up', { type: 'button', title: 'Subir', 'aria-label': `Subir ${label(k)}`, onclick: (e) => move(e.currentTarget.parentElement, -1) }, '▲'),
      h('button.btn.ghost.sm.down', { type: 'button', title: 'Bajar', 'aria-label': `Bajar ${label(k)}`, onclick: (e) => move(e.currentTarget.parentElement, 1) }, '▼'))));
    sortable(list, { handle: '.grip' });

    const id = (x) => 'rp-' + x;
    const sel = (key, opts, value) => h('select', { id: id(key) }, opts.map(([v, l]) => h('option', { value: v, selected: String(value ?? '') === v }, l)));
    const name = h('input', { id: id('name'), value: report ? report.name : '', placeholder: 'Ej.: Parte diario por grupo' });
    const groupSel = sel('group', [['', 'Sin agrupar'], ['_center', 'Centro'], ...fields.filter((f) => GROUP_TYPES.includes(f.type)).map((f) => [f.key, f.label])], c.group_by);
    const pagePer = h('input', { type: 'checkbox', checked: c.page_per_group });
    const dateFields = fields.filter((f) => ['date', 'datetime'].includes(f.type));
    const dateSel = sel('date', [['', '— Ninguno —'], ...dateFields.map((f) => [f.key, f.label])], c.date_field);
    const periodSel = sel('period', REPORT_PERIODS, c.period);
    const sortSel = sel('sort', [['', 'Nº'], ...allCols.filter((k) => k !== '_num').map((k) => [k, label(k)])], c.sort);
    const dirSel = sel('dir', [['asc', 'Ascendente'], ['desc', 'Descendente']], c.dir);
    const layoutSel = sel('layout', [['table', 'Tabla (una fila por trabajo)'], ['cards', 'Fichas (un recuadro por trabajo)']], c.layout);
    const landscape = h('input', { type: 'checkbox', checked: c.landscape });
    const onlyOpen = h('input', { type: 'checkbox', checked: c.only_open });
    const blank = h('input', { id: id('blank'), value: (c.blank_cols || []).join(', '), placeholder: 'Hora llegada, Hora salida, Firma cliente' });
    const signature = h('input', { id: id('sig'), value: c.signature || '', placeholder: 'Firma del responsable del grupo' });
    const notes = h('textarea', { id: id('notes'), rows: 2, value: c.notes || '', placeholder: 'Texto que aparece al pie (opcional)' });
    const syncDate = () => { periodSel.disabled = !dateSel.value; };
    dateSel.addEventListener('change', syncDate); syncDate();
    const syncGroup = () => { pagePer.disabled = !groupSel.value; };
    groupSel.addEventListener('change', syncGroup); syncGroup();

    const fld = (lbl, input, help) => h('div.field', h('label', { for: input.id }, lbl), input, help ? h('div.help', help) : null);
    const content = h('div.rep-editor',
      h('div.rep-left',
        mode === 'admin' ? fld('Nombre del informe *', name) : null,
        h('h3.rep-h', 'Campos a imprimir'),
        h('p.muted.small', 'Marca los campos y ordénalos arrastrando o con ▲ ▼.'),
        h('div.row', { style: { gap: '6px', marginBottom: '6px' } },
          h('button.btn.sm', { type: 'button', onclick: () => list.querySelectorAll('input').forEach((i) => { i.checked = true; }) }, 'Todos'),
          h('button.btn.sm', { type: 'button', onclick: () => list.querySelectorAll('input').forEach((i) => { i.checked = false; }) }, 'Ninguno')),
        list),
      h('div.rep-right',
        h('h3.rep-h', 'Agrupar y filtrar'),
        fld('Agrupar por', groupSel, 'Por ejemplo, por grupo de trabajo: un bloque por grupo.'),
        h('label.check', pagePer, 'Cada grupo en una hoja nueva'),
        mode === 'admin' ? [fld('Campo de fecha', dateSel), fld('Periodo por defecto', periodSel, 'Al lanzarlo se puede cambiar.')] : null,
        app.status_field ? h('label.check', onlyOpen, 'Solo abiertos (sin cerrados)') : null,
        h('h3.rep-h', 'Orden y aspecto'),
        h('div.two-col', fld('Ordenar por', sortSel), fld('Sentido', dirSel)),
        fld('Formato', layoutSel),
        h('label.check', landscape, 'Hoja apaisada (horizontal)'),
        fld('Columnas en blanco para rellenar a mano', blank, 'Separadas por comas. Máx. 6.'),
        fld('Firma al final de cada grupo', signature),
        fld('Nota al pie', notes)));

    const collect = () => ({
      columns: [...list.children].filter((el) => el.querySelector('input').checked).map((el) => el.dataset.col),
      group_by: groupSel.value, page_per_group: pagePer.checked && !!groupSel.value,
      date_field: mode === 'admin' ? dateSel.value : c.date_field, period: mode === 'admin' ? (dateSel.value ? periodSel.value : '') : c.period,
      sort: sortSel.value, dir: dirSel.value, layout: layoutSel.value, landscape: landscape.checked, only_open: onlyOpen.checked,
      blank_cols: blank.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 6), signature: signature.value.trim(), notes: notes.value.trim(),
    });
    const done = (action) => {
      const config = collect();
      if (!config.columns.length) return toast('Marca al menos un campo', 'error');
      if (action === 'save' && !name.value.trim()) { name.focus(); return toast('Pon un nombre al informe', 'error'); }
      result = { name: name.value.trim(), config, action }; m.close();
    };
    const m = modal({
      title: mode === 'admin' ? (report ? `Informe · ${report.name}` : 'Nuevo informe') : '🖨 Imprimir eligiendo campos', size: 'lg', content,
      footer: mode === 'admin'
        ? [h('div.spacer'), h('button.btn', { onclick: () => m.close() }, 'Cancelar'), h('button.btn.primary', { onclick: () => done('save') }, 'Guardar informe')]
        : [canSave ? h('button.btn.ghost', { title: 'Guardar esta configuración como informe de la aplicación', onclick: () => done('saveas') }, '💾 Guardar como informe…') : null,
          h('div.spacer'), h('button.btn', { onclick: () => m.close() }, 'Cancelar'),
          h('button.btn', { onclick: () => done('pdf') }, '⬇ PDF'), h('button.btn.primary', { onclick: () => done('print') }, '🖨 Imprimir')],
      onClose: () => resolve(result),
    });
  });
}
