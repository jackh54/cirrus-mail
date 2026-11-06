// Signed URLs for attachments (/api/files) and the remote image proxy (/api/proxy/image).
import { hmac, timingSafeEqual, toBase64Url } from './crypto';
import { HttpError } from './errors';

export const FILE_URL_TTL_S = 3600;

function secret(env: Env): string {
  if (!env.APP_SECRET) throw new HttpError(500, 'NOT_CONFIGURED', 'APP_SECRET is not set');
  return env.APP_SECRET;
}

async function sig(env: Env, data: string): Promise<string> {
  return toBase64Url(await hmac(secret(env), data));
}

/** Absolute (when origin is given) signed attachment URL valid for one hour. */
export async function signFileUrl(env: Env, origin: string, attachmentId: string, inline = false, nowMs = Date.now()): Promise<string> {
  const exp = Math.floor(nowMs / 1000) + FILE_URL_TTL_S;
  const s = await sig(env, `${attachmentId}|${exp}`);
  return `${origin}/api/files/${attachmentId}?e=${exp}&s=${s}${inline ? '&inline=1' : ''}`;
}

export async function verifyFileSig(env: Env, attachmentId: string, e: string | undefined, s: string | undefined, nowMs = Date.now()): Promise<boolean> {
  if (!e || !s || !/^\d{1,12}$/.test(e)) return false;
  if (Number(e) * 1000 < nowMs) return false;
  return timingSafeEqual(await sig(env, `${attachmentId}|${e}`), s);
}

export async function signProxyUrl(env: Env, url: string): Promise<string> {
  return `/api/proxy/image?u=${encodeURIComponent(url)}&s=${await sig(env, url)}`;
}

export async function verifyProxySig(env: Env, url: string | undefined, s: string | undefined): Promise<boolean> {
  if (!url || !s) return false;
  return timingSafeEqual(await sig(env, url), s);
}

// ---------- SSRF guard for the image proxy ----------

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h.includes(':')) return false;
  if (h === '::1' || h === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true; // ULA, link-local
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (h.startsWith('::ffff:')) return true; // hex-form mapped addresses: refuse
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
  if (isPrivateIPv4(host) || isPrivateIPv6(host)) return false;
  // Bare numeric hosts in other notations (e.g. 2130706433) and single-label names.
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return false;
  if (!host.includes('.') && !host.includes(':')) return false;
  return true;
}
