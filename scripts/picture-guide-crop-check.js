// Does the border-stripper find the line the printout drew, and - much more
// important - does it leave alone a photograph that has not got one?
//
// The guide exports carry a border baked into the image. The board draws its
// own frame, so that line arrives as a second outline just inside the first,
// and object-fit then crops it unevenly. scripts/pg-crop-borders.html trims it
// away; this is that tool's detectInset(), verbatim, with a PNG codec in front
// of it so the algorithm can be exercised without a browser.
//
// TWO THINGS THIS FILE EXISTS TO REMEMBER, both learned the hard way:
//
// 1. The border is not one colour. Measuring the real exports through a browser
//    showed a 1px antialias FRINGE outside the drawn line - and on the red ones
//    a second fringe INSIDE it too, which is why red borders are 5px and black
//    ones are 4px. An algorithm anchored on the outermost row locks onto the
//    fringe and stops after 1px. That shipped once.
//
// 2. A percentage test cannot tell a border from a backdrop. "What fraction of
//    this ring is the interior colour" scores anywhere from 71% to 100% on a
//    genuine interior ring, depending on how close the subject and its shadow
//    come to the edge. Comparing ring MEDIANS is what works: a drawn border
//    covers its whole ring, so its median IS its colour, while a photograph's
//    outermost ring is mostly backdrop and the median shrugs the subject off.
//
// The failure that matters is not "misses a border" - that leaves a photo as it
// was, which is harmless. It is "invents a border": a phone photographed on a
// white counter has a uniform margin on all four sides, and an early version of
// this walked 24px into one. The guards at the bottom hold that shut.
const fs = require('fs'), zlib = require('zlib');

// --- PNG decode, 8-bit non-interlaced ---------------------------------------
function decode(buf) {
    let i = 8, w, h, bd, ct, idat = [];
    while (i < buf.length) {
        const len = buf.readUInt32BE(i), t = buf.toString('ascii', i + 4, i + 8);
        if (t === 'IHDR') {
            w = buf.readUInt32BE(i + 8); h = buf.readUInt32BE(i + 12);
            bd = buf[i + 16]; ct = buf[i + 17];
        } else if (t === 'IDAT') idat.push(buf.slice(i + 8, i + 8 + len));
        else if (t === 'IEND') break;
        i += 12 + len;
    }
    const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
    if (bd !== 8 || !ch) throw new Error('unsupported PNG');
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = w * ch, px = Buffer.alloc(h * stride);
    const paeth = (a, b, c) => {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    for (let y = 0; y < h; y++) {
        const ft = raw[y * (stride + 1)];
        const ln = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
        for (let x = 0; x < stride; x++) {
            const A = x >= ch ? px[y * stride + x - ch] : 0;
            const B = y > 0 ? px[(y - 1) * stride + x] : 0;
            const C = (x >= ch && y > 0) ? px[(y - 1) * stride + x - ch] : 0;
            let v = ln[x];
            if (ft === 1) v += A;
            else if (ft === 2) v += B;
            else if (ft === 3) v += (A + B) >> 1;
            else if (ft === 4) v += paeth(A, B, C);
            px[y * stride + x] = v & 255;
        }
    }
    return { w, h, ch, px };
}

// --- PNG encode, 8-bit RGB, filter 0, so fixtures need no image library -----
function encode(w, h, rgb) {
    const chunk = (t, d) => {
        const b = Buffer.alloc(8 + d.length + 4);
        b.writeUInt32BE(d.length, 0);
        b.write(t, 4, 'ascii');
        d.copy(b, 8);
        b.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(t, 'ascii'), d])), 8 + d.length);
        return b;
    };
    const ih = Buffer.alloc(13);
    ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4);
    ih[8] = 8; ih[9] = 2;
    const lines = Buffer.alloc(h * (w * 3 + 1));
    for (let y = 0; y < h; y++) {
        lines[y * (w * 3 + 1)] = 0;
        rgb.copy(lines, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
    }
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ih),
        chunk('IDAT', zlib.deflateSync(lines)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// --- the tool's detectInset(), kept identical --------------------------------
const MAX_INSET = 24, TOL = 46, CONTRAST = 70, MAX_FRAC = 0.03;

function ringCols(img, k) {
    const { w, h, ch, px } = img, out = [];
    const at = (x, y) => { const o = (y * w + x) * ch; return [px[o], px[o + 1], px[o + 2]]; };
    for (let x = k; x < w - k; x++) { out.push(at(x, k)); out.push(at(x, h - 1 - k)); }
    for (let y = k + 1; y < h - 1 - k; y++) { out.push(at(k, y)); out.push(at(w - 1 - k, y)); }
    return out;
}
const median = list => [0, 1, 2].map(c => {
    const v = list.map(p => p[c]).sort((a, b) => a - b);
    return v[v.length >> 1];
});
const diff = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

function detectInset(img) {
    const { w, h } = img;
    // Anchor on the INTERIOR, never on row 0: whatever colour the photograph's
    // own edge is, walk in from the outside until a ring finally looks like it.
    // Everything outside that is whatever the printout drew, fringe and line
    // together, however many colours it happens to be made of.
    const D = Math.min(MAX_INSET + 2, (Math.min(w, h) >> 1) - 1);
    const refIn = median(ringCols(img, D));
    let k = 0;
    for (; k < MAX_INSET; k++) {
        if (diff(median(ringCols(img, k)), refIn) <= TOL) break;
    }
    if (!k || k >= MAX_INSET) return 0;
    // Too thick to be a drawn line: that is the backdrop, not a border.
    if (k > Math.max(2, Math.round(MAX_FRAC * Math.min(w, h)))) return 0;
    // A drawn border CONTRASTS with the picture behind it; a plain margin does
    // not. This is the guard that stops a clean photo being eaten.
    let worst = 0;
    for (let j = 0; j < k; j++) worst = Math.max(worst, diff(median(ringCols(img, j)), refIn));
    if (worst < CONTRAST) return 0;
    return k;
}

// --- fixtures ---------------------------------------------------------------
// A phone-ish dark slab on a near-white studio backdrop, wrapped in `bands`:
// [[thickness, rgb], ...] from the outside in, so the real exports' fringe over
// line over fringe can be reproduced exactly.
function shot(w, h, bands, opts) {
    opts = opts || {};
    // The real studio backdrop measures around here - NOT near-white. Getting
    // this wrong hides the whole point of the fringe fixtures: a 248 fringe on
    // a 250 backdrop is invisible, so the fixture passes for the wrong reason.
    const backdrop = opts.backdrop || [203, 202, 198];
    const depth = [];
    bands.forEach(([n, c]) => { for (let i = 0; i < n; i++) depth.push(c); });
    const rgb = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 3;
            let c = backdrop;
            // Subject, optionally running clean off the edge of the frame.
            const x0 = opts.bleed ? -1 : w * 0.3, x1 = opts.bleed ? w * 0.75 : w * 0.7;
            if (x > x0 && x < x1 && y > h * 0.15 && y < h * 0.85) c = [24, 24, 28];
            const d = Math.min(x, y, w - 1 - x, h - 1 - y);
            if (d < depth.length) c = depth[d];
            rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
        }
    }
    return decode(encode(w, h, rgb));
}

