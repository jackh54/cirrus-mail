// Signed URLs for attachments (/api/files) and the remote image proxy (/api/proxy/image).
import { hmac, timingSafeEqual, toBase64Url } from './crypto';
import { HttpError } from './errors';

export const FILE_URL_TTL_S = 3600;
export const PROXY_URL_TTL_S = 24 * 3600;

function secret(env: Env): string {
  if (!env.APP_SECRET) throw new HttpError(500, 'NOT_CONFIGURED', 'APP_SECRET is not set');
  return env.APP_SECRET;
}

// Every signed payload starts with its purpose ("file" | "proxy"), so one kind of signature can never
// be replayed as the other.
async function sig(env: Env, purpose: 'file' | 'proxy', subject: string, exp: string | number): Promise<string> {
  return toBase64Url(await hmac(secret(env), `${purpose}|${subject}|${exp}`));
}

function validExp(e: string | undefined, nowMs: number): e is string {
  return !!e && /^\d{1,12}$/.test(e) && Number(e) * 1000 >= nowMs;
}

/** Absolute (when origin is given) signed attachment URL valid for one hour. */
export async function signFileUrl(env: Env, origin: string, attachmentId: string, inline = false, nowMs = Date.now()): Promise<string> {
  const exp = Math.floor(nowMs / 1000) + FILE_URL_TTL_S;
  const s = await sig(env, 'file', attachmentId, exp);
  return `${origin}/api/files/${attachmentId}?e=${exp}&s=${s}${inline ? '&inline=1' : ''}`;
}

export async function verifyFileSig(env: Env, attachmentId: string, e: string | undefined, s: string | undefined, nowMs = Date.now()): Promise<boolean> {
  if (!s || !validExp(e, nowMs)) return false;
  return timingSafeEqual(await sig(env, 'file', attachmentId, e), s);
}

/** Relative signed proxy URL valid for 24 hours. */
export async function signProxyUrl(env: Env, url: string, nowMs = Date.now()): Promise<string> {
  const exp = Math.floor(nowMs / 1000) + PROXY_URL_TTL_S;
  return `/api/proxy/image?u=${encodeURIComponent(url)}&e=${exp}&s=${await sig(env, 'proxy', url, exp)}`;
}

export async function verifyProxySig(env: Env, url: string | undefined, e: string | undefined, s: string | undefined, nowMs = Date.now()): Promise<boolean> {
  if (!url || !s || !validExp(e, nowMs)) return false;
  return timingSafeEqual(await sig(env, 'proxy', url, e), s);
}

// ---------- SSRF guard for the image proxy ----------

function parseIPv4(host: string): number[] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((x) => x <= 255) ? o : null;
}

function isPrivateIPv4Octets([a, b, c]: number[]): boolean {
  return (
    a === 0 ||                                   // 0.0.0.0/8
    a === 10 ||                                  // 10/8
    a === 127 ||                                 // loopback
    (a === 100 && b >= 64 && b <= 127) ||        // 100.64/10 CGNAT
    (a === 169 && b === 254) ||                  // link-local
    (a === 172 && b >= 16 && b <= 31) ||         // 172.16/12
    (a === 192 && b === 0 && c === 0) ||         // 192.0.0.0/24
    (a === 192 && b === 0 && c === 2) ||         // TEST-NET-1
    (a === 192 && b === 168) ||                  // 192.168/16
    (a === 198 && (b === 18 || b === 19)) ||     // 198.18/15 benchmarking
    (a === 198 && b === 51 && c === 100) ||      // TEST-NET-2
    (a === 203 && b === 0 && c === 113) ||       // TEST-NET-3
    a >= 224                                     // multicast, reserved, broadcast
  );
}

/** Parses an IPv6 literal (with optional embedded IPv4) into 8 hextets, or null. */
export function parseIPv6(input: string): number[] | null {
  let h = input.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h.includes(':')) return null;
  const pct = h.indexOf('%');
  if (pct >= 0) h = h.slice(0, pct);
  const v4 = h.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const o = parseIPv4(v4[2]);
    if (!o) return null;
    h = `${v4[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const part = (x: string) => (x ? x.split(':') : []);
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function isPrivateIPv6(host: string): boolean {
  const g = parseIPv6(host);
  if (!g) return host.includes(':'); // unparseable IPv6-looking host: refuse
  const zero6 = g.slice(0, 6).every((x) => x === 0);
  if (zero6) return true;                                                   // ::/96 (incl. ::, ::1, IPv4-compatible)
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return true;  // ::ffff:0:0/96 IPv4-mapped
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return true; // 64:ff9b::/96 NAT64
  if (g[0] === 0x2002) return true;                                         // 2002::/16 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true;                              // fc00::/7 ULA
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((g[0] & 0xff00) === 0xff00) return true;                              // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;                      // documentation
  return false;
}

/** True when `raw` is an http(s) URL to a public-looking host. */
export function isSafeRemoteUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  const v4 = parseIPv4(host);
  if (v4 && isPrivateIPv4Octets(v4)) return false;
  if (isPrivateIPv6(host)) return false;
  // Bare numeric hosts in other notations (e.g. 2130706433) and single-label names.
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return false;
  if (!host.includes('.') && !host.includes(':')) return false;
  return true;
}
