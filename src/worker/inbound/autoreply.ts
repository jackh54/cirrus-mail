// Vacation auto-reply (RFC 3834 style): at most one reply per sender per 4 days, at most
// AUTOREPLY_DAILY_CAP per mailbox per day, and only to senders that passed SPF or DMARC (no backscatter).
import type { AuthResults } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { cleanHeaderText } from '../lib/validate';

const DAY = 24 * 3600 * 1000;
const FOUR_DAYS = 4 * DAY;
export const AUTOREPLY_DAILY_CAP = 50;

export interface AutoreplyMailbox {
  id: string; address: string; display_name: string; autoreply_enabled: number; autoreply_subject: string;
  autoreply_body: string; autoreply_start: number | null; autoreply_end: number | null;
}

export interface AutoreplyInput {
  sender: string;                       // envelope sender, lowercase
  subject: string;
  messageId: string | null;
  headers: (name: string) => string | null;
  auth: AuthResults | null;
  ownAddresses: Set<string>;
  now: number;
}

export function autoreplyEligible(mb: AutoreplyMailbox, i: AutoreplyInput): boolean {
  if (!mb.autoreply_enabled) return false;
  if (mb.autoreply_start && i.now < mb.autoreply_start) return false;
  if (mb.autoreply_end && i.now > mb.autoreply_end) return false;
  // A forged envelope sender would turn us into a backscatter source: require an authenticated sender.
  if (i.auth?.spf !== 'pass' && i.auth?.dmarc !== 'pass') return false;
  if (!i.sender || i.ownAddresses.has(i.sender)) return false;
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?)[@+]/i.test(i.sender)) return false;
  const auto = i.headers('auto-submitted');
  if (auto && auto.trim().toLowerCase() !== 'no') return false;
  if (i.headers('list-id') || i.headers('list-unsubscribe')) return false;
  if (/^(bulk|list|junk)$/i.test((i.headers('precedence') ?? '').trim())) return false;
  return true;
}

export async function maybeAutoreply(env: Env, mb: AutoreplyMailbox, i: AutoreplyInput): Promise<boolean> {
  if (!autoreplyEligible(mb, i)) return false;
  // One atomic claim enforces both limits. autoreply_log keeps one row per sender (its last reply),
  // and a sender gets at most one reply per 4 days, so rows touched in the last day = replies today.
  const claim = await env.DB.prepare(
    `INSERT INTO autoreply_log (mailbox_id, sender, sent_at)
       SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM autoreply_log WHERE mailbox_id = ?1 AND sent_at > ?5) < ?6
     ON CONFLICT(mailbox_id, sender) DO UPDATE SET sent_at = ?3 WHERE autoreply_log.sent_at < ?4`,
  ).bind(mb.id, i.sender, i.now, i.now - FOUR_DAYS, i.now - DAY, AUTOREPLY_DAILY_CAP).run();
  if (!claim.meta.changes) return false;
  const headers: Record<string, string> = { 'Auto-Submitted': 'auto-replied' };
  const msgId = i.messageId ? cleanHeaderText(i.messageId).trim() : '';
  if (msgId) {
    headers['In-Reply-To'] = msgId;
    headers['References'] = msgId;
  }
  // The incoming subject was decoded by postal-mime and may carry encoded CR/LF: sanitise it.
  const subject = cleanHeaderText(mb.autoreply_subject || `Re: ${i.subject}`).trim().slice(0, 200) || 'Automatic reply';
  const name = cleanHeaderText(mb.display_name).trim();
  let ok = 0;
  let code: string | null = null;
  try {
    await env.EMAIL.send({
      from: name ? { email: mb.address, name } : mb.address,
      to: i.sender,
      subject,
      text: mb.autoreply_body,
      headers,
    });
    ok = 1;
  } catch (e) {
    const raw = (e as { code?: unknown }).code;
    code = typeof raw === 'string' && /^E_[A-Z_]{1,48}$/.test(raw) ? raw : 'E_DELIVERY_FAILED';
    console.error('autoreply failed', code);
  }
  await env.DB.prepare('INSERT INTO send_log (id, mailbox_id, message_id, recipients, ok, error_code, created_at) VALUES (?, ?, NULL, 1, ?, ?, ?)')
    .bind(ulid(i.now), mb.id, ok, code, i.now).run();
  return ok === 1;
}