let fails = 0;
const eq = (label, got, want) => {
    const ok = got === want;
    if (!ok) fails++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}  ->  ${got}${ok ? '' : '  (want ' + want + ')'}`);
};

const WHITE_FRINGE = [248, 248, 248];
const PINK_FRINGE = [255, 183, 180];
const BLACK_LINE = [0, 0, 0];
const RED_LINE = [227, 12, 12];

console.log('the two shapes the real guide exports actually have');
// Measured off all 14 photographs as a browser decodes them. These are not
// guesses: the black ones came back 4, the red ones 5, every time.
eq('black: 1px white fringe over a 3px line',
    detectInset(shot(602, 576, [[1, WHITE_FRINGE], [3, BLACK_LINE]])), 4);
eq('red: fringe, 3px line, and a fringe INSIDE it too',
    detectInset(shot(602, 576, [[1, PINK_FRINGE], [3, RED_LINE], [1, PINK_FRINGE]])), 5);
eq('the same red band over a dark screenshot',
    detectInset(shot(602, 576, [[1, PINK_FRINGE], [3, RED_LINE], [1, PINK_FRINGE]],
        { backdrop: [29, 29, 31] })), 5);

console.log('\na plain drawn border, with no fringe at all');
eq('4px black', detectInset(shot(602, 576, [[4, BLACK_LINE]])), 4);
eq('4px guide red', detectInset(shot(602, 576, [[4, RED_LINE]])), 4);
eq('1px hairline', detectInset(shot(602, 576, [[1, BLACK_LINE]])), 1);
eq('12px slab', detectInset(shot(602, 576, [[12, BLACK_LINE]])), 12);

console.log('\nno drawn border, which it must not invent');
// The one that matters. A manager photographs a phone on a white counter and
// uploads it: uniform margin on all four sides, and it is NOT a border.
eq('a white studio margin, subject clear of the edge',
    detectInset(shot(602, 576, [])), 0);
// And the case that broke the percentage test: the subject running off the
// frame drags a true interior ring down to ~71% interior-coloured.
eq('a white studio margin, subject bleeding off frame',
    detectInset(shot(602, 576, [], { bleed: true })), 0);
eq('a single flat colour',
    detectInset(decode(encode(200, 200, Buffer.alloc(200 * 200 * 3, 7)))), 0);

console.log('\nthe two guards, each doing its own job');
// Thick but contrasting: 30px is past MAX_FRAC of 576, so it reads as backdrop.
eq('a 30px ring is too thick to be a line',
    detectInset(shot(602, 576, [[30, BLACK_LINE]])), 0);
// Thin but not contrasting: a ring a shade off the backdrop is a compression
// artefact or a vignette, not a line anybody drew.
eq('a 4px ring that barely contrasts',
    detectInset(shot(602, 576, [[4, [208, 207, 203]]])), 0);

// --- the second job: one size for the whole batch ---------------------------
// A frame can only be one shape, and the exports come back a few pixels apart -
// 591x565 to 597x571 across the fourteen. So the pictures agree on a size
// first, by centre-cropping to the largest one they can all give, and the
// frame's aspect-ratio is set to that. Cropped rather than scaled: nothing is
// resampled, and no photo is stretched into a shape it was never shot in.
const batchTarget = shots => ({
    w: Math.min(...shots.map(s => s.w - 2 * s.inset)),
    h: Math.min(...shots.map(s => s.h - 2 * s.inset)),
});
const cropWindow = (s, t) => ({
    sx: Math.round(s.inset + ((s.w - 2 * s.inset) - t.w) / 2),
    sy: Math.round(s.inset + ((s.h - 2 * s.inset) - t.h) / 2),
});

// The real batch: measured sizes with the border insets this file verifies.
const BATCH = [
    { w: 602, h: 576, inset: 4 }, { w: 601, h: 575, inset: 5 },
    { w: 602, h: 576, inset: 4 }, { w: 601, h: 576, inset: 4 },
    { w: 602, h: 579, inset: 4 }, { w: 602, h: 575, inset: 5 },
    { w: 602, h: 575, inset: 4 }, { w: 605, h: 575, inset: 4 },
    { w: 605, h: 575, inset: 4 }, { w: 602, h: 576, inset: 4 },
    { w: 602, h: 576, inset: 4 }, { w: 602, h: 576, inset: 4 },
    { w: 601, h: 576, inset: 4 }, { w: 602, h: 575, inset: 5 },
];

console.log('\none size for the whole batch');
const t = batchTarget(BATCH);
eq('the size all fourteen can share', `${t.w}x${t.h}`, '591x565');

let offsetsOk = 0, insideOk = 0;
for (const s of BATCH) {
    const { sx, sy } = cropWindow(s, t);
    // The window must sit inside the image, and clear of the drawn border.
    if (sx >= s.inset && sy >= s.inset) insideOk++;
    if (sx + t.w <= s.w - s.inset && sy + t.h <= s.h - s.inset) offsetsOk++;
}
eq('every window starts inside the border', insideOk, 14);
eq('every window ends inside the border', offsetsOk, 14);
eq('nothing is trimmed by more than 3px a side',
    Math.max(...BATCH.map(s => (s.w - 2 * s.inset - t.w) / 2)) <= 3, true);

// The one thing that can silently come apart later: the photos are one shape
// and the frame is set to another. Nothing in the app would complain - the
// board would just quietly grow a gap again, which is where this whole thread
// started. So read the stylesheet and make it say so out loud.
console.log('\nthe stylesheet agrees with the pictures');
const css = fs.readFileSync(require('path').join(__dirname, '..', 'styles.css'), 'utf8');
const rule = css.slice(css.indexOf('.pg-frame {'), css.indexOf('}', css.indexOf('.pg-frame {')));
const ar = (rule.match(/aspect-ratio:\s*([0-9.]+)\s*\/\s*([0-9.]+)/) || []).slice(1);
eq('.pg-frame declares an aspect-ratio', ar.length, 2);
eq('and it is the batch size', `${ar[0]} / ${ar[1]}`, `${t.w} / ${t.h}`);
eq('so a 290px card leaves nothing over',
    Math.round(Math.abs(290 - 290 * ((t.w / t.h) / (+ar[0] / +ar[1]))) * 100) / 100, 0);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
