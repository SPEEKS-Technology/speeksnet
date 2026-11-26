// WEB PUSH, BY HAND (RFC 8291 message encryption + RFC 8292 VAPID)
// ---------------------------------------------------------------------------
// Written against WebCrypto only, deliberately: the usual `web-push` npm
// package leans on node:crypto ECDH, and whether Supabase's edge runtime
// implements that faithfully is a thing you find out in production. WebCrypto
// is the same in Deno, Node 24 and the browser, so this file is also what
// scripts/alerts-hub-push-test.mjs round-trips locally (encrypt here, decrypt
// as the phone would) before anything is deployed.
//
// Keys: VAPID_PUBLIC_KEY is the raw 65-byte P-256 point, base64url (the same
// string the browser passes as applicationServerKey). VAPID_PRIVATE_JWK is the
// matching private key as a JWK (needs d, x, y). Both are Supabase secrets.

export type PushSub = { endpoint: string; p256dh: string; auth: string };
export type PushResult = { ok: boolean; status: number; gone: boolean; error?: string };

const te = new TextEncoder();

export function b64uToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64u(b: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8);
  return new Uint8Array(bits);
}

// RFC 8291 §3.4 / RFC 8188: one record, aes128gcm. `salt` and `asKeys` are
// injectable only so the local test can pin them; production passes neither.
export async function encryptPayload(
  sub: PushSub, plaintext: Uint8Array,
  opts: { salt?: Uint8Array; asKeys?: CryptoKeyPair } = {},
): Promise<Uint8Array> {
  const uaPublic = b64uToBytes(sub.p256dh);
  const authSecret = b64uToBytes(sub.auth);
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const as = opts.asKeys ||
    (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdh, concat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);

  // 0x02 = "last record" delimiter, no further padding.
  const padded = concat(plaintext, new Uint8Array([2]));
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, padded));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

// RFC 8292: a short-lived ES256 JWT for the push service's origin. WebCrypto's
// ECDSA signature is already the raw r||s that JWS wants.
export async function vapidAuth(endpoint: string, publicKeyB64u: string, privateJwk: JsonWebKey, subject: string) {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const enc = (o: unknown) => bytesToB64u(te.encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud, exp, sub: subject })}`;
  const key = await crypto.subtle.importKey(
    "jwk", { ...privateJwk, key_ops: ["sign"], ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(unsigned)));
  return `vapid t=${unsigned}.${bytesToB64u(sig)}, k=${publicKeyB64u}`;
}

export async function sendPush(
  sub: PushSub, payload: unknown,
  vapid: { publicKey: string; privateJwk: JsonWebKey; subject: string },
  opts: { ttl?: number; urgency?: "very-low" | "low" | "normal" | "high"; topic?: string } = {},
): Promise<PushResult> {
  try {
    const body = await encryptPayload(sub, te.encode(JSON.stringify(payload)));
    const headers: Record<string, string> = {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(opts.ttl ?? 86400),
      Urgency: opts.urgency || "normal",
      Authorization: await vapidAuth(sub.endpoint, vapid.publicKey, vapid.privateJwk, vapid.subject),
    };
    // Topic replaces an undelivered message with the same topic (phone off all
    // night → one reminder, not five). Push services cap it at 32 url-safe chars.
    if (opts.topic) headers.Topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
    const res = await fetch(sub.endpoint, { method: "POST", headers, body });
    const text = res.ok ? "" : (await res.text()).slice(0, 300);
    // 404/410 = the phone unsubscribed or the app was deleted: never retry it.
    return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410, error: text || undefined };
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: String((e as Error)?.message || e) };
  }
}
