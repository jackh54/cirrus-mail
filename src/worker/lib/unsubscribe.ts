// List-Unsubscribe (RFC 2369) and one-click unsubscribe (RFC 8058): parsing at receive time, and the POST.
import type { AuthResults, UnsubscribeInfo } from '../../shared/api';
import { cleanHeaderText, zEmail } from './validate';

/** What is stored per message (messages.unsub_json). Only https URLs are ever kept. */
export interface StoredUnsub {
  url?: string;
  mailto?: string;
  subject?: string;
  oneClick?: boolean;
}

export const ONE_CLICK_TIMEOUT_MS = 5000;
const MAX_URL = 1000;

/** An https URL on a public-looking hostname: no credentials, no IP literal, no single-label or local names. */
export function safeHttpsUrl(raw: string): string | null {
  if (raw.length > MAX_URL || /[\s\x00-\x1f\x7f]/.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (host.startsWith('[') || /^[\d.]+$/.test(host) || !host.includes('.') || /\.(local|localhost|internal|lan|home|corp)$/.test(host)) return null;
  return u.toString();
}

/** Messages that failed authentication get no unsubscribe link: the header is as forgeable as the From. */
export function mayStoreUnsub(auth: AuthResults | null): boolean {
  return auth?.aligned === true && auth.dmarc !== 'fail';
}

/** Parses the two headers into the compact stored form; null when nothing usable is offered. */
export function parseListUnsubscribe(header: string | null, post: string | null): StoredUnsub | null {
  if (!header) return null;
  const out: StoredUnsub = {};
  for (const m of header.matchAll(/<([^<>]{1,2000})>/g)) {
    const item = m[1].trim();
    if (/^https:/i.test(item)) {
      const url = safeHttpsUrl(item);
      if (url && !out.url) out.url = url;
    } else if (/^mailto:/i.test(item) && !out.mailto) {
      const rest = item.slice(7);
      const q = rest.indexOf('?');
      let addr = q < 0 ? rest : rest.slice(0, q);
      try {
        addr = decodeURIComponent(addr);
      } catch { /* keep raw */ }
      const ok = zEmail.safeParse(addr.split(',')[0]);
      if (!ok.success) continue;
      out.mailto = ok.data;
      if (q >= 0) {
        const subject = new URLSearchParams(rest.slice(q + 1)).get('subject');
        if (subject) out.subject = cleanHeaderText(subject).trim().slice(0, 200);
      }
    }
  }
  if (!out.url && !out.mailto) return null;
  if (out.url && post && /list-unsubscribe\s*=\s*one-click/i.test(post)) out.oneClick = true;
  return out;
}

export function readStoredUnsub(json: string | null): StoredUnsub | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as StoredUnsub;
    return v && typeof v === 'object' && (v.url || v.mailto) ? v : null;
  } catch {
    return null;
  }
}

/** How a stored header is offered: one-click POST, else mailto, else open the https link. */
export function unsubscribeInfo(json: string | null): UnsubscribeInfo | null {
  const s = readStoredUnsub(json);
  if (!s) return null;
  const url = s.url ? safeHttpsUrl(s.url) : null;
  if (url && s.oneClick) return { method: 'one_click', host: new URL(url).hostname, url };
  if (s.mailto) return { method: 'mailto', host: s.mailto.slice(s.mailto.lastIndexOf('@') + 1), url: null };
  if (url) return { method: 'link', host: new URL(url).hostname, url };
  return null;
}

/**
 * RFC 8058: POST `List-Unsubscribe=One-Click` to the stored URL. https only, no redirects followed, 5 s
 * timeout, nothing sent but the fixed body. True on a 2xx answer.
 */
export async function postOneClick(storedUrl: string): Promise<boolean> {
  const url = safeHttpsUrl(storedUrl);
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      signal: AbortSignal.timeout(ONE_CLICK_TIMEOUT_MS),
    });
    await res.body?.cancel();
    return res.status >= 200 && res.status < 300;
  } catch (e) {
    console.error('unsubscribe post failed', (e as Error).name);
    return false;
  }
}
