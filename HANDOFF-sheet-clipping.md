# Handoff: Type select covers the first letter of Brand (B2B pricing sheet)

You have DevTools; I did not. Everything below is already verified, so please
don't re-derive it — go straight to the probes at the bottom.

Branch: `release/v3.6.0`. Cache-buster is currently `20260903h`; bump it in all
six HTML files if you change CSS, or the browser will serve the old file.

---

## Symptom

On the **Price The Pickup** sheet, the `Type` `<select>` paints over the left
edge of the `Brand` cell beside it. The Brand placeholder `Apple` renders as
`pple` — the `A` is hidden underneath the select's opaque white box. Data loss,
not just cosmetics: a real brand value loses its first character too.

Reproduce: `http://localhost:8080/operations.html` → B2B Deals → deal `TEST-001`
(client `test`, pricing stage) → **Price Items**. Any line will do; the sheet
has three.

If localhost isn't running:
`powershell -File <scratchpad>/Serve.ps1 -Port 8080` from the repo, or serve the
repo root any other way. speeksnet.com will NOT show this — the fixes below are
branch-only and `main` doesn't have them.

---

## Fixed at three levels already. It came back each time.

1. **v3.5.4 hotfix `7ceba98`** — freed the *cell*:
   `.b2b-items.b2b-ss .b2b-pcell, .b2b-items.b2b-ss .b2b-phead > span { min-width: 0 }`
   ([styles.css:13547-13548](styles.css#L13547-L13548)). Grid items default to
   `min-width:auto` and refuse to shrink below `min-content`.
2. **This branch** — freed the *field inside* the cell:
   `.b2b-items.b2b-ss .b2b-pcell > input, > select { min-width: 0 }`
   ([styles.css:13555](styles.css#L13555)). The select is a flex item of the
   cell and carries its own `min-width:auto`.
3. **This branch, current** — capped and clipped:
   `max-width: 100%` on those fields, plus
   `.b2b-items.b2b-ss .b2b-pcell { overflow: hidden }`
   ([styles.css:13565](styles.css#L13565)).

**(3) is a backstop, not a diagnosis.** It hides the overflow rather than
explaining it. The goal of this handoff is to find the cause and remove the
`overflow: hidden`, because that rule also clips the focus ring.

---

## Ruled out — please trust these

- **`box-sizing`** is `border-box` globally ([styles.css:37](styles.css#L37)),
  so padding/border can't inflate `width: 100%`.
- **Grid maths is exact.** 16 cells per row, 16 tracks
  ([styles.css:13511](styles.css#L13511)), summing to **exactly 1366px**, which
  matches the `min-width: 1366px` on the rows
  ([styles.css:13524-13525](styles.css#L13524-L13525)). Track list:
  `56 100 minmax(56,.85fr) minmax(74,1fr) 88 58 76 76 58 72 64 122 36 minmax(150,1.15fr) 96 184`.
  Type is the fixed **100px** track; Brand is the `minmax(56px, .85fr)` next to it.
- **No implicit tracks.** The header emits 16 spans plus `sheetSpecs.length`,
  and `sheetSpecs` is hardcoded `[]` ([speeks.js:20533](speeks.js#L20533)) — the
  CPU/RAM/Storage columns were moved into the dropdown in `e3df439`. So the
  count can't drift.
- **Markup is plain** — no wrapper around the select
  ([speeks.js:20600-20603](speeks.js#L20600-L20603)):
  `<span class="b2b-pcell" data-k="Type"><select>…</select></span>`, then
  `<span class="b2b-pcell" data-k="Brand"><input placeholder="Apple" list="b2bdl-make" …></span>`.
- **My CSS is being served** — verified over HTTP, both new rules present.

---

## Hypotheses, most likely first

1. **It was never the select.** `.b2b-pcell input:focus` /
   `select:focus` adds `box-shadow: 0 0 0 3px rgba(31,157,87,.12)`
   ([styles.css:13152-13155](styles.css#L13152-L13155)). In the screenshot the
   select has a *visible border and white background*, which per
   [styles.css:13151-13155](styles.css#L13151-L13155) only happens on `:hover`
   or `:focus` — so the select in that screenshot was focused or hovered. A 3px
   ring reaches 3px into Brand. It's translucent so it shouldn't hide a glyph,
   but the `background: #fff` on the focused select is opaque and *does* cover
   whatever it overlaps.
2. **The datalist arrow.** Brand is `<input list="b2bdl-make">`. Chrome draws a
   picker affordance on such inputs. If it's rendered at the inline-start in
   this build/locale, it would displace the placeholder — which would look
   exactly like a missing first letter and have nothing to do with the select.
3. **The select genuinely overflows** despite `min-width:0` + `max-width:100%`
   — a UA-stylesheet interaction on `<select>` specifically. Least likely now,
   but the probe below settles it in one line.

---

## Probes — run these on the open sheet

```js
// 1. Geometry. Does the select actually cross into Brand?
(() => { const c=document.querySelector('.b2b-ss .b2b-pline .b2b-pcell[data-k="Type"]'),
 s=c&&c.querySelector('select'),
 b=document.querySelector('.b2b-ss .b2b-pline .b2b-pcell[data-k="Brand"]'),
 i=b&&b.querySelector('input');
 const r=e=>{const x=e.getBoundingClientRect();return {l:Math.round(x.left),r:Math.round(x.right),w:Math.round(x.width)};};
 return {typeCell:r(c), select:r(s), brandCell:r(b), brandInput:r(i),
   overlapPx: Math.round(s.getBoundingClientRect().right - b.getBoundingClientRect().left),
   tpl:getComputedStyle(document.querySelector('.b2b-ss')).gridTemplateColumns}; })()
```

`overlapPx > 0` ⇒ hypothesis 3, the select really is too wide. Report the
number. `overlapPx <= 0` ⇒ the select is innocent; go to probe 2.

```js
// 2. Is it the focus ring / hover background? Blur everything, then re-measure
//    and look at the sheet with nothing focused and the mouse away from it.
document.activeElement && document.activeElement.blur();
```

If `pple` becomes `Apple` once nothing is focused, it's hypothesis 1 and the fix
is to make the ring inset (`box-shadow: inset 0 0 0 2px …`) on sheet cells only,
rather than clipping the cell.

```js
// 3. Rule out the datalist picker on Brand.
(() => { const i=document.querySelector('.b2b-ss .b2b-pline .b2b-pcell[data-k="Brand"] input');
 i.removeAttribute('list'); return 'list attr removed — does the A come back?'; })()
```

If the `A` returns, it's hypothesis 2: keep the datalist but give the input
`padding-left` room, or drop `list=` on the sheet build and keep it only on the
card view.

---

## What I'd like back

The `overlapPx` number and which of the three probes changed the rendering.
That's enough to fix the cause and delete
`.b2b-items.b2b-ss .b2b-pcell { overflow: hidden }`
([styles.css:13565](styles.css#L13565)), which is the only line here I'm not
happy about.

Please leave `min-width: 0` and `max-width: 100%` in place either way — both are
correct on their own merits.
