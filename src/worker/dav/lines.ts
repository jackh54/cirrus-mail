// Content-line helpers shared by iCalendar (RFC 5545) and vCard (RFC 6350): unfold, parse, escape, fold.

export interface Line {
  group: string;
  name: string;                 // upper-case
  params: Record<string, string>; // keys upper-case, repeated keys joined with ","
  value: string;
  raw: string;                  // unfolded source line
}

export function unfold(text: string): string[] {
  const out: string[] = [];
  for (const l of text.replace(/\r\n?/g, '\n').split('\n')) {
    if ((l.startsWith(' ') || l.startsWith('\t')) && out.length) out[out.length - 1] += l.slice(1);
    else out.push(l);
  }
  return out.filter((l) => l !== '');
}

function splitOutsideQuotes(s: string, sep: string): string[] {
  const out: string[] = [];
  let q = false, cur = '';
  for (const ch of s) {
    if (ch === '"') q = !q;
    if (ch === sep && !q) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseLine(raw: string): Line | null {
  let q = false, idx = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '"') q = !q;
    else if (raw[i] === ':' && !q) { idx = i; break; }
  }
  if (idx < 1) return null;
  const parts = splitOutsideQuotes(raw.slice(0, idx), ';');
  let name = parts[0].toUpperCase();
  let group = '';
  const dot = name.indexOf('.');
  if (dot > 0) { group = name.slice(0, dot); name = name.slice(dot + 1); }
  if (!/^[A-Z0-9-]+$/.test(name)) return null;
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    const k = (eq < 0 ? 'TYPE' : p.slice(0, eq)).toUpperCase();
    const v = (eq < 0 ? p : p.slice(eq + 1)).replace(/^"(.*)"$/, '$1');
    params[k] = params[k] ? `${params[k]},${v}` : v;
  }
  return { group, name, params, value: raw.slice(idx + 1), raw };
}

export function parseLines(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of unfold(text)) {
    const l = parseLine(raw);
    if (!l) throw new Error('Malformed content line');
    out.push(l);
  }
  return out;
}

/** RFC 5545 §3.3.11 / RFC 6350 §3.4 text escaping. */
export function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n?|\n/g, '\\n');
}

export function unescapeText(s: string): string {
  return s.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

const enc = new TextEncoder();

/** Folds a line at 75 octets, never inside a code point. */
export function fold(line: string): string {
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '', bytes = 0, limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) { out.push(cur); cur = ' '; bytes = 1; limit = 75; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n');
}

export function serialize(lines: string[]): string {
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Strips CR/LF so a user value can never inject another content line. */
export function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ');
}
