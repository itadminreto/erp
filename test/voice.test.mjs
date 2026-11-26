// Interpretación de fechas del asistente por voz (no necesita base de datos).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate } from '../public/js/voice-parse.js';

const today = new Date(2026, 10, 26); // jueves 26/11/2026
test('fechas en lenguaje natural', () => {
  const cases = {
    hoy: '2026-11-26', 'mañana': '2026-11-27', 'pasado mañana': '2026-11-28', ayer: '2026-11-25',
    'el lunes': '2026-11-30', jueves: '2026-12-03', 'el viernes que viene': '2026-11-27', 'próximo martes': '2026-12-01',
    'dentro de 3 días': '2026-11-29', 'en dos semanas': '2026-12-10', 'dentro de un mes': '2026-12-26',
    '15 de diciembre': '2026-12-15', '3 de enero': '2027-01-03', '1 de noviembre': '2026-11-01', 'quince de diciembre de 2027': '2027-12-15',
    '15/12': '2026-12-15', '15-12-26': '2026-12-15', '2026-12-31': '2026-12-31', '5.1.2027': '2027-01-05',
  };
  for (const [t, want] of Object.entries(cases)) assert.equal(parseDate(t, today), want, t);
  for (const bad of ['31 de febrero', 'cuando puedas', '45/13', '']) assert.equal(parseDate(bad, today), null, bad);
});
