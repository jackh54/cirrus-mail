import createDOMPurify from 'dompurify';

/**
 * Email HTML pipeline (design §3.4):
 * 1. DOMPurify (no scripts, forms, embeds, frames, handlers, javascript: URLs).
 * 2. Our own DOM pass: links open in a new tab with noopener/noreferrer, remote images and CSS
 *    url()s are swapped for a blank placeholder unless a signed proxy URL was supplied, and
 *    relative same-origin URLs (signed cid: attachment links) are made absolute.
 * 3. The result is wrapped in a srcdoc document with a strict CSP meta. It is rendered in a
 *    sandbox without allow-scripts/allow-same-origin, so even a sanitizer bypass cannot run code.
 * 4. We classify the mail as "designed" (its own backgrounds, colours or fixed-width layout) or
 *    "simple", so dark mode can render simple mail as native text and leave designed mail alone.
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

/**
 * - `original`: the sender's rendering on white paper (always used in the light theme).
 * - `dark`: simple mail restyled with the app's dark tokens on a transparent background.
 * - `invert`: designed mail forced dark by inverting it, with media re-inverted.
 */
export type RenderMode = 'original' | 'dark' | 'invert';

export interface PreparedEmail {
  /** Sanitised body wrapper HTML. */
  bodyHtml: string;
  /** The email's own <style> rules (from <head>). */
  emailCss: string;
  /** True when the email brings its own backgrounds, colours or fixed-width layout. */
  designed: boolean;
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
  // Classify before the body's children move into the (detached) wrapper.
  const designed = isDesigned(root, headStyles, body);
  const wrapper = doc.createElement('div');
  wrapper.className = 'cirrus-mail-body';
  if (body) {
    const bodyStyle = body.getAttribute('style') ?? '';
    const bgcolor = body.getAttribute('bgcolor');
    wrapper.setAttribute('style', `${bgcolor ? `background-color:${bgcolor};` : ''}${bodyStyle}`);
    while (body.firstChild) wrapper.appendChild(body.firstChild);
  }

  return { bodyHtml: wrapper.outerHTML, emailCss: headStyles.join('\n'), designed, remoteUrls: [...remote], blocked };
}

/** Near-black greys count as "default" text colour; anything else is a deliberate colour. */
function isDefaultColor(value: string): boolean {
  const v = value.trim().toLowerCase().replace(/\s*!important$/, '');
  if (['', 'inherit', 'initial', 'unset', 'currentcolor', 'black', 'windowtext', 'auto'].includes(v)) return true;
  let rgb: number[] | null = null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  } else {
    const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(v);
    if (m) rgb = [m[1], m[2], m[3]].map(Number);
  }
  if (!rgb) return false;
  return Math.max(...rgb) <= 0x55 && Math.max(...rgb) - Math.min(...rgb) <= 0x10;
}

const BG_DECL = /(^|;|\s)background(-color|-image)?\s*:\s*([^;]+)/i;
const LAYOUT_TAGS = new Set(['body', 'table', 'td', 'th', 'div', 'center', 'tr', 'tbody']);
const STYLE_BG_RULE = /(^|[},\s])(body|table|td|th|div|center|\.[\w-]+|#[\w-]+)[^{}]*\{[^}]*background(-color|-image)?\s*:\s*(?!\s*(transparent|none|inherit|initial)\b)/i;

function pxWidth(el: Element): number {
  const attr = el.getAttribute('width');
  if (attr && /^\d+(px)?$/i.test(attr.trim())) return parseInt(attr, 10);
  const m = /(^|;|\s)width\s*:\s*(\d+)px/i.exec(el.getAttribute('style') ?? '');
  return m ? parseInt(m[2], 10) : 0;
}

/**
 * "Designed" mail: any bgcolor; a background on a layout element (inline or in <style>); explicit
 * non-default text colours on more than three elements; images wider than ~300px; or fixed-width
 * table layouts. Everything else (plain HTML from Gmail, Apple Mail, replies with bold text) is simple.
 */
function isDesigned(root: HTMLElement, headStyles: string[], body: Element | null): boolean {
  if (root.querySelector('[bgcolor]')) return true;
  if (body?.hasAttribute('bgcolor') || body?.hasAttribute('background')) return true;
  const css = [...headStyles, ...Array.from(root.querySelectorAll('style'), (s) => s.textContent ?? '')].join('\n');
  if (STYLE_BG_RULE.test(css)) return true;

  let colored = 0;
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase();
    const style = el.getAttribute('style') ?? '';
    if (LAYOUT_TAGS.has(tag)) {
      const bg = BG_DECL.exec(style);
      if (bg && !/^(transparent|none|inherit|initial|unset)\b/i.test(bg[3].trim())) return true;
      if (el.hasAttribute('background')) return true;
    }
    if (tag === 'img' && pxWidth(el) > 300) return true;
    if (tag === 'table' && pxWidth(el) >= 300) return true;
    const font = tag === 'font' ? el.getAttribute('color') : null;
    const color = /(^|;|\s)color\s*:\s*([^;]+)/i.exec(style)?.[2] ?? font;
    if (color && !isDefaultColor(color) && ++colored > 3) return true;
  }
  return false;
}

const BASE_CSS = `
html{background:#fff;color-scheme:light}
body{margin:0;padding:20px 22px;font:14.5px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#15171c;overflow-wrap:break-word;word-break:break-word}
img{max-width:100%;height:auto}
img[data-cirrus-blocked]{background:#f3f4f6}
pre{white-space:pre-wrap}
a{color:#1e4fc2}
blockquote{margin:0 0 0 .4em;padding-left:.9em;border-left:2px solid #d6d8dd;color:#5f6470}
`;

/**
 * Simple mail in the dark theme reads like app text: transparent page, the app's dark tokens, and
 * any stray inline colours neutralised. Comes after the email's CSS so it wins.
 */
const DARK_CSS = `
html{background:transparent;color-scheme:dark}
body{color:#ecedef;-webkit-font-smoothing:antialiased}
body *{color:inherit!important;background-color:transparent!important;border-color:#33353c!important}
body a,body a *{color:#8eb1ff!important}
body blockquote{border-left:2px solid #33353c!important;color:#9a9ea8!important}
body img[data-cirrus-blocked]{background:#1b1c20!important}
`;

/**
 * Designed mail forced dark: invert the page and turn hues back, then re-invert media so photos and
 * logos keep their real colours. The page itself stays transparent (dark scheme), so it shows the app's
 * background; body text keeps its explicit colour from BASE_CSS and inverts to light.
 */
const INVERT_CSS = `
html{background:transparent;color-scheme:dark;filter:invert(1) hue-rotate(180deg)}
img:not(picture img):not([data-cirrus-blocked]),picture,video,svg,[background],[style*="background-image"]{filter:invert(1) hue-rotate(180deg)}
`;

/** Build the iframe document for a rendering mode. Layout is identical across modes, so heights match. */
export function emailSrcdoc(p: PreparedEmail, mode: RenderMode): string {
  const csp = `default-src 'none'; img-src data: ${location.origin}; style-src 'unsafe-inline'; font-src data:`;
  const modeCss = mode === 'dark' ? DARK_CSS : mode === 'invert' ? INVERT_CSS : '';
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<base target="_blank">' +
    `<style>${BASE_CSS}</style>` +
    `<style>${p.emailCss.replace(/<\/style/gi, '')}</style>` +
    (modeCss ? `<style>${modeCss}</style>` : '') +
    `</head><body>${p.bodyHtml}</body></html>`
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
