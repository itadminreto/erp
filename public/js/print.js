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
  .ficha th.sec { width: auto; background: #ddd; text-transform: uppercase; font-size: 8.5pt; letter-spacing: .05em; padding-top: 6px; }
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

  /* ----- parte / ficha profesional ----- */
  .doc { color: #1f2937; }
  .doc-head { display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: stretch; padding-bottom: 10px; border-bottom: 3px solid var(--accent); }
  .doc-company { display: flex; gap: 12px; align-items: center; }
  .doc-company img { max-height: 56px; max-width: 170px; object-fit: contain; }
  .doc-company .nm { font-size: 13pt; font-weight: 700; }
  .doc-company .dt { font-size: 8.5pt; color: #555; line-height: 1.35; }
  .doc-id { border: 1.5px solid var(--accent); border-radius: 6px; min-width: 54mm; text-align: right; overflow: hidden; }
  .doc-id .ty { background: var(--accent); color: #fff; font-size: 8.5pt; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; padding: 4px 10px; }
  .doc-id .no { font-size: 20pt; font-weight: 800; padding: 2px 10px 0; font-variant-numeric: tabular-nums; }
  .doc-id .dd { font-size: 8.5pt; color: #555; padding: 0 10px 6px; }
  .doc-title { font-size: 14pt; font-weight: 700; margin: 12px 0 2px; }
  .doc-sub { font-size: 9pt; color: #555; margin-bottom: 8px; }
  .sec { margin-top: 10px; page-break-inside: avoid; }
  .sec-h { font-size: 8.5pt; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); border-bottom: 1px solid var(--accent); padding-bottom: 2px; margin-bottom: 6px; }
  .grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 6px; }
  .box { border: 1px solid #c9ced6; border-radius: 4px; padding: 3px 7px 5px; min-height: 11mm; page-break-inside: avoid; }
  .box .l { font-size: 7pt; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; }
  .box .v { font-size: 10pt; white-space: pre-wrap; word-break: break-word; min-height: 12pt; }
  .box .v.nil { color: #c0c4cc; }
  .s2 { grid-column: span 2; } .s3 { grid-column: span 3; } .s4 { grid-column: span 4; } .s6 { grid-column: span 6; } .s8 { grid-column: span 8; } .s12 { grid-column: span 12; }
  .pics { display: grid; grid-template-columns: repeat(auto-fill, minmax(38mm, 1fr)); gap: 4px; margin-top: 3px; }
  .pics img { width: 100%; max-height: 60mm; object-fit: contain; border: 1px solid #e5e7eb; border-radius: 3px; background: #fafafa; }
  .sigs { display: grid; grid-template-columns: repeat(auto-fit, minmax(55mm, 1fr)); gap: 10px; margin-top: 14px; page-break-inside: avoid; }
  .sig { border: 1px solid #c9ced6; border-radius: 4px; padding: 4px 8px 6px; }
  .sig .l { font-size: 7pt; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; }
  .sig .im { height: 26mm; display: flex; align-items: center; justify-content: center; border-bottom: 1px solid #9ca3af; margin: 2px 0 4px; }
  .sig .im img { max-height: 24mm; max-width: 100%; }
  .sig .d { font-size: 7.5pt; color: #6b7280; }
  .doc-foot { margin-top: 14px; padding-top: 5px; border-top: 1px solid #d1d5db; font-size: 7.5pt; color: #6b7280; display: flex; justify-content: space-between; gap: 10px; }
  .stamp { display: inline-block; border: 2px solid #b91c1c; color: #b91c1c; font-weight: 800; padding: 2px 8px; border-radius: 4px; transform: rotate(-4deg); margin-left: 8px; font-size: 9pt; }
`;

/** Imprime `bodyHtml` (HTML ya escapado) con cabecera corporativa. */
/** HTML completo del documento (cabecera corporativa opcional + cuerpo), el mismo para imprimir y para PDF. */
/** Contenido del documento: cabecera corporativa (salvo `bare`) + cuerpo. */
function docInner({ title, subtitle = '', bodyHtml, bare = false }) {
  const company = (state.me.companies || []).find((c) => c.id === state.companyId);
  const logo = company && company.has_logo ? `<img src="/api/companies/${company.id}/logo" alt="">` : '';
  return `${bare ? '' : `<header>${logo}<div class="t"><h1>${esc(title)}</h1><div class="sub">${esc(company ? company.name : '')}${subtitle ? ' · ' + esc(subtitle) : ''}</div></div>
    <div class="meta">${esc(fmtDateTime(new Date().toISOString()))}<br>${esc(state.me.name)}</div></header>`}
    ${bodyHtml}`;
}

/** HTML completo del documento, el mismo para imprimir y (con los estilos aislados) para PDF. */
export function docHtml(opts) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(opts.title)}</title>
    <style>${CSS.replace('PORTRAIT', opts.landscape ? 'landscape' : 'portrait')}</style></head><body>${docInner(opts)}</body></html>`;
}

/**
 * Los mismos estilos de impresión, limitados a un contenedor `.erp-doc` para generar el PDF dentro de la
 * página sin que se mezclen con los estilos de la aplicación.
 */
const SCOPED_CSS = (() => {
  const out = [];
  for (const chunk of CSS.split('}')) {
    const i = chunk.indexOf('{');
    if (i < 0) continue;
    const sel = chunk.slice(0, i).trim(), decl = chunk.slice(i + 1);
    if (!sel || sel.startsWith('@') || sel.startsWith('/*')) continue;
    const scoped = sel.split(',').map((x) => {
      x = x.trim().replace(/^\/\*.*?\*\/\s*/s, '');
      return x === 'body' ? '.erp-doc' : x === '*' ? '.erp-doc, .erp-doc *' : `.erp-doc ${x}`;
    }).join(', ');
    out.push(`${scoped} {${decl}}`);
  }
  return out.join('\n') + '\n.erp-doc { background: #fff; color: #111; } .erp-doc img { max-width: 100%; }';
})();

/** Escribe el documento en un iframe oculto y espera a que carguen las imágenes (logo, fotos, firmas). */
function loadFrame(html) {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
    document.body.append(frame);
    const doc = frame.contentDocument;
    doc.open(); doc.write(html); doc.close();
    const imgs = [...doc.images];
    if (!imgs.length) return setTimeout(() => resolve(frame), 50);
    let pending = imgs.length;
    const done = () => { if (--pending === 0) resolve(frame); };
    imgs.forEach((i) => (i.complete ? done() : (i.onload = i.onerror = done)));
  });
}

export async function printDoc(opts) {
  const frame = await loadFrame(docHtml(opts));
  frame.contentWindow.focus();
  frame.contentWindow.print();
  setTimeout(() => frame.remove(), 60e3);
}

let pdfLib = null;
const loadPdfLib = () => pdfLib || (pdfLib = new Promise((ok, ko) => {
  const sc = document.createElement('script');
  sc.src = '/vendor/html2pdf.bundle.min.js';
  sc.onload = () => ok(window.html2pdf); sc.onerror = () => { pdfLib = null; ko(new Error('No se pudo cargar el generador de PDF')); };
  document.head.append(sc);
}));

/**
 * Genera el PDF (A4) del mismo documento que se imprime (mismos estilos, aislados en `.erp-doc`). Devuelve un Blob.
 */
export async function docPdf(opts) {
  const html2pdf = await loadPdfLib();
  const el = document.createElement('div');
  el.className = 'erp-doc';
  el.innerHTML = `<style>${SCOPED_CSS}</style>${docInner(opts)}`;
  // espera a que carguen logo, fotos y firmas
  await Promise.all([...el.querySelectorAll('img')].map((i) => (i.complete ? null : new Promise((ok) => { i.onload = i.onerror = ok; }))));
  {
    return await html2pdf().set({
      margin: [14, 12, 14, 12],
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format: 'a4', orientation: opts.landscape ? 'landscape' : 'portrait' },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['.box', '.sig', '.sec-h', 'tr'] },
    }).from(el).outputPdf('blob');
  }
}

/** Blob → base64 (sin el prefijo data:). */
export const blobToBase64 = (blob) => new Promise((ok, ko) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = () => ko(r.error);
  r.readAsDataURL(blob);
});
