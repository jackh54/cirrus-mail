// OpenPGP helpers that need no OpenPGP library: packet framing and fingerprints, ASCII armor, Autocrypt headers
// and Web Key Directory lookups. Keys are only ever parsed here to validate them and compute a fingerprint;
// encrypting, decrypting and signing happen in the browser.
import type { AuthResults } from '../../shared/api';
import { fromBase64, toBase64, toHex } from './crypto';
import { HttpError } from './errors';

/** Largest public key accepted anywhere (binary): WKD responses, Autocrypt headers, imports. */
export const MAX_PUBLIC_KEY_BYTES = 64 * 1024;
export const WKD_TIMEOUT_MS = 5000;
const WKD_MAX_REDIRECTS = 2;

// ---------- armor ----------

function crc24(bytes: Uint8Array): number {
  let crc = 0xb704ce;
  for (const b of bytes) {
    crc ^= b << 16;
    for (let i = 0; i < 8; i++) {
      crc <<= 1;
      if (crc & 0x1000000) crc ^= 0x1864cfb;
    }
  }
  return crc & 0xffffff;
}

export function armorPublicKey(bytes: Uint8Array): string {
  const b64 = toBase64(bytes).replace(/.{1,64}/g, '$&\n');
  const crc = crc24(bytes);
  const crcB64 = toBase64(new Uint8Array([(crc >> 16) & 255, (crc >> 8) & 255, crc & 255]));
  return `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${b64}=${crcB64}\n-----END PGP PUBLIC KEY BLOCK-----\n`;
}

/** Decodes one armored public key block. Returns null when it is not a well-formed public key block. */
export function dearmorPublicKey(text: string): Uint8Array | null {
  const m = /-----BEGIN PGP PUBLIC KEY BLOCK-----\r?\n([\s\S]*?)-----END PGP PUBLIC KEY BLOCK-----/.exec(text);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  // Armor headers (Version:, Comment:) end at the first blank line.
  const blank = lines.findIndex((l) => l.trim() === '');
  const body = blank >= 0 ? lines.slice(blank + 1) : lines;
  let crcLine: string | null = null;
  let b64 = '';
  for (const l of body) {
    const t = l.trim();
    if (!t) continue;
    if (t.startsWith('=')) { crcLine = t.slice(1); break; }
    b64 += t;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(b64);
  } catch {
    return null;
  }
  if (crcLine !== null) {
    try {
      const c = fromBase64(crcLine);
      if (c.length !== 3 || ((c[0] << 16) | (c[1] << 8) | c[2]) !== crc24(bytes)) return null;
    } catch {
      return null;
    }
  }
  return bytes;
}

// ---------- packets and fingerprints ----------

export interface ParsedKey { fingerprint: string; bytes: Uint8Array }

const PUBLIC_KEY_TAGS = new Set([2, 6, 12, 13, 14, 17, 61, 62, 63]);

/**
 * Validates a binary public key (one primary key with its user IDs, signatures and subkeys) and returns its
 * v4 or v6 fingerprint. Rejects anything that carries secret key material.
 */
export async function parsePublicKey(bytes: Uint8Array): Promise<ParsedKey> {
  if (bytes.length === 0 || bytes.length > MAX_PUBLIC_KEY_BYTES) throw bad('The key is empty or too large');
  let pos = 0;
  let primary: Uint8Array | null = null;
  let first = true;
  while (pos < bytes.length) {
    const b0 = bytes[pos++];
    if (!(b0 & 0x80)) throw bad('Not an OpenPGP key');
    let tag: number;
    let len: number;
    if (b0 & 0x40) {
      tag = b0 & 0x3f;
      const l0 = bytes[pos++];
      if (l0 === undefined) throw bad('Truncated key');
      if (l0 < 192) len = l0;
      else if (l0 < 224) len = ((l0 - 192) << 8) + (bytes[pos++] ?? 0) + 192;
      else if (l0 === 255) { len = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0; pos += 4; }
      else throw bad('Unsupported packet length');
    } else {
      tag = (b0 >> 2) & 0xf;
      const lt = b0 & 3;
      if (lt === 0) len = bytes[pos++];
      else if (lt === 1) { len = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2; }
      else if (lt === 2) { len = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0; pos += 4; }
      else throw bad('Unsupported packet length');
    }
    if (!Number.isFinite(len) || len < 0 || pos + len > bytes.length) throw bad('Truncated key');
    if (first && tag !== 6) throw bad('This is not a public key');
    first = false;
    if (!PUBLIC_KEY_TAGS.has(tag)) throw bad(tag === 5 || tag === 7 ? 'This contains a private key' : 'Unexpected data in key');
    if (tag === 6) {
      if (primary) throw bad('Only one key per file is supported');
      primary = bytes.subarray(pos, pos + len);
    }
    pos += len;
  }
  if (!primary) throw bad('This is not a public key');
  return { fingerprint: await fingerprintOf(primary), bytes };
}

