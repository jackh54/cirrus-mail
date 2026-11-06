/** Plain-text body helpers: quote detection and URL linkification. */

export type TextBlock = { kind: 'text'; lines: string[] } | { kind: 'quote'; lines: string[] };

const ATTRIBUTION = /^(on\s.+wrote:|.+\s(a écrit|schrieb|escribió)\s?:)\s*$/i;

/** Split into normal text and `>`-quoted blocks; an "On … wrote:" line joins the quote below it. */
export function splitQuotes(text: string): TextBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: TextBlock[] = [];
  for (const line of lines) {
    const quoted = /^\s*>/.test(line);
    const last = blocks[blocks.length - 1];
    if (quoted) {
      if (last?.kind === 'quote') last.lines.push(line);
      else {
        const prev = last?.kind === 'text' ? last.lines[last.lines.length - 1] : undefined;
        const attribution = prev !== undefined && ATTRIBUTION.test(prev.trim());
        if (attribution && last) last.lines.pop();
        blocks.push({ kind: 'quote', lines: attribution && prev ? [prev, line] : [line] });
      }
    } else if (last?.kind === 'text') last.lines.push(line);
    else if (last?.kind === 'quote' && line.trim() === '') last.lines.push(line);
    else blocks.push({ kind: 'text', lines: [line] });
  }
  return blocks.filter((b) => b.lines.some((l) => l.trim() !== ''));
}

export type Token = { kind: 'text'; value: string } | { kind: 'link'; value: string; href: string };

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gi;

export function linkify(s: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    let url = m[0];
    const trailing = /[).,;:!?\]]+$/.exec(url);
    if (trailing) url = url.slice(0, -trailing[0].length);
    const start = m.index ?? 0;
    if (start > last) out.push({ kind: 'text', value: s.slice(last, start) });
    const href = url.includes('@') && !/^https?:|^www\./i.test(url)
      ? `mailto:${url}`
      : /^www\./i.test(url) ? `https://${url}` : url;
    out.push({ kind: 'link', value: url, href });
    last = start + url.length;
  }
  if (last < s.length) out.push({ kind: 'text', value: s.slice(last) });
  return out;
}
