// Does the border-stripper find a drawn border, and - much more important -
// does it leave alone a photograph that has not got one?
//
// The 14 Apple iPhone photos came out of the printed guide with a 4px line
// baked into the image. The app draws its own frame, so that line landed as a
// second outline just inside the first, and object-fit: cover then cropped it
// unevenly - kept top and bottom, sliced off at the sides. The tool at
// scripts/pg-crop-borders.html trims it away. This is that tool's
// detectInset(), verbatim, with a PNG codec in front of it so the algorithm can
// be exercised without a browser.
//
// The failure that matters is not "misses a border" - that leaves a photo as it
// was, which is harmless. It is "invents a border": a phone photographed on a
// white counter has a uniform margin on all four sides, and ring-matching alone
// walked 24px into one before it stopped. Every guard below exists because of
// that, and the fixtures at the bottom are what hold it shut.
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

// --- the tool's detectInset(), kept identical -------------------------------
const MAX_INSET = 24, TOL = 46, RING_HIT = 0.88, CONTRAST = 70, MAX_FRAC = 0.03;

function detectInset({ w, h, ch, px }) {
    const at = (x, y) => { const o = (y * w + x) * ch; return [px[o], px[o + 1], px[o + 2]]; };
    const diff = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    // Middle of the top edge, not a corner: a corner can be rounded or
    // antialiased, and a 1px border has no pixel at (1,1) at all.
    const ref = at(w >> 1, 0);
    const near = p => diff(p, ref) <= TOL;
    if (!(near(at(w >> 1, h - 1)) && near(at(0, h >> 1)) && near(at(w - 1, h >> 1)))) return 0;
    let k = 0;
    for (; k < MAX_INSET; k++) {
        let hit = 0, tot = 0;
        for (let x = k; x < w - k; x++) {
            tot += 2;
            if (near(at(x, k))) hit++;
            if (near(at(x, h - 1 - k))) hit++;
        }
        for (let y = k + 1; y < h - 1 - k; y++) {
            tot += 2;
            if (near(at(k, y))) hit++;
            if (near(at(w - 1 - k, y))) hit++;
        }
        if (hit / tot < RING_HIT) break;
    }
    if (!k) return 0;
    // Too thick to be a drawn line: that is the backdrop, not a border.
    if (k > Math.max(2, Math.round(MAX_FRAC * Math.min(w, h)))) return 0;
    // A drawn border CONTRASTS with the picture behind it; a plain margin does
    // not. This is the guard that stops a clean photo being eaten.
    if (diff(at(w >> 1, k + 2), ref) < CONTRAST) return 0;
    return k;
}

// --- fixtures ---------------------------------------------------------------
// A phone-ish dark slab on a near-white studio backdrop, optionally ringed.
function shot(w, h, border, colour) {
    const rgb = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 3;
            let c = [248, 250, 252];
            if (x > w * 0.3 && x < w * 0.7 && y > h * 0.15 && y < h * 0.85) c = [24, 24, 28];
            if (border && (x < border || y < border || x >= w - border || y >= h - border)) c = colour;
            rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
        }
    }
    return decode(encode(w, h, rgb));
}

let fails = 0;
const eq = (label, got, want) => {
    const ok = got === want;
    if (!ok) fails++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) console.log(`       got ${got}, want ${want}`);
};

// The real export is the evidence that 4px is what the printout bakes in, but
// it lives on a Desktop that will be tidied up one day. The synthetics carry
// the suite; this is a bonus while the file happens to be there.
const REAL = 'C:/Users/User/Desktop/Picture13.png';
console.log('the real guide export, if it is still on disk');
if (fs.existsSync(REAL)) {
    const d = decode(fs.readFileSync(REAL)), k = detectInset(d);
    eq('Picture13.png is ringed by 4px', k, 4);
    eq('601 wide, less 4px each side', d.w - 2 * k, 593);
    eq('576 tall, less 4px each side', d.h - 2 * k, 568);
    const ratio = (d.w - 2 * k) / (d.h - 2 * k);
    console.log(`       cropped ratio ${ratio.toFixed(3)} in a 1.000 frame, so contain leaves `
        + `${(196 - 196 / ratio).toFixed(1)}px of white matte at 196px, top and bottom`);
} else {
    console.log('skip  not on disk; the synthetic fixtures cover the same ground');
}

console.log('\na drawn border, which it has to find');
eq('4px black', detectInset(shot(602, 576, 4, [0, 0, 0])), 4);
eq('4px guide red', detectInset(shot(602, 576, 4, [227, 0, 0])), 4);
eq('1px hairline', detectInset(shot(602, 576, 1, [0, 0, 0])), 1);
eq('12px slab', detectInset(shot(602, 576, 12, [0, 0, 0])), 12);

console.log('\nno drawn border, which it must not invent');
// The one that matters. A manager photographs a phone on a white counter and
// uploads it: uniform margin on all four sides, and it is NOT a border.
eq('a white studio margin is left alone', detectInset(shot(602, 576, 0, null)), 0);
eq('a single flat colour is left alone',
    detectInset(decode(encode(200, 200, Buffer.alloc(200 * 200 * 3, 7)))), 0);

console.log('\nthe two guards, each doing its own job');
// Thick but contrasting: 30px is past MAX_FRAC of 576, so it reads as backdrop.
eq('a 30px ring is too thick to be a line', detectInset(shot(602, 576, 30, [0, 0, 0])), 0);
// Thin but not contrasting: a ring a shade off the backdrop is a compression
// artefact or a vignette, not a line anybody drew.
eq('a 4px ring that barely contrasts', detectInset(shot(602, 576, 4, [246, 248, 250])), 0);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
