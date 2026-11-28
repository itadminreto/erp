// Bandeja de traspasos entre centros: el centro de destino acepta o rechaza; el de origen ve los suyos y puede anularlos.
import { api, h, clear, toast, toastErr, modal, fmtDateTime } from './core.js';

/** Pide una nota opcional y ejecuta aceptar / rechazar / anular. */
function act(t, action, after) {
  const labels = { accept: ['Aceptar traspaso', 'Nota (opcional): estado en que llega, quién lo recibe…', 'primary'], reject: ['Rechazar traspaso', 'Motivo del rechazo', 'danger'], cancel: ['Anular traspaso', 'Motivo (opcional)', 'danger'] };
  const [title, ph, cls] = labels[action];
  const note = h('textarea', { id: 'tr-resp', rows: 3, placeholder: ph });
  const m = modal({ title: `${title}: ${t.title || 'Nº ' + t.number}`, size: 'sm',
    content: h('div.stack',
      h('p', `${t.app_icon || ''} ${t.app_name} · ${t.title || ''} (Nº ${t.number})`, h('br'), h('span.muted.small', `${t.from_name || 'Sin centro'} → ${t.to_name}`)),
      action === 'accept' ? h('p.muted.small', `Al aceptar, pasará a ${t.to_name} con todo su historial.`) : null,
      h('div.field', h('label', { for: 'tr-resp' }, 'Nota'), note)),
    footer: [h('div.spacer'), h('button.btn', { onclick: () => m.close() }, 'Volver'),
      h('button.btn', { class: cls, onclick: async () => {
        if (action === 'reject' && !note.value.trim()) return toast('Indica el motivo del rechazo', 'error');
        try {
          await api(`/apps/${t.app_key}/transfers/${t.id}/${action}`, { method: 'POST', body: { note: note.value } });
          toast({ accept: 'Traspaso aceptado', reject: 'Traspaso rechazado', cancel: 'Traspaso anulado' }[action], 'ok');
          m.close(); after && after();
        } catch (e) { toastErr(e); }
      } }, title)] });
}

const open = (t) => { try { sessionStorage.setItem('openRec', JSON.stringify({ app: t.app_key, id: t.record_id })); } catch { /* nada */ } location.hash = '#/app/' + t.app_key; };

function row(t, kind, after) {
  return h('div.inbox-row',
    h('span.ico', { 'aria-hidden': 'true' }, t.app_icon || '⇄'),
    h('div',
      h('div', h('a', { href: '#/app/' + t.app_key, onclick: (e) => { e.preventDefault(); open(t); } }, h('strong', t.title || `Nº ${t.number}`)), h('span.muted.small', ` · ${t.app_name} Nº ${t.number}`)),
      h('div', `${t.from_name || 'Sin centro'} → `, h('strong', t.to_name)),
      h('div.who', `Solicitado por ${t.requested_by_name || '—'} el ${fmtDateTime(t.requested_at)}`),
      t.note ? h('div.small', `«${t.note}»`) : null),
    h('div.btn-group', { style: { flexWrap: 'nowrap' } }, kind === 'in'
      ? [h('button.btn.sm.primary', { 'aria-label': `Aceptar traspaso de ${t.title || t.number}`, onclick: () => act(t, 'accept', after) }, '✔ Aceptar'),
        h('button.btn.sm.danger', { 'aria-label': `Rechazar traspaso de ${t.title || t.number}`, onclick: () => act(t, 'reject', after) }, '✕ Rechazar')]
      : h('button.btn.sm', { 'aria-label': `Anular traspaso de ${t.title || t.number}`, onclick: () => act(t, 'cancel', after) }, 'Anular')));
}

/** Tarjeta para el inicio (solo si hay traspasos por aceptar). */
export function transfersHomeCard(data, after) {
  if (!data || !data.incoming.length) return null;
  return h('section.card.card-pad.inbox-card', { 'aria-labelledby': 'tr-home-h' },
    h('h2', { id: 'tr-home-h' }, `⇄ Traspasos pendientes de aceptar (${data.incoming.length})`),
    h('p.muted.small', 'Te los envían otros centros. Al aceptarlos pasan a tu centro.'),
    data.incoming.slice(0, 5).map((t) => row(t, 'in', after)),
    data.incoming.length > 5 ? h('a', { href: '#/traspasos' }, `Ver los ${data.incoming.length} →`) : null);
}

/** Página «Traspasos»: por aceptar y enviados pendientes. */
export async function renderTransfers(root, after) {
  const data = await api('/apps/_transfers/pending');
  const refresh = async () => { await renderTransfers(root, after); after && after(); };
  clear(root,
    h('div.page-head', h('div.title', h('div', h('h1', '⇄ Traspasos entre centros'), h('div.muted.small', 'El centro de origen lo solicita desde la ficha («⇄ Traspasar») y el de destino lo acepta aquí.')))),
    h('section.card.card-pad', { 'aria-labelledby': 'tr-in' }, h('h2', { id: 'tr-in' }, `Por aceptar (${data.incoming.length})`),
      data.incoming.length ? data.incoming.map((t) => row(t, 'in', refresh)) : h('p.muted', 'No tienes traspasos pendientes de aceptar.')),
    h('section.card.card-pad', { style: { marginTop: '14px' }, 'aria-labelledby': 'tr-out' }, h('h2', { id: 'tr-out' }, `Enviados, esperando respuesta (${data.outgoing.length})`),
      data.outgoing.length ? data.outgoing.map((t) => row(t, 'out', refresh)) : h('p.muted', 'No hay traspasos enviados pendientes.')),
    h('p.muted.small', { style: { marginTop: '10px' } }, 'El historial de traspasos de cada registro está en su ficha, pestaña «⇄ Traspasos».'));
}
