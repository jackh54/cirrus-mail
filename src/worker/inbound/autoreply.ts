// Vacation auto-reply (RFC 3834 style): at most one reply per sender per 4 days.
import { ulid } from '../../shared/ulid';

const FOUR_DAYS = 4 * 24 * 3600 * 1000;

export interface AutoreplyMailbox {
  id: string; address: string; display_name: string; autoreply_enabled: number; autoreply_subject: string;
  autoreply_body: string; autoreply_start: number | null; autoreply_end: number | null;
}

export interface AutoreplyInput {
  sender: string;                       // envelope sender, lowercase
  subject: string;
  messageId: string | null;
  headers: (name: string) => string | null;
  ownAddresses: Set<string>;
  now: number;
}

export function autoreplyEligible(mb: AutoreplyMailbox, i: AutoreplyInput): boolean {
  if (!mb.autoreply_enabled) return false;
  if (mb.autoreply_start && i.now < mb.autoreply_start) return false;
  if (mb.autoreply_end && i.now > mb.autoreply_end) return false;
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
  const last = await env.DB.prepare('SELECT sent_at FROM autoreply_log WHERE mailbox_id = ? AND sender = ?').bind(mb.id, i.sender).first<number>('sent_at');
  if (last && i.now - last < FOUR_DAYS) return false;
  // Claim before sending so concurrent deliveries cannot both reply.
  const claim = await env.DB.prepare(
    `INSERT INTO autoreply_log (mailbox_id, sender, sent_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(mailbox_id, sender) DO UPDATE SET sent_at = ?3 WHERE autoreply_log.sent_at < ?4`,
  ).bind(mb.id, i.sender, i.now, i.now - FOUR_DAYS).run();
  if (!claim.meta.changes) return false;
  const headers: Record<string, string> = { 'Auto-Submitted': 'auto-replied' };
  if (i.messageId) {
    headers['In-Reply-To'] = i.messageId;
    headers['References'] = i.messageId;
  }
  const subject = mb.autoreply_subject || `Re: ${i.subject}`.slice(0, 200);
  let ok = 0;
  let code: string | null = null;
  try {
    await env.EMAIL.send({
      from: mb.display_name ? { email: mb.address, name: mb.display_name } : mb.address,
      to: i.sender,
      subject,
      text: mb.autoreply_body,
      headers,
    });
    ok = 1;
  } catch (e) {
    code = String((e as { code?: unknown }).code ?? 'E_DELIVERY_FAILED');
    console.error('autoreply failed', code);
  }
  await env.DB.prepare('INSERT INTO send_log (id, mailbox_id, message_id, recipients, ok, error_code, created_at) VALUES (?, ?, NULL, 1, ?, ?, ?)')
    .bind(ulid(i.now), mb.id, ok, code, i.now).run();
  return ok === 1;
}
