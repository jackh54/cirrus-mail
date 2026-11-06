// Just enough MIME to pull a PGP/MIME `multipart/signed` apart exactly as it was signed. Works on a "binary string"
// (one char per byte) so no byte is altered by text decoding.

export function bytesToBinary(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

export function binaryToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
}

const HEADER_END = /\r?\n\r?\n/;

/** Header block -> lowercase name -> unfolded value (the first of each). */
function parseHeaders(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) {
      const name = line.slice(0, i).trim().toLowerCase();
      if (!out.has(name)) out.set(name, line.slice(i + 1).trim());
    }
  }
  return out;
}

function splitHead(entity: string): { head: Map<string, string>; body: string } {
  const m = HEADER_END.exec(entity);
  if (!m) return { head: parseHeaders(entity), body: '' };
  return { head: parseHeaders(entity.slice(0, m.index)), body: entity.slice(m.index + m[0].length) };
}

export interface SignedParts {
  /** The first part, byte for byte as it was signed (line endings canonicalised to CRLF). */
  signed: Uint8Array;
  /** The armored detached signature from the second part. */
  signature: string;
}

/** Returns the signed content and the signature of a `multipart/signed; protocol="application/pgp-signature"` message. */
export function splitPgpSigned(raw: Uint8Array): SignedParts | null {
  const text = bytesToBinary(raw);
  const { head, body } = splitHead(text);
  const ct = head.get('content-type') ?? '';
  if (!/^multipart\/signed/i.test(ct) || !/protocol\s*=\s*"?application\/pgp-signature"?/i.test(ct)) return null;
  const boundary = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(ct);
  const b = boundary?.[1] ?? boundary?.[2];
  if (!b) return null;

  // Delimiter lines: "--boundary" at a line start, optionally followed by "--" (the close), then spaces.
  const re = new RegExp(`(?:^|\\r?\\n)--${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(--)?[ \\t]*(?:\\r?\\n|$)`, 'g');
  const marks: { start: number; end: number; close: boolean }[] = [];
  for (let m = re.exec(body); m; m = re.exec(body)) {
    marks.push({ start: m.index, end: m.index + m[0].length, close: !!m[1] });
    if (m[1]) break;
  }
  if (marks.length < 3 || !marks[2].close) return null;
  // The line break before a delimiter belongs to the delimiter, not to the part.
  const part1 = body.slice(marks[0].end, marks[1].start);
  const part2 = body.slice(marks[1].end, marks[2].start);
  const sig = splitHead(part2).body.trim();
  if (!sig.includes('-----BEGIN PGP SIGNATURE-----')) return null;
  return { signed: binaryToBytes(part1.replace(/\r?\n/g, '\r\n')), signature: sig };
}
