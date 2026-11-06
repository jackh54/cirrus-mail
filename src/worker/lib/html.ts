// HTML → plain text and snippets. Good enough for previews, FTS and text/plain parts; not for rendering.

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
  hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', bull: '•',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Input cap for htmlToText: the output only feeds snippets, FTS and the text/plain alternative. */
export const HTML_TO_TEXT_MAX = 512 * 1024;

const SKIP_ELEMENTS = new Set(['head', 'style', 'script', 'title', 'noscript', 'template']);
const BLOCK_ELEMENTS = new Set(['p', 'div', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'blockquote', 'section', 'article', 'header', 'footer']);

/**
 * HTML → plain text with a single forward scan (linear time: every indexOf only moves forward or is
 * cached), so hostile input such as thousands of unterminated `<a href="` or `<!--` stays cheap.
 */
export function htmlToText(html: string): string {
  const src = html.length > HTML_TO_TEXT_MAX ? html.slice(0, HTML_TO_TEXT_MAX) : html;
  const lower = src.toLowerCase();
  const parts: string[] = [];
  const emit = (t: string) => { parts.push(t); };
  let anchor: { href: string; partIndex: number } | null = null;
  let pos = 0;
  let gt = -2; // cached index of the next '>' at or after pos (-1: none left)
  while (pos < src.length) {
    const lt = src.indexOf('<', pos);
    if (lt < 0) break;
    if (lt > pos) emit(src.slice(pos, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      pos = end < 0 ? src.length : end + 3;
      continue;
    }
    if (gt !== -1 && gt < lt + 1) gt = src.indexOf('>', lt + 1);
    if (gt < 0) { emit(src.slice(lt)); pos = src.length; break; }
    const tag = src.slice(lt + 1, gt);
    const m = tag.match(/^(\/?)([a-zA-Z][a-zA-Z0-9-]{0,30})/);
    if (!m) {
      if (tag.startsWith('!') || tag.startsWith('?')) { pos = gt + 1; continue; } // doctype, PI
      emit('<');
      pos = lt + 1;
      continue;
    }
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    pos = gt + 1;
    if (!closing && SKIP_ELEMENTS.has(name)) {
      const end = lower.indexOf(`</${name}`, pos);
      const endGt = end < 0 ? -1 : src.indexOf('>', end);
      pos = endGt < 0 ? src.length : endGt + 1;
      continue;
    }
    if (name === 'br') emit('\n');
    else if (name === 'li' && !closing) emit('\n- ');
    else if (BLOCK_ELEMENTS.has(name) || name === 'li') emit('\n');
    else if ((name === 'td' || name === 'th') && closing) emit(' ');
    else if (name === 'a') {
      if (!closing) {
        const href = tag.length <= 4096 ? tag.match(/\bhref\s*=\s*["']([^"']*)["']/i)?.[1] ?? '' : '';
        anchor = { href: decodeEntities(href), partIndex: parts.length };
      } else if (anchor) {
        const text = parts.slice(anchor.partIndex).join('').trim();
        if (anchor.href.startsWith('http') && text && text !== anchor.href) emit(` (${anchor.href})`);
        else if (!text && anchor.href) emit(anchor.href);
        anchor = null;
      }
    }
  }
  if (pos < src.length) emit(src.slice(pos));
  let s = decodeEntities(parts.join(''));
  s = s.replace(/\r/g, '').replace(/[ \t\u00a0]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** One-line preview: drops quoted lines and collapses whitespace. */
export function makeSnippet(text: string | null | undefined, max = 200): string {
  if (!text) return '';
  const lines = text.split('\n').filter((l) => !l.trimStart().startsWith('>'));
  const flat = lines.join(' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function textToHtml(text: string): string {
  return `<div>${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
}
