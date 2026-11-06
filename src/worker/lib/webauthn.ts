// WebAuthn verification with WebCrypto: a minimal CBOR/COSE reader and the checks from W3C WebAuthn L2 §7.1 and §7.2.
// Attestation is not used (we ask for "none" and never trust attStmt), so only authData and the credential key matter.
import { fromBase64Url, timingSafeEqual, toBase64Url } from './crypto';

export class WebAuthnError extends Error {}
const fail = (msg: string): never => {
  throw new WebAuthnError(msg);
};

export const COSE_ES256 = -7;
export const COSE_EDDSA = -8;
export const COSE_RS256 = -257;
/** Algorithms offered in pubKeyCredParams and accepted at registration. */
export const ALLOWED_ALGS = [COSE_ES256, COSE_EDDSA, COSE_RS256];

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

// ---------- CBOR (RFC 8949 subset: definite lengths, no tags, no floats) ----------

type Cbor = number | string | boolean | null | undefined | Uint8Array | Cbor[] | Map<number | string, Cbor>;

function readCbor(buf: Uint8Array, pos: number, depth = 0): { value: Cbor; end: number } {
  if (depth > 8 || pos >= buf.length) fail('bad cbor');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const major = buf[pos] >> 5;
  const info = buf[pos] & 31;
  pos++;
  let n: number;
  if (info < 24) n = info;
  else if (info === 24) {
    if (pos + 1 > buf.length) fail('bad cbor');
    n = buf[pos++];
  } else if (info === 25) {
    if (pos + 2 > buf.length) fail('bad cbor');
    n = view.getUint16(pos);
    pos += 2;
  } else if (info === 26) {
    if (pos + 4 > buf.length) fail('bad cbor');
    n = view.getUint32(pos);
    pos += 4;
  } else if (info === 27) {
    if (pos + 8 > buf.length) fail('bad cbor');
    const hi = view.getUint32(pos), lo = view.getUint32(pos + 4);
    if (hi > 0x1fffff) fail('cbor integer too large');
    n = hi * 2 ** 32 + lo;
    pos += 8;
  } else return fail('unsupported cbor'); // 28-30 reserved, 31 indefinite length

  switch (major) {
    case 0: return { value: n, end: pos };
    case 1: return { value: -1 - n, end: pos };
    case 2:
    case 3: {
      if (pos + n > buf.length) fail('bad cbor');
      const bytes = buf.slice(pos, pos + n);
      return { value: major === 2 ? bytes : new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes), end: pos + n };
    }
    case 4: {
      if (n > 64) fail('cbor array too long');
      const out: Cbor[] = [];
      for (let i = 0; i < n; i++) {
        const r = readCbor(buf, pos, depth + 1);
        out.push(r.value);
        pos = r.end;
      }
      return { value: out, end: pos };
    }
    case 5: {
      if (n > 64) fail('cbor map too long');
      const out = new Map<number | string, Cbor>();
      for (let i = 0; i < n; i++) {
        const k = readCbor(buf, pos, depth + 1);
        if (typeof k.value !== 'number' && typeof k.value !== 'string') fail('bad cbor key');
        const v = readCbor(buf, k.end, depth + 1);
        out.set(k.value as number | string, v.value);
        pos = v.end;
      }
      return { value: out, end: pos };
    }
    case 7:
      // Only false/true/null/undefined; info 24-27 would be a one-byte simple value or a float.
      if (info < 20 || info > 23) fail('unsupported cbor');
      return { value: n === 20 ? false : n === 21 ? true : n === 22 ? null : undefined, end: pos };
    default:
      return fail('unsupported cbor');
  }
}

export function decodeCbor(buf: Uint8Array): Cbor {
  const r = readCbor(buf, 0);
  if (r.end !== buf.length) fail('trailing cbor bytes');
  return r.value;
}

// ---------- authenticator data ----------

export interface AuthData {
  rpIdHash: Uint8Array;
  flags: number;
  up: boolean;
  uv: boolean;
  signCount: number;
  credentialId?: Uint8Array;
  /** The credential public key as a COSE_Key, byte for byte as the authenticator sent it. */
  coseKey?: Uint8Array;
}

export function parseAuthData(buf: Uint8Array): AuthData {
  if (buf.length < 37) fail('authData too short');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flags = buf[32];
  const out: AuthData = {
    rpIdHash: buf.slice(0, 32), flags, up: !!(flags & FLAG_UP), uv: !!(flags & FLAG_UV), signCount: view.getUint32(33),
  };
  if (flags & FLAG_AT) {
    if (buf.length < 55) fail('authData too short');
    const idLen = view.getUint16(53);
    if (idLen < 1 || idLen > 1023 || 55 + idLen > buf.length) fail('bad credential id');
    out.credentialId = buf.slice(55, 55 + idLen);
    const keyStart = 55 + idLen;
    const { end } = readCbor(buf, keyStart);
    out.coseKey = buf.slice(keyStart, end);
  }
  return out;
}

// ---------- COSE keys ----------

interface ImportedKey { alg: number; key: CryptoKey }