async function fingerprintOf(body: Uint8Array): Promise<string> {
  const v = body[0];
  if (v === 4) {
    const buf = new Uint8Array(3 + body.length);
    buf[0] = 0x99; buf[1] = body.length >> 8; buf[2] = body.length & 255;
    buf.set(body, 3);
    return toHex(new Uint8Array(await crypto.subtle.digest('SHA-1', buf))).toUpperCase();
  }
  if (v === 6) {
    const buf = new Uint8Array(5 + body.length);
    buf[0] = 0x9b;
    new DataView(buf.buffer).setUint32(1, body.length);
    buf.set(body, 5);
    return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).toUpperCase();
  }
  throw bad('Unsupported key version');
}

const bad = (message: string) => new HttpError(400, 'INVALID_KEY', message);

/** Accepts an armored public key from a client; returns it normalised plus its fingerprint. */
export async function normalizeArmoredPublicKey(armored: string): Promise<{ armored: string; fingerprint: string }> {
  const bytes = dearmorPublicKey(armored);
  if (!bytes) throw bad('Expected an armored PGP public key');
  const parsed = await parsePublicKey(bytes);
  return { armored: armorPublicKey(bytes), fingerprint: parsed.fingerprint };
}

/** The binary key out of an armored public key (what goes into an Autocrypt header). */
export function armoredToBase64(armored: string): string | null {
  const bytes = dearmorPublicKey(armored);
  return bytes ? toBase64(bytes) : null;
}

/** A draft with a PGP send mode must carry only an armored payload, never HTML. */
export function checkPgpPayload(mode: 'mime' | 'inline' | null | undefined, html: string, text: string | undefined): void {
  if (!mode) return;
  const t = (text ?? '').trim();
  const encrypted = /^-----BEGIN PGP MESSAGE-----[\s\S]+-----END PGP MESSAGE-----$/.test(t);
  const signed = /^-----BEGIN PGP SIGNED MESSAGE-----[\s\S]+-----END PGP SIGNATURE-----$/.test(t);
  if (html) throw new HttpError(400, 'INVALID_PGP', 'An OpenPGP message cannot have an HTML part');
  if (mode === 'mime' ? !encrypted : !(encrypted || signed)) throw new HttpError(400, 'INVALID_PGP', 'The body is not a valid armored OpenPGP message');
}

// ---------- Autocrypt ----------

const AUTOCRYPT_KNOWN = new Set(['addr', 'keydata', 'prefer-encrypt']);

/** Parses one Autocrypt header value. Null when malformed or when it has an unknown critical attribute. */
function parseAutocryptHeader(value: string): { addr: string; keydata: string } | null {
  const attrs = new Map<string, string>();
  for (const part of value.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) { if (part.trim()) return null; continue; }
    const name = part.slice(0, i).trim().toLowerCase();
    if (!name.startsWith('_') && !AUTOCRYPT_KNOWN.has(name)) return null;
    if (!attrs.has(name)) attrs.set(name, part.slice(i + 1).replace(/\s+/g, ''));
  }
  const addr = attrs.get('addr')?.toLowerCase();
  const keydata = attrs.get('keydata');
  return addr && keydata ? { addr, keydata } : null;
}

