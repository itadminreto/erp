// Interpretación de respuestas escritas o dictadas en español (sin dependencias: se prueba en test/voice.test.mjs).
export const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const NUMS = { un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, veinte: 20, treinta: 30 };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const num = (w) => (/^\d+$/.test(w) ? Number(w) : NUMS[w]);

/** «hoy», «mañana», «el lunes», «dentro de 3 días», «15 de diciembre», «15/12/2026»… → AAAA-MM-DD o null. */
export function parseDate(text, today = new Date()) {
  const t = norm(text).replace(/^(el|para el|para|dia)\s+/, '');
  if (!t) return null;
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const plus = (n) => { const d = new Date(base); d.setDate(d.getDate() + n); return iso(d); };
  if (t === 'hoy') return plus(0);
  if (t === 'manana') return plus(1);
  if (t === 'pasado manana') return plus(2);
  if (t === 'ayer') return plus(-1);
  let m = t.match(/^(?:dentro de|en) (\w+) (dia|dias|semana|semanas|mes|meses)$/);
  if (m && num(m[1])) {
    const n = num(m[1]);
    if (m[2].startsWith('dia')) return plus(n);
    if (m[2].startsWith('semana')) return plus(7 * n);
    const d = new Date(base); d.setMonth(d.getMonth() + n); return iso(d);
  }
  m = t.match(/^(?:el )?(lunes|martes|miercoles|jueves|viernes|sabado|domingo)(?: que viene| proximo)?$/) || t.match(/^(?:el )?proximo (lunes|martes|miercoles|jueves|viernes|sabado|domingo)$/);
  if (m) { let n = (DAYS.indexOf(m[1]) - base.getDay() + 7) % 7; if (n === 0) n = 7; return plus(n); }
  const build = (d, mo, y) => {
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    let year = y === undefined ? base.getFullYear() : (y < 100 ? 2000 + y : y);
    let dt = new Date(year, mo - 1, d);
    if (dt.getMonth() !== mo - 1) return null; // 31 de febrero
    if (y === undefined && (base - dt) / 864e5 > 30) dt = new Date(year + 1, mo - 1, d); // sin año: la próxima vez que llegue
    return iso(dt);
  };
  m = t.match(/^(\w+) (?:de )?([a-z]+)(?: (?:de |del )?(\d{2,4}))?$/);
  if (m && MONTHS.includes(m[2]) && num(m[1])) return build(num(m[1]), MONTHS.indexOf(m[2]) + 1, m[3] ? Number(m[3]) : undefined);
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return build(+m[3], +m[2], +m[1]);
  m = t.match(/^(\d{1,2})[/.\- ](\d{1,2})(?:[/.\- ](\d{2,4}))?$/);
  if (m) return build(+m[1], +m[2], m[3] ? +m[3] : undefined);
  return null;
}
