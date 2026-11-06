// Spam verdict: score 0–10, spam at ≥ 5. Blocklist → spam; known contact → −3 and never spam, unless DMARC failed.
import type { AuthResults } from '../../shared/api';
import { matchesPattern } from '../lib/addresses';

export const SPAM_THRESHOLD = 5;

/** The only authserv-id whose Authentication-Results we trust: the one Cloudflare Email Routing stamps. */
export const TRUSTED_AUTHSERV_ID = 'mx.cloudflare.net';

/** Verdicts and the domains they were checked for, from one Authentication-Results header. */
export interface ParsedAuth {
  authservId: string;
  spf?: string;
  spfMailFrom?: string;      // domain of smtp.mailfrom
  dkim?: string;             // pass when any signature passed
  dkimPassDomains: string[]; // header.d of every passing signature
  dmarc?: string;
  dmarcHeaderFrom?: string;  // header.from
}

/** Drops RFC 5322 comments (nested, with quoted-pairs); quoted strings are kept as they are. */
function stripComments(s: string): string {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      out += ch;
      if (ch === '\\' && i + 1 < s.length) out += s[++i];
      else if (ch === '"') quoted = false;
    } else if (depth > 0) {
      if (ch === '\\') i++;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    } else if (ch === '(') {
      depth = 1;
      out += ' ';
    } else {
      if (ch === '"') quoted = true;
      out += ch;
    }
  }
  return out;
}

/** Splits on `;` outside quoted strings. */
function splitResinfo(s: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted && ch === '\\' && i + 1 < s.length) {
      cur += ch + s[++i];
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

const PAIR = /\s*([A-Za-z0-9][\w./-]*)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s"]*)/y;

function pairs(resinfo: string): [string, string][] {
  const out: [string, string][] = [];
  PAIR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PAIR.exec(resinfo))) {
    if (!m[0]) break;
    const v = m[2].startsWith('"') ? m[2].slice(1, -1).replace(/\\(.)/g, '$1') : m[2];
    out.push([m[1].toLowerCase(), v]);
  }
  return out;
}

const domainPart = (v: string) => v.slice(v.lastIndexOf('@') + 1).toLowerCase().replace(/\.$/, '');

/**
 * Parses one Authentication-Results header value (RFC 8601): comments removed, resinfo split on `;`, the
 * `method=result` read only at the start of each resinfo, then its `ptype.property=value` pairs. So a
 * value such as `smtp.mailfrom=dmarc=pass@evil` is an SPF property, never a DMARC verdict.
 */
export function parseAuthResults(header: string | null | undefined): ParsedAuth | null {
  if (!header) return null;
  const [head, ...resinfos] = splitResinfo(stripComments(header));
  const authservId = (head.trim().split(/\s+/)[0] ?? '').toLowerCase();
  if (!authservId) return null;
  const out: ParsedAuth = { authservId, dkimPassDomains: [] };
  for (const r of resinfos) {
    const [method, ...props] = pairs(r);
    if (!method) continue;
    const name = method[0].replace(/\/.*$/, '');
    const result = method[1].toLowerCase();
    if (!/^[a-z]+$/.test(result)) continue;
    const prop = (k: string) => props.find(([p]) => p === k)?.[1];
    if (name === 'spf' && !out.spf) {
      out.spf = result;
      const mf = prop('smtp.mailfrom');
      if (mf) out.spfMailFrom = domainPart(mf);
    } else if (name === 'dkim') {
      // Several DKIM signatures: any pass counts as pass.
      if (!out.dkim || result === 'pass') out.dkim = result;
      const d = prop('header.d');
      if (result === 'pass' && d) out.dkimPassDomains.push(domainPart(d));
    } else if (name === 'dmarc' && !out.dmarc) {
      out.dmarc = result;
      const hf = prop('header.from');
      if (hf) out.dmarcHeaderFrom = domainPart(hf);
    }
  }
  return out;
}

/**
 * The first Authentication-Results header in document order, and only when Cloudflare stamped it (authserv-id
 * exactly mx.cloudflare.net). Cloudflare prepends its own, so anything below it, ARC-Authentication-Results
 * included, is sender-controlled and ignored; a non-Cloudflare first header means no verdict at all.
 */
export function trustedAuthResults(headerValues: string[]): ParsedAuth | null {
  const p = parseAuthResults(headerValues[0]);
  return p?.authservId === TRUSTED_AUTHSERV_ID ? p : null;
}

/**
 * Organizational domain as the last two labels. Without the Public Suffix List this is wrong for
 * suffixes like co.uk (example.co.uk → co.uk), so it only ever widens DKIM alignment to that parent.
 */
export function orgDomain(domain: string): string {
  return domain.split('.').slice(-2).join('.');
}

/**
 * True when an authentication pass vouches for the visible From domain: DMARC passed for that header.from,
 * or a DKIM signature passed with d= equal to the From domain or its organizational parent.
 */
export function isAligned(p: ParsedAuth | null, fromDomain: string): boolean {
  const from = fromDomain.toLowerCase().replace(/\.$/, '');
  if (!p || !from.includes('.')) return false;
  if (p.dmarc === 'pass' && p.dmarcHeaderFrom === from) return true;
  const parent = orgDomain(from);
  return p.dkimPassDomains.some((d) => d === from || d === parent);
}

/** The stored and displayed shape: verdict words plus the alignment result. */
export function toAuthResults(p: ParsedAuth | null, fromDomain: string): AuthResults | null {
  if (!p) return null;
  const out: AuthResults = {};
  if (p.spf) out.spf = p.spf;
  if (p.dkim) out.dkim = p.dkim;
  if (p.dmarc) out.dmarc = p.dmarc;
  out.aligned = isAligned(p, fromDomain);
  return out;
}

/** True when SPF passed for the envelope sender's domain (smtp.mailfrom), not just for the HELO name. */
export function spfPassesFor(p: ParsedAuth | null, envelopeDomain: string): boolean {
  return !!p && p.spf === 'pass' && !!envelopeDomain && p.spfMailFrom === envelopeDomain.toLowerCase();
}

export interface SpamInput { auth: AuthResults | null; blocked: boolean; inContacts: boolean }

export function scoreSpam(i: SpamInput): { score: number; isSpam: boolean } {
  if (i.blocked) return { score: 10, isSpam: true };
  let score = 0;
  if (i.auth?.dmarc === 'fail') score += 5;
  if (i.auth?.spf === 'fail') score += 2;
  if (i.auth?.dkim === 'fail') score += 2;
  // The header From is spoofable, so the contact bonus needs a pass aligned with it (an unaligned pass is no pass).
  const trustedContact = i.inContacts && i.auth?.aligned === true && i.auth.dmarc !== 'fail';
  if (trustedContact) score -= 3;
  score = Math.max(0, Math.min(10, score));
  return { score, isSpam: !trustedContact && score >= SPAM_THRESHOLD };
}

export function isBlocked(sender: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPattern(sender, p));
}
