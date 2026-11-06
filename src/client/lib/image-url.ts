/**
 * Classifies an image/CSS URL found in received HTML (design §3.4 remote-image blocking). Kept free of DOM
 * globals so it can be tested; `pageHref` is the app's location.href.
 *
 * Only our own signed attachment links (`/api/files/<id>?…`, from cid: rewriting) count as local, and only in
 * their exact shape, so CSS escapes or dot segments cannot dress another path up as one. Any other URL on our
 * origin, relative ones included, is remote: a sender can mail a `/api/proxy/image?…` URL that some user
 * pre-signed, and loading it would tell a tracker the message was opened. Remote URLs load only through a
 * proxy URL signed in this session after "Load images".
 */
export function isRemoteImageUrl(url: string, pageHref: string): boolean {
  const u = url.trim();
  if (/^data:/i.test(u)) return false; // dangerous data: URLs are removed before this; the CSP allows data: images
  if (u.startsWith('#')) return false; // a reference inside the document (SVG), not a fetch
  let parsed: URL;
  try {
    parsed = new URL(u, pageHref);
  } catch {
    return true;
  }
  // cid:, about: and the like cannot load (the iframe CSP allows only data: and our signed paths).
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const origin = new URL(pageHref).origin;
  if (parsed.origin !== origin) return true;
  const path = u.startsWith(origin) ? u.slice(origin.length) : u;
  return !/^\/api\/files\/[0-9A-Za-z]+(\?[\w=&-]*)?$/.test(path);
}

/** The absolute URL to sign for a remote image (protocol-relative ones become https:, relative ones absolute). */
export function remoteImageKey(url: string, pageHref: string): string {
  const u = url.trim();
  if (u.startsWith('//')) return `https:${u}`;
  if (/^https?:\/\//i.test(u)) return u;
  try {
    return new URL(u, pageHref).href;
  } catch {
    return u;
  }
}
