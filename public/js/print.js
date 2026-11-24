// Impresión: genera un documento en un iframe oculto con cabecera (logo y empresa) y lanza el diálogo de impresión.
import { state, fmtDateTime } from './core.js';

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
  @page { size: A4 PORTRAIT; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font: 11pt/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; margin: 0; }
  header { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid #222; padding-bottom: 8px; margin-bottom: 14px; }
  header img { max-height: 48px; max-width: 160px; object-fit: contain; }
  header .t { flex: 1; }
  header h1 { font-size: 16pt; margin: 0; }
  header .sub { color: #555; font-size: 9.5pt; }
  header .meta { text-align: right; font-size: 8.5pt; color: #555; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #bbb; padding: 4px 6px; text-align: left; vertical-align: top; font-size: 9.5pt; }
  th { background: #eee; font-weight: 600; }
  tr { page-break-inside: avoid; }
  .ficha th { width: 32%; background: #f4f4f4; }
  .ficha td { white-space: pre-wrap; }
  .firma { display: flex; gap: 30px; margin-top: 40px; }
  .firma div { flex: 1; border-top: 1px solid #333; padding-top: 4px; font-size: 9pt; color: #444; }
  .cal th { text-align: center; }
  .cal td { height: 23mm; width: 14.28%; font-size: 8pt; padding: 2px 3px; }
  .cal td.out { background: #f3f3f3; color: #999; }
  .cal .d { font-weight: 700; font-size: 9pt; }
  .cal .ev { margin-top: 2px; padding: 1px 3px; border-left: 3px solid #888; background: #f7f7f7; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .legend { margin-top: 8px; font-size: 8.5pt; display: flex; gap: 14px; flex-wrap: wrap; }
  .legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; margin-right: 4px; background: var(--c); vertical-align: -1px; }
  .deleted td { color: #b00; text-decoration: line-through; }
  footer { margin-top: 12px; font-size: 8pt; color: #777; }
`;

/** Imprime `bodyHtml` (HTML ya escapado) con cabecera corporativa. */
export function printDoc({ title, subtitle = '', bodyHtml, landscape = false }) {
  const company = (state.me.companies || []).find((c) => c.id === state.companyId);
  const logo = company && company.has_logo ? `<img src="/api/companies/${company.id}/logo" alt="">` : '';
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title>
    <style>${CSS.replace('PORTRAIT', landscape ? 'landscape' : 'portrait')}</style></head><body>
    <header>${logo}<div class="t"><h1>${esc(title)}</h1><div class="sub">${esc(company ? company.name : '')}${subtitle ? ' · ' + esc(subtitle) : ''}</div></div>
    <div class="meta">${esc(fmtDateTime(new Date().toISOString()))}<br>${esc(state.me.name)}</div></header>
    ${bodyHtml}
    </body></html>`;
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  document.body.append(frame);
  const doc = frame.contentDocument;
  doc.open(); doc.write(html); doc.close();
  const go = () => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 60e3);
  };
  const imgs = [...doc.images];
  if (!imgs.length) return setTimeout(go, 50);
  let pending = imgs.length;
  const done = () => { if (--pending === 0) go(); };
  imgs.forEach((i) => (i.complete ? done() : (i.onload = i.onerror = done)));
}