/**
 * The Autocrypt key for `from` out of a message's Autocrypt headers. Null unless there is exactly one valid
 * header whose addr equals the From address (a second one makes all of them untrusted, per the spec) and its
 * keydata is a well-formed public key.
 */
export async function parseAutocrypt(values: string[], from: string): Promise<ParsedKey | null> {
  const wanted = from.trim().toLowerCase();
  const matching = values.map(parseAutocryptHeader).filter((h): h is { addr: string; keydata: string } => !!h && h.addr === wanted);
  if (matching.length !== 1) return null;
  if (matching[0].keydata.length > Math.ceil(MAX_PUBLIC_KEY_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(matching[0].keydata)) return null;
  try {
    return await parsePublicKey(fromBase64(matching[0].keydata));
  } catch {
    return null;
  }
}

/** Autocrypt keys are trusted only from mail whose From domain passed DMARC (an aligned pass, not just DKIM). */
export function autocryptTrusted(auth: AuthResults | null): boolean {
  return auth?.dmarc === 'pass' && auth.aligned === true;
}

// ---------- Web Key Directory ----------

const ZBASE32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';

export function zbase32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ZBASE32[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ZBASE32[(acc << (5 - bits)) & 31];
  return out;
}

const LOCAL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.invalid', '.onion', '.arpa'];

/** Splits and validates an address for a WKD lookup. The domain is lowercased; the local part keeps its case. */
export function parseWkdAddress(email: string): { local: string; domain: string } {
  const at = email.lastIndexOf('@');
  const local = at > 0 ? email.slice(0, at) : '';
  const domain = at > 0 ? email.slice(at + 1).toLowerCase() : '';
  if (!LOCAL_RE.test(local) || !DOMAIN_RE.test(domain) || BLOCKED_SUFFIXES.some((s) => domain.endsWith(s))) {
    throw new HttpError(400, 'INVALID_ADDRESS', 'That address cannot be looked up');
  }
  return { local, domain };
}

/** WKD's hash: the lowercased local part, SHA-1, z-base-32. `Joe.Doe` -> `iy9q119eutrkn8s1mk4r39qejnbu3n5q`. */
export async function wkdHash(local: string): Promise<string> {
  return zbase32(new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(local.toLowerCase()))));
}

/** The advanced method URL first, then the direct method. */
export async function wkdUrls(email: string): Promise<string[]> {
  const { local, domain } = parseWkdAddress(email);
  const hu = await wkdHash(local);
  const l = encodeURIComponent(local);
  return [
    `https://openpgpkey.${domain}/.well-known/openpgpkey/${domain}/hu/${hu}?l=${l}`,
    `https://${domain}/.well-known/openpgpkey/hu/${hu}?l=${l}`,
  ];
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** One GET: https only, same-host redirects only (a few), 5 s overall, at most 64 KB. Null on anything else. */
async function fetchCapped(url: string, fetcher: Fetcher): Promise<Uint8Array | null> {
  let current = new URL(url);
  const signal = AbortSignal.timeout(WKD_TIMEOUT_MS);
  for (let hop = 0; hop <= WKD_MAX_REDIRECTS; hop++) {
    const res = await fetcher(current.toString(), { redirect: 'manual', signal, headers: { accept: 'application/octet-stream' } });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      const loc = res.headers.get('location');
      if (!loc) return null;
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        return null;
      }
      if (next.protocol !== 'https:' || next.hostname !== current.hostname || next.port || next.username || next.password) return null;
      current = next;
      continue;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      return null;
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_PUBLIC_KEY_BYTES) {
      await res.body.cancel();
      return null;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PUBLIC_KEY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  }
  return null;
}

/** Looks an address up over WKD (advanced, then direct). Null when no valid key was found. */
export async function lookupWkd(email: string, fetcher: Fetcher = (u, i) => fetch(u, i)): Promise<ParsedKey | null> {
  for (const url of await wkdUrls(email)) {
    try {
      const bytes = await fetchCapped(url, fetcher);
      if (bytes) return await parsePublicKey(bytes);
    } catch (e) {
      // A network error, timeout or unparseable answer on one method just moves on to the next.
      console.error('wkd lookup', (e as Error).name);
    }
  }
  return null;
}
