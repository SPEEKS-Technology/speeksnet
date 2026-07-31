const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, 'mg', 'xl');

function decode(s) {
  return s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
          .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
          .replace(/&amp;/g, '&');
}

// shared strings
const ssXml = fs.readFileSync(path.join(root, 'sharedStrings.xml'), 'utf8');
const shared = [];
for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
  let txt = '';
  for (const t of m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) txt += t[1];
  shared.push(decode(txt));
}

// workbook sheet order + rels
const wb = fs.readFileSync(path.join(root, 'workbook.xml'), 'utf8');
const rels = fs.readFileSync(path.join(root, '_rels', 'workbook.xml.rels'), 'utf8');
const relMap = {};
for (const m of rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) relMap[m[1]] = m[2];
const sheets = [];
for (const m of wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/>/g)) {
  sheets.push({ name: decode(m[1]), file: relMap[m[2]] });
}

function colToNum(c) { let n = 0; for (const ch of c) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }

function parseSheet(file) {
  const xml = fs.readFileSync(path.join(root, file.replace(/^\/?xl\//, '')), 'utf8');
  const rows = {};
  for (const rm of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rn = +rm[1];
    const cells = {};
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] || '', body = cm[2] || '';
      const colM = attrs.match(/r="([A-Z]+)\d+"/);
      if (!colM) continue;
      const col = colM[1];
      const isStr = /t="s"/.test(attrs);
      const isInline = /t="(str|inlineStr)"/.test(attrs);
      let val = null;
      const vm = body.match(/<v>([\s\S]*?)<\/v>/);
      const im = body.match(/<is>([\s\S]*?)<\/is>/);
      if (isStr && vm) val = shared[+vm[1]];
      else if (im) { let t = ''; for (const x of im[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) t += x[1]; val = decode(t); }
      else if (vm) val = decode(vm[1]);
      const f = body.match(/<f[^>]*>([\s\S]*?)<\/f>/);
      if (val !== null && String(val).trim() !== '') cells[col] = { v: val, f: f ? decode(f[1]) : null };
    }
    if (Object.keys(cells).length) rows[rn] = cells;
  }
  return rows;
}

const out = {};
for (const s of sheets) out[s.name] = parseSheet(s.file);
fs.writeFileSync(path.join(__dirname, 'sheets.json'), JSON.stringify(out, null, 1));

for (const s of sheets) {
  const rows = out[s.name];
  const nums = Object.keys(rows).map(Number).sort((a, b) => a - b);
  const cols = new Set();
  nums.forEach(n => Object.keys(rows[n]).forEach(c => cols.add(c)));
  const maxCol = [...cols].sort((a, b) => colToNum(a) - colToNum(b)).pop();
  console.log(`SHEET "${s.name}": ${nums.length} non-empty rows, last row ${nums[nums.length - 1]}, cols A..${maxCol}`);
}
