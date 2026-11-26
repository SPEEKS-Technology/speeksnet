// Round-trip test for supabase/functions/alerts-hub/webpush.ts, no network.
//   node scripts/alerts-hub-push-test.mjs
// Plays the phone: makes a P-256 key + auth secret like a browser's
// PushSubscription, encrypts with the function's code, then decrypts per
// RFC 8291 with independent code here. Also checks the VAPID JWT verifies with
// the public key and carries the push service's origin as `aud`.
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = stripTypeScriptTypes(readFileSync(join(root, "supabase/functions/alerts-hub/webpush.ts"), "utf8"));
const wp = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));

const te = new TextEncoder(), td = new TextDecoder();
const subtle = crypto.subtle;
let fails = 0;
const t = (name, ok, why = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  — " + why}`); if (!ok) fails++; };
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
async function hkdf(salt, ikm, info, n) {
  const k = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, n * 8));
}

// ---- the "phone" ----
const ua = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const uaPub = new Uint8Array(await subtle.exportKey("raw", ua.publicKey));
const authSecret = crypto.getRandomValues(new Uint8Array(16));
const sub = { endpoint: "https://web.push.apple.com/QGx-test", p256dh: wp.bytesToB64u(uaPub), auth: wp.bytesToB64u(authSecret) };

const message = JSON.stringify({ title: "Reply to 2 eBay buyers", body: "BAL · tap to open", url: "https://speeksnet.com/index.html" });
const blob = await wp.encryptPayload(sub, te.encode(message));

// ---- decrypt as the phone (RFC 8188 header, then RFC 8291 keys) ----
const salt = blob.slice(0, 16);
const rs = new DataView(blob.buffer, blob.byteOffset + 16, 4).getUint32(0);
const idlen = blob[20];
const asPub = blob.slice(21, 21 + idlen);
const ct = blob.slice(21 + idlen);
t("header: record size 4096", rs === 4096, String(rs));
t("header: keyid is a 65-byte uncompressed point", idlen === 65 && asPub[0] === 4, `${idlen}/${asPub[0]}`);

const asKey = await subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
const ecdh = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
const ikm = await hkdf(authSecret, ecdh, cat(te.encode("WebPush: info\0"), uaPub, asPub), 32);
const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
let plain = null;
try {
  const k = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce }, k, ct));
} catch (e) { t("decrypts", false, e.message); }
if (plain) {
  t("last-record delimiter 0x02", plain[plain.length - 1] === 2, String(plain[plain.length - 1]));
  t("payload survives the round trip", td.decode(plain.slice(0, -1)) === message, td.decode(plain.slice(0, -1)));
}
t("fits one 4096-byte record", blob.length < 4096, String(blob.length));

// ---- VAPID ----
const vk = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const vPub = wp.bytesToB64u(new Uint8Array(await subtle.exportKey("raw", vk.publicKey)));
const vJwk = await subtle.exportKey("jwk", vk.privateKey);
const hdr = await wp.vapidAuth(sub.endpoint, vPub, vJwk, "https://speeksnet.com");
const m = hdr.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
t("Authorization header shape", !!m, hdr.slice(0, 40));
if (m) {
  const claims = JSON.parse(td.decode(wp.b64uToBytes(m[2])));
  t("aud is the push service origin", claims.aud === "https://web.push.apple.com", claims.aud);
  t("exp within 24h", claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 86400, String(claims.exp));
  t("sub is the site, not a person", claims.sub === "https://speeksnet.com", claims.sub);
  const ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, vk.publicKey, wp.b64uToBytes(m[3]), te.encode(`${m[1]}.${m[2]}`));
  t("JWT signature verifies with the public key", ok);
  t("k= is the public key", m[4] === vPub);
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
