// Builds prototypes/listing-capacity-sandbox.html.
//
// The point of this generator is that it does NOT reimplement the engine. It
// slices ListingGoalsEngine (and the two helpers it leans on) straight out of
// speeks.js and inlines the source, so the sandbox and production cannot drift:
// if a goal is wrong in the sandbox it is wrong on the site.
//
//   node prototypes/build-capacity-sandbox.js [stores.json]
//
// stores.json is the live payload from
//   store-targets?action=capacity   (rosters, hours, capacity)
// merged with the plain GET (this week's target). Regenerate it when the roster
// changes; the file is checked in so the sandbox opens without network access.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'speeks.js'), 'utf8');

function slice(startRe, endMark) {
  const i = src.search(startRe);
  if (i < 0) throw new Error('could not find ' + startRe);
  const j = src.indexOf(endMark, i);
  return src.slice(i, j + endMark.length);
}

const engine = slice(/const ListingGoalsEngine = \{/, '\n};');
const helpers = [
  slice(/function _isWorkingRole\(role\) \{/, '\n}'),
  slice(/function goalDateObj\(s\) \{/, '\n}'),
].join('\n\n');

const dataPath = process.argv[2] || path.join(__dirname, 'capacity-stores.json');
const stores = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

const html = `<title>Listing capacity sandbox</title>
<style>
  :root {
    --bg:#f6f8f7; --card:#fff; --ink:#1f2933; --muted:#6b7a86; --line:#e3e9e6;
    --sage:#2f7a5f; --sage-soft:#e8f2ed; --amber:#b8860b; --red:#c0392b;
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:28px 20px 60px; background:var(--bg); color:var(--ink);
         font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
  .wrap { max-width:1180px; margin:0 auto; }
  h1 { font-size:22px; margin:0 0 4px; letter-spacing:-.01em; }
  .sub { color:var(--muted); font-size:13px; margin:0 0 22px; }
  .note { background:#fff8e6; border:1px solid #f0e0b0; border-radius:10px;
          padding:12px 14px; font-size:13px; margin:0 0 22px; color:#6b5518; }
  .note b { color:#4a3a10; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px;
          padding:18px 20px 20px; margin-bottom:18px; }
  .head { display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; margin-bottom:14px; }
  .head h2 { font-size:17px; margin:0; }
  .pill { font-size:12px; background:var(--sage-soft); color:var(--sage);
          padding:3px 9px; border-radius:20px; font-weight:600; }
  .scroll { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; min-width:760px; font-size:13px; }
  th, td { padding:7px 8px; text-align:center; border-bottom:1px solid var(--line); }
  th:first-child, td:first-child { text-align:left; white-space:nowrap; padding-left:2px; }
  thead th { font-size:11px; text-transform:uppercase; letter-spacing:.04em;
             color:var(--muted); font-weight:600; }
  tbody tr:last-child td { border-bottom:none; }
  .who { font-weight:600; }
  .tag { font-size:10.5px; color:var(--muted); font-weight:400; display:block; }
  select { font:inherit; font-size:12px; padding:3px 4px; border:1px solid var(--line);
           border-radius:6px; background:#fff; color:var(--ink); width:64px; }
  .g { display:block; font-size:11px; color:var(--sage); font-weight:700; margin-top:2px;
       min-height:14px; }
  .g.zero { color:var(--muted); font-weight:400; }
  tfoot td { font-weight:700; border-top:2px solid var(--line); border-bottom:none;
             padding-top:10px; }
  .totals { margin-top:14px; display:flex; gap:26px; flex-wrap:wrap; font-size:13px;
            align-items:baseline; }
  .totals div span { color:var(--muted); font-size:11.5px; text-transform:uppercase;
                     letter-spacing:.04em; display:block; }
  .big { font-size:20px; font-weight:700; }
  .verdict { font-weight:600; }
  .ok { color:var(--sage); } .under { color:var(--amber); } .over { color:var(--red); }
  code { background:#eef2f0; padding:1px 5px; border-radius:4px; font-size:12.5px; }
</style>

<div class="wrap">
<h1>Listing capacity sandbox</h1>
<p class="sub">Real rosters, real hours, and the real <code>ListingGoalsEngine</code> lifted out of
<code>speeks.js</code> at build time — not a reimplementation. Change anyone's seat on any day and
watch the week move.</p>

<div class="note">
<b>What to look for.</b> A weekday lister is 18, backup buyer 6, lead buyer 3 — and a Saturday is
half of each. Nobody's number changes when you change someone else's; that is the whole point of
the rewrite. The <b>week total will not equal the store goal</b>, and that gap is the measurement:
the goal is 75% of what the roster <i>could</i> do, the week total is what you actually staffed.
</div>

<div id="stores"></div>
</div>

<script>
const GOALS_OFF = 'OFF';
${helpers}

${engine}

const STORES = ${JSON.stringify(stores, null, 1)};

// Monday-start week, labelled with this week's real dates so the Saturday factor
// lands on a real Saturday.
const monday = (() => {
  const n = new Date();
  const d = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
})();
const DAYS = Array.from({length:6}, (_, i) => {
  const d = new Date(monday); d.setDate(monday.getDate() + i);
  return { label: d.toLocaleDateString('en-US',{weekday:'short'}),
           date: d.toLocaleDateString('en-US'),
           sat: d.getDay() === 6 };
});

// Seed a REALISTIC week, not a full one — nobody works all six days.
//
// Days present come from the person's own hours (40h = 5 days, 25h = 3, 20h = 3
// rounded up from 2.5), days off are staggered so the store is never empty, and
// each day's seats are then handed out in the engine's own priority order:
// B1 first, then B2, then everyone left is a lister. Coverage should land near
// 100% — if it does not, the model and the staffing disagree, which is the whole
// thing worth looking at.
const ROLES = ['-','B1','B2','L1','L2','L3','OFF'];
const SEATS = ['B1','B2','L1','L2','L3','L4'];
const state = {};
STORES.forEach(s => {
  ListingGoalsEngine.applyConfig({
    store: s.store,
    newHires: s.people.filter(p => p.newHire).map(p => p.name),
  });

  const present = s.people.map((p, i) => {
    const days = Math.max(1, Math.min(DAYS.length, Math.round(p.hours / 8)));
    const off = new Set();
    for (let k = 0; k < DAYS.length - days; k++) off.add((i + k * 2) % DAYS.length);
    return DAYS.map((_, d) => !off.has(d));
  });

  state[s.store] = s.people.map(() => DAYS.map(() => GOALS_OFF));
  DAYS.forEach((_, d) => {
    let seat = 0;
    s.people.forEach((p, i) => {
      if (!present[i][d]) return;
      state[s.store][i][d] = SEATS[seat] || 'L4';
      seat++;
    });
  });
});

function render() {
  document.getElementById('stores').innerHTML = STORES.map((s, si) => {
    const rows = s.people.map((p, pi) => {
      const cells = DAYS.map((d, di) => {
        const role = state[s.store][pi][di];
        const g = ListingGoalsEngine.goalFor(role, d.date, { employee: p.name, store: s.store });
        return '<td><select data-s="'+si+'" data-p="'+pi+'" data-d="'+di+'">' +
          ROLES.map(r => '<option'+(r===role?' selected':'')+'>'+r+'</option>').join('') +
          '</select><span class="g'+(g?'':' zero')+'">'+(g||'—')+'</span></td>';
      }).join('');
      const tags = [];
      if (p.employment === 'part_time') tags.push('part-time · 20h');
      else if (p.floater) tags.push('floater · '+p.hours+'h');
      else tags.push('full-time · 40h');
      if (p.newHire) tags.push('new hire — lister rate 1/hr');
      const wk = DAYS.reduce((t,d,di) =>
        t + ListingGoalsEngine.goalFor(state[s.store][pi][di], d.date, { employee:p.name, store:s.store }), 0);
      return '<tr><td class="who">'+p.name+'<span class="tag">'+tags.join(' · ')+'</span></td>' +
             cells + '<td><b>'+wk+'</b></td></tr>';
    }).join('');

    const dayTotals = DAYS.map((d, di) => s.people.reduce((t,p,pi) =>
      t + ListingGoalsEngine.goalFor(state[s.store][pi][di], d.date, { employee:p.name, store:s.store }), 0));
    const weekTotal = dayTotals.reduce((a,b)=>a+b,0);
    const pct = s.target ? Math.round((weekTotal / s.target) * 100) : 0;
    const cls = pct >= 97 && pct <= 108 ? 'ok' : (pct < 97 ? 'under' : 'over');

    return '<div class="card"><div class="head"><h2>'+s.store+'</h2>' +
      '<span class="pill">'+s.hours+' roster hours</span>' +
      '<span class="pill">ceiling '+s.capacity+'</span>' +
      '<span class="pill">goal '+s.target+'</span></div>' +
      '<div class="scroll"><table><thead><tr><th>Who</th>' +
      DAYS.map(d=>'<th>'+d.label+(d.sat?' ½':'')+'</th>').join('') +
      '<th>Week</th></tr></thead><tbody>'+rows+'</tbody>' +
      '<tfoot><tr><td>Staffed total</td>' + dayTotals.map(t=>'<td>'+t+'</td>').join('') +
      '<td>'+weekTotal+'</td></tr></tfoot></table></div>' +
      '<div class="totals">' +
      '<div><span>Capacity ceiling</span><b class="big">'+s.capacity+'</b></div>' +
      '<div><span>Week goal (75%)</span><b class="big">'+s.target+'</b></div>' +
      '<div><span>As staffed above</span><b class="big">'+weekTotal+'</b></div>' +
      '<div><span>Coverage</span><b class="big verdict '+cls+'">'+pct+'%</b></div>' +
      '</div></div>';
  }).join('');
}

document.addEventListener('change', e => {
  const t = e.target;
  if (t.tagName !== 'SELECT') return;
  state[STORES[t.dataset.s].store][t.dataset.p][t.dataset.d] = t.value;
  render();
});

render();
</script>
`;

const outPath = path.join(__dirname, 'listing-capacity-sandbox.html');
fs.writeFileSync(outPath, html);
console.log('wrote ' + outPath + ' (' + (html.length / 1024).toFixed(1) + ' kB)');
console.log('engine slice: ' + engine.split('\n').length + ' lines, helpers: ' + helpers.split('\n').length);
