'use strict';
// Parser/generador CSV sin dependencias. Detecta separador ; , o tabulador.

function detectDelimiter(text) {
  const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const counts = { ';': 0, ',': 0, '\t': 0 };
  let q = false;
  for (const ch of first) { if (ch === '"') q = !q; else if (!q && ch in counts) counts[ch]++; }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
}

function parseCSV(text, delimiter) {
  text = text.replace(/^﻿/, '');
  const d = delimiter || detectDelimiter(text);
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === d) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function toCSV(matrix, d = ';') {
  return matrix.map((r) => r.map((v) => {
    const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
    return /[";\n\r,\t]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(d)).join('\r\n');
}

module.exports = { parseCSV, toCSV };
