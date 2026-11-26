// Asistente de recogida por voz para usuarios invidentes: una pregunta cada vez, leída en voz alta.
// Se contesta escribiendo (o con el dictado del sistema), Intro para seguir, Esc para volver atrás.
// Al final lee un resumen y guarda el registro con la misma API (y permisos) que el formulario normal.
import { api, h, clear, toastErr, announce } from './core.js';
import { norm, parseDate } from './voice-parse.js';

// ---------- voz ----------
const PREF = 'voiceAssistant';
const prefs = () => { try { return { on: true, rate: 1, ...JSON.parse(localStorage.getItem(PREF) || '{}') }; } catch { return { on: true, rate: 1 }; } };
const savePrefs = (p) => { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch { /* sin almacenamiento */ } };
const synth = window.speechSynthesis;
let esVoice = null;
const pickVoice = () => {
  const vs = synth ? synth.getVoices() : [];
  esVoice = vs.find((v) => v.lang === 'es-ES' && v.localService) || vs.find((v) => v.lang === 'es-ES') || vs.find((v) => /^es/.test(v.lang)) || null;
};
if (synth) { pickVoice(); synth.addEventListener?.('voiceschanged', pickVoice); }

/** Lee el texto con la voz del navegador; si la voz está apagada, lo pasa al lector de pantalla. */
function speak(text) {
  const p = prefs();
  if (!p.on || !synth) { announce(text); return; }
  synth.cancel();
  setTimeout(() => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'es-ES'; if (esVoice) u.voice = esVoice; u.rate = p.rate;
    synth.speak(u);
  }, 60);
}
const stopSpeaking = () => { if (synth) synth.cancel(); };

// ---------- interpretación de respuestas ----------
const sayDate = (s) => { const [y, mo, d] = s.split('-').map(Number); return new Date(y, mo - 1, d).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); };
const sayPhone = (s) => {
  const plus = s.startsWith('+') ? 'más ' : '';
  const d = s.replace(/\D/g, '');
  const sizes = d.length === 9 ? [3, 2, 2, 2] : [];
  const groups = [];
  for (let k = 0, n = 0; k < d.length; n++) { const sz = sizes[n] || 3; groups.push(d.slice(k, k + sz)); k += sz; }
  return plus + groups.map((g) => g.split('').join(' ')).join(', ');
};
const sayEmail = (s) => s.replace(/@/g, ' arroba ').replace(/\./g, ' punto ').replace(/_/g, ' guion bajo ').replace(/-/g, ' guion ');

/** Arregla lo dictado: «pepe arroba gmail punto com» → pepe@gmail.com; teléfono sin espacios. */
function fromDictation(f, text) {
  let t = text.trim();
  if (f.type === 'email') t = norm(t).replace(/ arroba /g, '@').replace(/ punto /g, '.').replace(/ guion bajo /g, '_').replace(/ guion /g, '-').replace(/\s+/g, '');
  if (f.type === 'phone') t = t.replace(/[^\d+]/g, '');
  return t;
}

// ---------- asistente ----------
const VOICE_TYPES = ['text', 'textarea', 'email', 'phone', 'url', 'number', 'decimal', 'date', 'datetime', 'select', 'multiselect', 'user', 'checkbox', 'ip', 'iban'];