export async function importCoseKey(cose: Uint8Array, expectedAlg?: number): Promise<ImportedKey> {
  const m = decodeCbor(cose);
  if (!(m instanceof Map)) return fail('bad COSE key');
  const kty = m.get(1), alg = m.get(3);
  if (typeof alg !== 'number' || (expectedAlg !== undefined && alg !== expectedAlg)) return fail('bad COSE alg');
  const bytes = (k: number, len?: number) => {
    const v = m.get(k);
    if (!(v instanceof Uint8Array) || (len !== undefined && v.length !== len)) fail('bad COSE key');
    return toBase64Url(v as Uint8Array);
  };
  if (kty === 2 && alg === COSE_ES256) {
    if (m.get(-1) !== 1) fail('unsupported curve');
    const jwk = { kty: 'EC', crv: 'P-256', x: bytes(-2, 32), y: bytes(-3, 32) };
    return { alg, key: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']) };
  }
  if (kty === 3 && alg === COSE_RS256) {
    const n = m.get(-1);
    if (!(n instanceof Uint8Array) || n.length < 256 || n.length > 1024) fail('RSA key size not allowed');
    const jwk = { kty: 'RSA', n: bytes(-1), e: bytes(-2) };
    return { alg, key: await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']) };
  }
  if (kty === 1 && alg === COSE_EDDSA) {
    if (m.get(-1) !== 6) fail('unsupported curve');
    const jwk = { kty: 'OKP', crv: 'Ed25519', x: bytes(-2, 32) };
    return { alg, key: await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['verify']) };
  }
  return fail('unsupported key type');
}

/** WebAuthn ES256 signatures are ASN.1 DER; WebCrypto wants the raw r||s form. */
function derToRaw(der: Uint8Array): Uint8Array {
  let p = 0;
  const len = () => {
    let l = der[p++];
    if (l & 0x80) {
      const n = l & 0x7f;
      if (n < 1 || n > 2) fail('bad signature');
      l = 0;
      for (let i = 0; i < n; i++) l = (l << 8) | der[p++];
    }
    return l;
  };
  if (der[p++] !== 0x30) fail('bad signature');
  if (len() !== der.length - p) fail('bad signature');
  const out = new Uint8Array(64);
  for (let half = 0; half < 2; half++) {
    if (der[p++] !== 0x02) fail('bad signature');
    let l = len();
    if (l < 1 || p + l > der.length) fail('bad signature');
    while (l > 1 && der[p] === 0) { p++; l--; }
    if (l > 32) fail('bad signature');
    out.set(der.subarray(p, p + l), half * 32 + 32 - l);
    p += l;
  }
  if (p !== der.length) fail('bad signature');
  return out;
}

async function verifySignature(k: ImportedKey, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  try {
    if (k.alg === COSE_ES256) return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k.key, derToRaw(signature), data);
    if (k.alg === COSE_RS256) return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', k.key, signature, data);
    return await crypto.subtle.verify('Ed25519', k.key, signature, data);
  } catch {
    return false;
  }
}

// ---------- client data and shared checks ----------

export interface ClientData { type: string; challenge: string; origin: string; crossOrigin?: boolean }

export function parseClientData(clientDataJSON: string): { data: ClientData; raw: Uint8Array } {
  const raw = fromBase64Url(clientDataJSON);
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw));
  } catch {
    return fail('bad clientDataJSON');
  }
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d.type !== 'string' || typeof d.challenge !== 'string' || typeof d.origin !== 'string') return fail('bad clientDataJSON');
  return { data: d as unknown as ClientData, raw };
}

export interface Expected { type: 'webauthn.create' | 'webauthn.get'; origin: string; rpId: string }

async function checkCommon(cd: ClientData, authData: AuthData, exp: Expected): Promise<void> {
  if (cd.type !== exp.type) fail('wrong type');
  if (cd.origin !== exp.origin) fail('wrong origin');
  if (cd.crossOrigin === true) fail('cross-origin');
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(exp.rpId)));
  if (!timingSafeEqual(rpHash, authData.rpIdHash)) fail('wrong rpId');
  if (!authData.up) fail('user presence missing');
}

export interface RegistrationInput { clientDataJSON: string; attestationObject: string }
export interface VerifiedRegistration { credentialId: string; publicKey: string; alg: number; signCount: number; uv: boolean }

/** Verifies a registration response. The challenge must already have been consumed by the caller (and compared). */
export async function verifyRegistration(r: RegistrationInput, cd: ClientData, exp: Expected): Promise<VerifiedRegistration> {
  const att = decodeCbor(fromBase64Url(r.attestationObject));
  if (!(att instanceof Map)) return fail('bad attestationObject');
  const authBytes = att.get('authData');
  if (!(authBytes instanceof Uint8Array)) return fail('bad attestationObject');
  const authData = parseAuthData(authBytes);
  await checkCommon(cd, authData, exp);
  if (!authData.credentialId || !authData.coseKey) return fail('no credential in authData');
  const key = await importCoseKey(authData.coseKey);
  if (!ALLOWED_ALGS.includes(key.alg)) return fail('algorithm not allowed');
  return { credentialId: toBase64Url(authData.credentialId), publicKey: toBase64Url(authData.coseKey), alg: key.alg, signCount: authData.signCount, uv: authData.uv };
}

export interface AssertionInput { clientDataJSON: string; authenticatorData: string; signature: string }
export interface StoredKey { publicKey: string; alg: number }

/** Verifies an assertion's rpId, flags and signature. Returns the new signCount; the caller enforces the counter rule. */
export async function verifyAssertion(
  r: AssertionInput, cd: ClientData, clientDataRaw: Uint8Array, stored: StoredKey, exp: Expected, requireUv: boolean,
): Promise<number> {
  const authBytes = fromBase64Url(r.authenticatorData);
  const authData = parseAuthData(authBytes);
  await checkCommon(cd, authData, exp);
  if (requireUv && !authData.uv) fail('user verification required');
  const key = await importCoseKey(fromBase64Url(stored.publicKey), stored.alg);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataRaw));
  const signed = new Uint8Array(authBytes.length + 32);
  signed.set(authBytes);
  signed.set(hash, authBytes.length);
  if (!(await verifySignature(key, fromBase64Url(r.signature), signed))) fail('bad signature');
  return authData.signCount;
}
