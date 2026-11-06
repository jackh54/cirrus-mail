import createDOMPurify from 'dompurify';

/**
 * Email HTML pipeline (design §3.4):
 * 1. DOMPurify (no scripts, forms, embeds, frames, handlers, javascript: URLs).
 * 2. Our own DOM pass: links open in a new tab with noopener/noreferrer, remote images and CSS
 *    url()s are swapped for a blank placeholder unless a signed proxy URL was supplied, and
 *    relative same-origin URLs (signed cid: attachment links) are made absolute.
 * 3. The result is wrapped in a srcdoc document with a strict CSP meta. It is rendered in a
 *    sandbox without allow-scripts/allow-same-origin, so even a sanitizer bypass cannot run code.
 */

const purify = createDOMPurify(window);

const FORBID_TAGS = [
  'script', 'noscript', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'applet', 'base', 'meta', 'link', 'portal', 'template',
];
const FORBID_ATTR = ['srcset', 'ping', 'formaction', 'action', 'autofocus', 'srcdoc', 'http-equiv'];

/** 1×1 neutral pixel that stretches to the img's width/height, so layouts keep their shape. */
const PLACEHOLDER =
  'data:image/svg+xml,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1" preserveAspectRatio="none"><rect width="1" height="1" fill="#e9ecf3"/></svg>');

const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;

function isRemote(url: string): boolean {
  const u = url.trim();
  if (!/^(https?:)?\/\//i.test(u)) return false;
  try {
    return new URL(u, location.href).origin !== location.origin;
  } catch {
    return true;
  }
}

function absolutize(url: string): string {
  const u = url.trim();
  if (u.startsWith('/') && !u.startsWith('//')) return location.origin + u;
  return u;
}

function normalizeRemote(url: string): string {
  const u = url.trim();
  return u.startsWith('//') ? `https:${u}` : u;
}

function isDangerousUrl(v: string): boolean {
  // Strip whitespace/control chars browsers ignore before checking the scheme.
  const s = v.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase();
  return s.startsWith('javascript:') || s.startsWith('vbscript:') || (s.startsWith('data:') && !s.startsWith('data:image/'));
}

export interface PreparedEmail {
  srcdoc: string;
  /** Remote image URLs found (normalised to https: for protocol-relative ones). */
  remoteUrls: string[];
  /** True when some remote content was blocked in this rendering. */
  blocked: boolean;
}

/** `signed` maps original remote URL → signed proxy URL. Pass null to block remote images. */
export function prepareEmail(rawHtml: string, signed: Record<string, string> | null): PreparedEmail {
  const remote = new Set<string>();
  let blocked = false;

  const rewriteUrl = (url: string): string | null => {
    if (!isRemote(url)) return absolutize(url);
    const n = normalizeRemote(url);
    remote.add(n);
    const s = signed?.[n] ?? signed?.[url.trim()];
    if (s) return absolutize(s);
    blocked = true;
    return null;
  };

  const rewriteCss = (css: string): string =>
    css
      .replace(/@import[^;]*;?/gi, '')
      .replace(CSS_URL, (_m, _q: string, url: string) => {
        const r = rewriteUrl(url);
        return r ? `url("${r.replace(/"/g, '%22')}")` : 'none';
      });

  const root = purify.sanitize(rawHtml, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    FORBID_TAGS,
    FORBID_ATTR,
    ADD_ATTR: ['target'],
  }) as HTMLElement;

  const doc = root.ownerDocument;
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      else if (['href', 'src', 'xlink:href', 'background', 'poster', 'action'].includes(name) && isDangerousUrl(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' || tag === 'area') {
      const href = el.getAttribute('href');
      if (href) el.setAttribute('href', absolutize(href));
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
    if (tag === 'img') {
      const src = el.getAttribute('src');
      if (src) {
        const r = rewriteUrl(src);
        el.setAttribute('src', r ?? PLACEHOLDER);
        if (!r) el.setAttribute('data-cirrus-blocked', '');
      }
    }
    const bg = el.getAttribute('background');
    if (bg) {
      const r = rewriteUrl(bg);
      if (r) el.setAttribute('background', r);
      else el.removeAttribute('background');
    }
    const style = el.getAttribute('style');
    if (style && /url\(/i.test(style)) el.setAttribute('style', rewriteCss(style));
    if (tag === 'style') el.textContent = rewriteCss(el.textContent ?? '');
    if (tag === 'video' || tag === 'audio' || tag === 'source' || tag === 'track') el.remove();
  }

  // Head <style>s move into our document; body attributes move onto a wrapper div.
  const headStyles = Array.from(root.querySelectorAll('head style')).map((s) => s.textContent ?? '');
  const body = root.querySelector('body');
  const wrapper = doc.createElement('div');
  wrapper.className = 'cirrus-mail-body';
  if (body) {
    const bodyStyle = body.getAttribute('style') ?? '';
    const bgcolor = body.getAttribute('bgcolor');
    wrapper.setAttribute('style', `${bgcolor ? `background-color:${bgcolor};` : ''}${bodyStyle}`);
    while (body.firstChild) wrapper.appendChild(body.firstChild);
  }

  return { srcdoc: buildSrcdoc(headStyles.join('\n'), wrapper.outerHTML), remoteUrls: [...remote], blocked };
}

const BASE_CSS = `
html{background:#fff;color-scheme:light}
body{margin:0;padding:20px 22px;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1b2133;overflow-wrap:break-word;word-break:break-word}
img{max-width:100%;height:auto}
img[data-cirrus-blocked]{background:#e9ecf3}
pre{white-space:pre-wrap}
a{color:#3a52eb}
blockquote{margin:0 0 0 .4em;padding-left:.9em;border-left:2px solid #d4d8e4;color:#4a5165}
`;

function buildSrcdoc(emailCss: string, bodyHtml: string): string {
  const csp = `default-src 'none'; img-src data: ${location.origin}; style-src 'unsafe-inline'; font-src data:`;
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<base target="_blank">' +
    `<style>${BASE_CSS}</style>` +
    `<style>${emailCss.replace(/<\/style/gi, '')}</style>` +
    `</head><body>${bodyHtml}</body></html>`
  );
}

/** Sanitised HTML fragment for quoting a message inside the compose editor. */
export function sanitizeForQuote(html: string): string {
  return purify.sanitize(html, {
    FORBID_TAGS: [...FORBID_TAGS, 'style', 'img'],
    FORBID_ATTR: [...FORBID_ATTR, 'style', 'class'],
  });
}

/** Sanitise our own rich-text (signatures) before injecting it into the editor. */
export function sanitizeBasic(html: string): string {
  return purify.sanitize(html, { FORBID_TAGS: [...FORBID_TAGS, 'style'], FORBID_ATTR });
}