export async function renderVoice(root, key) {
  const meta = await api('/apps/' + key);
  const fieldsByKey = Object.fromEntries(meta.fields.map((f) => [f.key, f]));
  let voiceKeys = [];
  try { voiceKeys = JSON.parse(meta.app.voice_fields || '[]'); } catch { voiceKeys = []; }
  // orden del formulario (diseñador): primero los del diseño, luego el resto en su orden
  let layout = {};
  try { layout = meta.app.form_layout ? JSON.parse(meta.app.form_layout) : {}; } catch { layout = {}; }
  const ordered = [...new Set([...(Array.isArray(layout.items) ? layout.items : []).filter((k) => typeof k === 'string' && fieldsByKey[k]), ...meta.fields.map((f) => f.key)])]
    .map((k) => fieldsByKey[k]).filter((f) => VOICE_TYPES.includes(f.type));
  // «*» = todos los campos (menos firmas, imágenes, contraseñas y color); si hay lista, se añaden siempre los obligatorios
  const all = voiceKeys.includes('*');
  const fields = ordered.filter((f) => all || voiceKeys.includes(f.key) || (voiceKeys.length && f.required));
  const head = h('h1', `Recoger · ${meta.app.name}`);
  if (!meta.perms.create || !fields.length) {
    clear(root, h('div.page-head', h('div.title', head)), h('div.card.empty', h('p', !meta.perms.create
      ? 'No tienes permiso para crear registros en esta aplicación.'
      : 'Esta aplicación no tiene configurado el asistente por voz. El super administrador lo configura en Apps y campos → Propiedades.')));
    return;
  }

  // pasos: centro (si puede elegir entre varios) + campos configurados + resumen
  const centerStep = meta.centers.length > 1 ? { key: '_center', label: 'Centro', type: 'center', required: true } : null;
  const steps = [centerStep, ...fields].filter(Boolean);
  const answers = {}; // clave → { value (para guardar), text (para leer) }
  let i = -1; // -1 = bienvenida; steps.length = resumen
  let fromSummary = false;

  const p = prefs();
  const voiceCb = h('input', { type: 'checkbox', checked: p.on, onchange: () => { const q = prefs(); q.on = voiceCb.checked; savePrefs(q); if (!q.on) stopSpeaking(); else speak('Voz activada'); } });
  const rateSel = h('select', { 'aria-label': 'Velocidad de la voz', onchange: () => { const q = prefs(); q.rate = Number(rateSel.value); savePrefs(q); speak('Velocidad cambiada'); } },
    [[0.8, 'Lenta'], [1, 'Normal'], [1.25, 'Rápida'], [1.5, 'Muy rápida']].map(([v, l]) => h('option', { value: v, selected: Number(p.rate) === v }, l)));
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canDictate = !!SR && window.isSecureContext;

  const progress = h('p.voice-progress', { 'aria-hidden': 'true' });
  const stage = h('div.voice-stage');
  const keysHelp = h('p.muted.small', 'Teclas: Intro = siguiente · Esc = atrás · F2 = repetir la pregunta' + (canDictate ? ' · F3 = dictar' : '') + '. También puedes dictar con el dictado de Windows (tecla Windows + H).');
  clear(root,
    h('div.page-head', h('div.title', h('div.app-ico', { style: { background: meta.app.color + '22', color: meta.app.color } }, '📞'), h('div', head, h('div.muted.small', 'Asistente por voz: una pregunta cada vez')))),
    h('div.card.voice', progress, stage,
      h('div.voice-opts', h('label.check', voiceCb, 'Leer en voz alta'), h('label.small.muted', { for: (rateSel.id = 'voice-rate') }, 'Velocidad'), rateSel), keysHelp));

  function options(f) {
    if (f.type === 'center') return meta.centers.map((c) => ({ value: c.id, label: c.name }));
    if (f.type === 'select' || f.type === 'multiselect') return (f.options.choices || []).map((c) => ({ value: c, label: c }));
    if (f.type === 'user') return meta.users.map((u) => ({ value: u.id, label: u.name }));
    if (f.type === 'checkbox') return [{ value: true, label: 'Sí' }, { value: false, label: 'No' }];
    return null;
  }
  const optionsText = (opts) => opts.map((o, n) => `${n + 1}, ${o.label}`).join('. ');
  function question(f) {
    const opts = options(f);
    const q = `${f.label}${f.required ? ', obligatorio' : ''}.`;
    if (opts && f.type === 'multiselect') return `${q} Opciones: ${optionsText(opts)}. Puedes elegir varias: escribe los números separados por comas.`;
    if (opts) return `${q} Opciones: ${optionsText(opts)}. Escribe el número o el nombre.`;
    if (f.type === 'date') return `${q} Por ejemplo: hoy, mañana, el lunes, 15 de diciembre o 15/12.`;
    if (f.type === 'datetime') return `${q} Fecha y hora, por ejemplo: mañana a las 10.`;
    if (f.type === 'phone') return `${q} Escribe el número.`;
    return q;
  }
  const spoken = (f, a) => {
    if (!a || a.value === '' || a.value === null || a.value === undefined) return 'sin dato';
    if (f.type === 'phone') return sayPhone(a.text);
    if (f.type === 'email') return sayEmail(a.text);
    return a.text;
  };

  /** Interpreta lo escrito. Devuelve { value, text } o { error }. */
  function interpret(f, raw) {
    const t = String(raw || '').trim();
    if (!t) return f.required ? { error: `${f.label} es obligatorio. Escribe un valor.` } : { value: '', text: '' };
    const opts = options(f);
    if (opts && f.type === 'multiselect') {
      const picked = [];
      for (const part of t.split(/\s*(?:,|;| y )\s*|\s+(?=\d)/).filter(Boolean)) {
        const n = Number(part);
        const o = Number.isInteger(n) && n >= 1 && n <= opts.length ? opts[n - 1]
          : opts.find((x) => norm(x.label) === norm(part)) || (opts.filter((x) => norm(x.label).startsWith(norm(part))).length === 1 ? opts.find((x) => norm(x.label).startsWith(norm(part))) : null);
        if (!o) return { error: `No reconozco «${part}». Opciones: ${optionsText(opts)}.` };
        if (!picked.includes(o)) picked.push(o);
      }
      return { value: picked.map((o) => o.value), text: picked.map((o) => o.label).join(', ') };
    }
    if (opts) {
      const n = Number(t);
      if (Number.isInteger(n) && n >= 1 && n <= opts.length) return { value: opts[n - 1].value, text: opts[n - 1].label };
      const nt = norm(t);
      if (f.type === 'checkbox' && /^(si|s)$/.test(nt)) return { value: true, text: 'Sí' };
      if (f.type === 'checkbox' && /^(no|n)$/.test(nt)) return { value: false, text: 'No' };
      const hit = opts.filter((o) => norm(o.label) === nt);
      const pre = hit.length ? hit : opts.filter((o) => norm(o.label).startsWith(nt) || norm(o.label).includes(nt));
      if (pre.length === 1) return { value: pre[0].value, text: pre[0].label };
      return { error: pre.length > 1 ? `Hay varias opciones que coinciden: ${pre.map((o) => o.label).join(', ')}. Sé más concreto o escribe el número.` : `No reconozco «${t}». Opciones: ${optionsText(opts)}.` };
    }
    switch (f.type) {
      case 'date': { const d = parseDate(t); return d ? { value: d, text: sayDate(d) } : { error: `No entiendo la fecha «${t}». Prueba con: mañana, el lunes o 15 de diciembre.` }; }
      case 'datetime': {
        const m = norm(t).match(/^(.*?)(?:,? a las? (\d{1,2})(?:[:.h ](\d{2}))?)?$/);
        const d = parseDate(m[1]);
        if (!d) return { error: `No entiendo la fecha «${t}».` };
        const hh = String(Math.min(23, Number(m[2] || 9))).padStart(2, '0'); const mm = String(Math.min(59, Number(m[3] || 0))).padStart(2, '0');
        return { value: `${d}T${hh}:${mm}`, text: `${sayDate(d)} a las ${hh}:${mm}` };
      }
      case 'phone': { const v = t.replace(/[^\d+]/g, ''); return v.replace(/\D/g, '').length >= 6 ? { value: v, text: v } : { error: 'El teléfono tiene pocas cifras. Escríbelo de nuevo.' }; }
      case 'email': { const v = fromDictation(f, t.includes('@') ? t.replace(/\s+/g, '') : t).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? { value: v, text: v } : { error: `El email «${t}» no parece correcto. Debe llevar arroba y un punto.` }; }
      case 'number': case 'decimal': { const v = Number(t.replace(/\./g, '').replace(',', '.')); return Number.isFinite(v) ? { value: f.type === 'number' ? Math.round(v) : v, text: String(v).replace('.', ',') } : { error: `«${t}» no es un número.` }; }
      default:
        if (f.max_length && t.length > f.max_length) return { error: `Es demasiado largo: máximo ${f.max_length} caracteres.` };
        return { value: t, text: t };
    }
  }

  let input = null;
  function draw(prefix = '') {
    stopListening();
    if (i < 0) return drawWelcome();
    if (i >= steps.length) return drawSummary(prefix);
    const f = steps[i];
    progress.textContent = `Pregunta ${i + 1} de ${steps.length}`;
    const qText = question(f);
    const multiline = f.type === 'textarea';
    const prev = answers[f.key];
    input = multiline ? h('textarea.voice-input', { rows: 3, value: prev ? String(prev.raw ?? prev.text) : '' })
      : h('input.voice-input', { type: 'text', value: prev ? String(prev.raw ?? prev.text) : '', autocomplete: 'off', inputmode: f.type === 'phone' ? 'tel' : f.type === 'email' ? 'email' : undefined });
    input.id = 'voice-q';
    const err = h('p.voice-error', { id: 'voice-err', role: 'alert' });
    const hint = h('p.voice-hint', { id: 'voice-hint' }, prefix);
    input.setAttribute('aria-describedby', 'voice-hint voice-err');
    clear(stage,
      h('label.voice-q', { for: 'voice-q' }, `${i + 1}. ${qText}`),
      input, err, hint,
      h('div.voice-btns',
        h('button.btn', { type: 'button', onclick: back }, '← Atrás (Esc)'),
        h('button.btn', { type: 'button', onclick: () => speak(qText) }, '🔊 Repetir (F2)'),
        canDictate ? h('button.btn', { type: 'button', onclick: dictate }, '🎤 Dictar (F3)') : null,
        h('div.spacer'),
        h('button.btn.primary', { type: 'button', onclick: next }, fromSummary ? 'Volver al resumen (Intro)' : 'Siguiente (Intro)')));
    input.focus();
    speak(`${prefix ? prefix + ' ' : ''}${i + 1} de ${steps.length}. ${qText}`);
  }
  function drawWelcome() {
    progress.textContent = '';
    const btn = h('button.btn.primary.voice-start', { type: 'button', onclick: () => { i = 0; draw(); } }, '▶ Empezar (Intro)');
    clear(stage, h('p.voice-q', `Vamos a recoger un ${meta.app.name.toLowerCase().replace(/s$/, '')} nuevo. Te haré ${steps.length} preguntas. Contesta escribiendo y pulsa Intro. Esc vuelve atrás.`), btn);
    btn.focus();
    speak(`Asistente de ${meta.app.name}. Te haré ${steps.length} preguntas. Pulsa Intro para empezar.`);
  }
  function drawSummary(prefix = '') {
    progress.textContent = 'Resumen';
    const lines = steps.map((f, n) => ({ n: n + 1, f, s: spoken(f, answers[f.key]) }));
    const saveBtn = h('button.btn.primary.voice-start', { type: 'button', onclick: save }, '💾 Guardar (Intro)');
    clear(stage,
      h('h2.voice-q', { id: 'voice-sum', tabindex: '-1' }, 'Resumen: comprueba los datos'),
      h('ol.voice-summary', lines.map(({ n, f, s }) => h('li', h('button.btn.ghost', { type: 'button', 'aria-label': `Corregir ${f.label}: ${s}`, onclick: () => { fromSummary = true; i = n - 1; draw(); } },
        h('strong', `${f.label}: `), answers[f.key] && answers[f.key].text ? answers[f.key].text : '—')))),
      h('p.voice-hint', 'Intro = guardar · número = corregir ese dato · Esc = volver a la última pregunta'),
      h('div.voice-btns', h('button.btn', { type: 'button', onclick: back }, '← Atrás (Esc)'), h('div.spacer'), saveBtn));
    saveBtn.focus();
    speak(`${prefix ? prefix + ' ' : ''}Resumen. ${lines.map((l) => `${l.n}, ${l.f.label}: ${l.s}`).join('. ')}. Pulsa Intro para guardar, o el número de un dato para corregirlo.`);
  }

  function next() {
    if (i < 0) { i = 0; return draw(); }
    if (i >= steps.length) return save();
    const f = steps[i];
    const r = interpret(f, input.value);
    if (r.error) { stage.querySelector('#voice-err').textContent = r.error; speak(r.error); input.focus(); return; }
    answers[f.key] = { ...r, raw: input.value };
    const said = `${f.label}: ${spoken(f, r)}.`;
    if (fromSummary) { fromSummary = false; i = steps.length; return draw(said); }
    i += 1;
    draw(said);
  }
  function back() {
    if (i <= 0) { speak('Es la primera pregunta.'); return; }
    fromSummary = false;
    i = Math.min(i, steps.length) - 1;
    draw();
  }

  // dictado con el micrófono (Chrome/Edge con HTTPS; el audio lo transcribe el servicio del navegador)
  let rec = null;
  function stopListening() { if (rec) { try { rec.abort(); } catch { /* nada */ } rec = null; } }
  function dictate() {
    if (!canDictate || i < 0 || i >= steps.length) return;
    stopSpeaking(); stopListening();
    const f = steps[i];
    rec = new SR(); rec.lang = 'es-ES'; rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onresult = (e) => { const t = fromDictation(f, e.results[0][0].transcript); input.value = t; speak(`He entendido: ${f.type === 'email' ? sayEmail(t) : f.type === 'phone' ? sayPhone(t) : t}. Intro para aceptar.`); input.focus(); };
    rec.onerror = (e) => speak(e.error === 'not-allowed' ? 'No hay permiso para usar el micrófono.' : 'No te he entendido. Pulsa F3 para repetir o escríbelo.');
    rec.onend = () => { rec = null; };
    announce('Escuchando');
    rec.start();
  }

  async function save() {
    const data = {};
    for (const f of fields) { const a = answers[f.key]; if (a && a.value !== '') data[f.key] = a.value; }
    // título automático si no se pregunta: la descripción (o el primer texto contestado)
    const tf = meta.app.title_field;
    if (tf && !(tf in data)) {
      const src = [...fields.filter((f) => f.type === 'textarea'), ...fields.filter((f) => f.type === 'text')].map((f) => data[f.key]).find(Boolean);
      data[tf] = src ? String(src).replace(/\s+/g, ' ').slice(0, 80) : meta.app.name;
    }
    // estado inicial: la primera opción abierta
    const sf = meta.app.status_field && fieldsByKey[meta.app.status_field];
    if (sf && !(sf.key in data)) {
      let closed = []; try { closed = JSON.parse(meta.app.closed_values || '[]'); } catch { closed = []; }
      const first = (sf.options.choices || []).find((c) => !closed.includes(c));
      if (first) data[sf.key] = first;
    }
    const center = centerStep ? answers._center && answers._center.value : (meta.centers[0] ? meta.centers[0].id : null);
    try {
      const r = await api(`/apps/${key}/records`, { method: 'POST', body: { center_id: center || null, data } });
      const again = h('button.btn.primary.voice-start', { type: 'button', onclick: () => { for (const k of Object.keys(answers)) delete answers[k]; i = 0; draw(); } }, '＋ Recoger otro (Intro)');
      progress.textContent = '';
      clear(stage, h('p.voice-q.voice-ok', `✔ Guardado con el número ${r.number}.`), h('div.voice-btns', again, h('a.btn', { href: `#/app/${key}` }, 'Ver la lista')));
      again.focus();
      speak(`Guardado con el número ${String(r.number).split('').join(' ')}. Pulsa Intro para recoger otro.`);
    } catch (e) {
      toastErr(e);
      speak(`No se ha podido guardar: ${e.message}`);
    }
  }

  // teclado
  root.addEventListener('keydown', (e) => {
    if (!root.contains(stage)) return;
    if (e.target.tagName === 'SELECT' || (e.target.type === 'checkbox')) return;
    if (e.key === 'F2') { e.preventDefault(); if (i >= 0 && i < steps.length) speak(question(steps[i])); else draw(); return; }
    if (e.key === 'F3') { e.preventDefault(); dictate(); return; }
    if (e.key === 'Escape') { e.preventDefault(); back(); return; }
    if (i >= steps.length && /^[1-9]$/.test(e.key) && Number(e.key) <= steps.length && e.target.tagName !== 'INPUT') {
      e.preventDefault(); fromSummary = true; i = Number(e.key) - 1; draw(); return;
    }
    if (e.key === 'Enter' && !e.shiftKey && (e.target === input || e.target.classList.contains('voice-input'))) { e.preventDefault(); next(); }
  });
  window.addEventListener('hashchange', () => { stopSpeaking(); stopListening(); }, { once: true });
  draw();
}
