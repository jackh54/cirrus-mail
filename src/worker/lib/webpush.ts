// Web Push with WebCrypto only: RFC 8291 message encryption (aes128gcm), RFC 8292 VAPID, and the endpoint allowlist.
import { fromBase64Url, toBase64Url } from './crypto';

const enc = new TextEncoder();

/** Record size advertised in the aes128gcm header. The whole payload is one record. */
const RECORD_SIZE = 4096;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** HKDF-SHA256 with a single output block (length ≤ 32), as RFC 8291 writes it out. */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const prk = await hmacSha256(salt, ikm);
  return (await hmacSha256(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

export interface EncryptOptions {
  /** The application server's ephemeral ECDH key pair. Random when omitted; injectable for test vectors. */
  ephemeral?: CryptoKeyPair;
  /** 16-byte salt. Random when omitted; injectable for test vectors. */
  salt?: Uint8Array;
}

/**
 * Encrypts `plaintext` for a subscription (RFC 8291, aes128gcm content coding, RFC 8188).
 * `p256dh` is the user agent's uncompressed P-256 public key and `auth` its 16-byte secret, both base64url.
 */
export async function encryptPayload(plaintext: Uint8Array, p256dh: string, auth: string, opts: EncryptOptions = {}): Promise<Uint8Array> {
  const uaPublic = fromBase64Url(p256dh);
  const authSecret = fromBase64Url(auth);
  if (uaPublic.byteLength !== 65 || uaPublic[0] !== 4) throw new Error('invalid p256dh');
  if (authSecret.byteLength !== 16) throw new Error('invalid auth');
  if (plaintext.byteLength + 1 + 16 > RECORD_SIZE) throw new Error('payload too large');

  const ephemeral = opts.ephemeral
    ?? (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.byteLength !== 16) throw new Error('invalid salt');
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey) as ArrayBuffer);

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  // workers-types spells the ECDH peer key `$public`; the runtime (and WebCrypto) read `public`.
  const ecdh: SubtleCryptoDeriveKeyAlgorithm & { public: CryptoKey } = { name: 'ECDH', public: uaKey };
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, ephemeral.privateKey, 256));

  // §3.3: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  // §3.4 / RFC 8188 §2.2
  const prk = await hmacSha256(salt, ikm);
  const cek = (await hmacSha256(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmacSha256(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);

  // A single (last) record: plaintext followed by the 0x02 padding delimiter.
  const record = concat(plaintext, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, record));

  // Header: salt (16) || rs (uint32 BE) || idlen (1) || keyid (as_public, 65).
  const header = new Uint8Array(16 + 4 + 1 + asPublic.byteLength);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.byteLength;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

// ---------- VAPID (RFC 8292) ----------

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url (the `applicationServerKey` and the `k=` parameter). */
  publicKey: string;
  privateKey: CryptoKey;
}

/** Generates a VAPID key pair: the public key as base64url raw, the private key as a JWK. */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey;
  return { publicKey: toBase64Url(raw), privateJwk };
}

export function importVapidPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  const { kty, crv, x, y, d } = jwk;
  return crypto.subtle.importKey('jwk', { kty, crv, x, y, d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

function b64urlJson(v: unknown): string {
  return toBase64Url(enc.encode(JSON.stringify(v)));
}

/**
 * An ES256 JWT for the push service at `endpoint`. WebCrypto's ECDSA signature is already raw r||s
 * (IEEE P1363), which is the JWS encoding, so no DER conversion is needed.
 */
export async function vapidJwt(endpoint: string, sub: string, privateKey: CryptoKey, now = Date.now()): Promise<string> {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(now / 1000) + 12 * 3600; // RFC 8292 §2: at most 24 hours
  const input = `${b64urlJson({ typ: 'JWT', alg: 'ES256' })}.${b64urlJson({ aud, exp, sub })}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(input)));
  return `${input}.${toBase64Url(sig)}`;
}

export async function vapidAuthorization(endpoint: string, sub: string, keys: VapidKeys, now = Date.now()): Promise<string> {
  return `vapid t=${await vapidJwt(endpoint, sub, keys.privateKey, now)}, k=${keys.publicKey}`;
}

// ---------- endpoint allowlist (SSRF guard) ----------

const EXACT_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
const SUFFIX_HOSTS = ['.push.apple.com', '.notify.windows.com', '.push.services.mozilla.com'];

/** Only https endpoints on the known browser push services, on the default port and without credentials. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return EXACT_HOSTS.has(host) || SUFFIX_HOSTS.some((s) => host.endsWith(s) && host.length > s.length);
}
