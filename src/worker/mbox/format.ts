// mbox format helpers: splitting, mboxrd escaping, asctime separators and the Gmail label mapping. Pure functions.
import { LABEL_LIMITS } from '../../shared/api';
import { cleanHeaderText } from '../lib/validate';

const NL = 10;
const CR = 13;
const GT = 62;
const FROM = new TextEncoder().encode('From ');

function startsWithFrom(b: Uint8Array, at: number): boolean {
  if (at + FROM.length > b.length) return false;
  for (let k = 0; k < FROM.length; k++) if (b[at + k] !== FROM[k]) return false;
  return true;
}

/** True when there is a blank line directly above the line starting at `p`. */
function blankLineAbove(b: Uint8Array, p: number): boolean {
  if (p === 1) return b[0] === NL;
  if (p < 2 || b[p - 1] !== NL) return false;
  if (b[p - 2] === NL) return true;
  return b[p - 2] === CR && (p === 2 || b[p - 3] === NL);
}

export interface MboxMessage {
  /** Offset of the separator line within the scanned buffer. */
  sep: number;
  /** Message bytes: just after the separator line up to (not including) the blank line before the next separator. */
  start: number;
  end: number;
}

export interface MboxScan {
  messages: MboxMessage[];
  /** Bytes of the buffer fully handled. The rest is a message that continues past the buffer: read it again, from here. */
  consumed: number;
}

/**
 * Splits a buffer into messages. A separator is a line starting with `From ` that follows a blank line, or that is
 * the first line of the buffer when `trustStart` (the buffer begins at a message). A message is only complete once
 * the next separator is seen, or at the end of the file, so a separator cut by the end of the window stays in the
 * unconsumed tail and is found when the next window starts there.
 */
export function scanMbox(buf: Uint8Array, atEnd: boolean, trustStart = true): MboxScan {
  const seps: number[] = [];
  let p = 0;
  while (p < buf.length) {
    if (startsWithFrom(buf, p) && (p === 0 ? trustStart : blankLineAbove(buf, p))) seps.push(p);
    const nl = buf.indexOf(NL, p);
    if (nl < 0) break;
    p = nl + 1;
  }
  const messages: MboxMessage[] = [];
  for (let i = 0; i < seps.length; i++) {
    const sep = seps[i];
    const nl = buf.indexOf(NL, sep);
    const start = nl < 0 ? buf.length : nl + 1;
    let end: number;
    if (i + 1 < seps.length) {
      end = seps[i + 1] - (buf[seps[i + 1] - 2] === CR ? 2 : 1); // the blank line before the next separator
    } else if (atEnd) {
      end = buf.length;
      if (end - start >= 4 && buf[end - 1] === NL && buf[end - 2] === CR && buf[end - 3] === NL && buf[end - 4] === CR) end -= 2;
      else if (end - start >= 2 && buf[end - 1] === NL && buf[end - 2] === NL) end -= 1;
    } else {
      break;
    }
    messages.push({ sep, start, end: Math.max(start, end) });
  }
  if (atEnd) return { messages, consumed: buf.length };
  return { messages, consumed: seps.length ? seps[seps.length - 1] : 0 };
}

function isFromLine(b: Uint8Array, lineStart: number): boolean {
  let j = lineStart;
  while (b[j] === GT) j++;
  return startsWithFrom(b, j);
}

/** Lines matching `^>*From ` get one `>` more (escape) or one fewer (unescape; only lines that already have one). */
function rewriteFromLines(b: Uint8Array, escape: boolean): Uint8Array {
  const at: number[] = [];
  let p = 0;
  while (p < b.length) {
    if (isFromLine(b, p) && (escape || b[p] === GT)) at.push(p);
    const nl = b.indexOf(NL, p);
    if (nl < 0) break;
    p = nl + 1;
  }
  if (!at.length) return b;
  const out = new Uint8Array(b.length + (escape ? at.length : -at.length));
  let r = 0;
  let w = 0;
  for (const line of at) {
    out.set(b.subarray(r, line), w);
    w += line - r;
    if (escape) out[w++] = GT;
    r = escape ? line : line + 1;
  }
  out.set(b.subarray(r), w);
  return out;
}

export const unescapeMboxrd = (b: Uint8Array) => rewriteFromLines(b, false);
export const escapeMboxrd = (b: Uint8Array) => rewriteFromLines(b, true);

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Mon Jan  2 15:04:05 2006` (UTC), the date in an mbox separator line. */
export function asctime(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/** The asctime date of a `From addr Mon Jan  2 15:04:05 2006` separator line (as UTC), or null. */
export function parseSeparatorDate(line: string): number | null {
  const m = line.match(/^From \S+\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d\d:\d\d:\d\d)\s+(\d{4})/);
  if (!m) return null;
  const t = Date.parse(`${m[1]} ${m[2]} ${m[4]} ${m[3]} UTC`);
  return Number.isFinite(t) ? t : null;
}

// ---------- Gmail ----------

/** Splits an `X-Gmail-Labels` value on commas outside double quotes. */
export function parseGmailLabels(value: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => cleanHeaderText(s).trim()).filter(Boolean);
}

export type ImportFolder = 'inbox' | 'sent' | 'spam' | 'trash' | 'archive' | 'drafts';

export interface GmailMapping {
  folder: ImportFolder;
  starred: boolean;
  unread: boolean;
  /** User label names to create and apply (unique ignoring case, at most LABEL_LIMITS.maxName characters). */
  labels: string[];
}

const SYSTEM = new Set(['inbox', 'sent', 'spam', 'trash', 'drafts', 'starred', 'unread']);
const IGNORED = new Set(['important', 'opened', 'chat', 'archived']);

/** Maps an `X-Gmail-Labels` value to a Cirrus folder, flags and user labels. Trash beats Spam beats Drafts beats Inbox beats Sent. */
export function mapGmailLabels(value: string): GmailMapping {
  const names = parseGmailLabels(value);
  const lower = new Set(names.map((n) => n.toLowerCase()));
  const folder: ImportFolder = lower.has('trash') ? 'trash' : lower.has('spam') ? 'spam' : lower.has('drafts') ? 'drafts'
    : lower.has('inbox') ? 'inbox' : lower.has('sent') ? 'sent' : 'archive';
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const n of names) {
    const l = n.toLowerCase();
    if (SYSTEM.has(l) || IGNORED.has(l) || l.startsWith('category ')) continue;
    const name = n.slice(0, LABEL_LIMITS.maxName).trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    labels.push(name);
  }
  return { folder, starred: lower.has('starred'), unread: lower.has('unread'), labels };
}
