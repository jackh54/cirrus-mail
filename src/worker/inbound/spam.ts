// Spam verdict: score 0–10, spam at ≥ 5. Blocklist → spam; known contact → −3 and never spam.
import type { AuthResults } from '../../shared/api';
import { matchesPattern } from '../lib/addresses';

export const SPAM_THRESHOLD = 5;

/** Parses spf/dkim/dmarc verdicts from the (topmost, Cloudflare-added) Authentication-Results header. */
export function parseAuthResults(header: string | null | undefined): AuthResults | null {
  if (!header) return null;
  const out: AuthResults = {};
  const re = /\b(spf|dkim|dmarc)\s*=\s*([a-z]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header))) {
    const k = m[1].toLowerCase() as keyof AuthResults;
    const v = m[2].toLowerCase();
    // Several DKIM signatures: any pass counts as pass.
    if (!out[k] || (k === 'dkim' && v === 'pass')) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

export interface SpamInput { auth: AuthResults | null; blocked: boolean; inContacts: boolean }

export function scoreSpam(i: SpamInput): { score: number; isSpam: boolean } {
  if (i.blocked) return { score: 10, isSpam: true };
  let score = 0;
  if (i.auth?.dmarc === 'fail') score += 5;
  if (i.auth?.spf === 'fail') score += 2;
  if (i.auth?.dkim === 'fail') score += 2;
  if (i.inContacts) score -= 3;
  score = Math.max(0, Math.min(10, score));
  return { score, isSpam: !i.inContacts && score >= SPAM_THRESHOLD };
}

export function isBlocked(sender: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPattern(sender, p));
}
