// Envelope recipient → mailbox: exact mailbox, then alias, then the domain catch-all.
import { domainOf, normalizeEmail } from '../lib/addresses';

export interface Recipient { mailboxId: string; via: 'mailbox' | 'alias' | 'catch_all' }

export async function resolveRecipient(db: D1Database, rcpt: string): Promise<Recipient | null> {
  const addr = normalizeEmail(rcpt);
  const at = addr.lastIndexOf('@');
  if (at < 1) return null;
  // Sub-addressing: alex+news@x resolves like alex@x when the exact address is unknown.
  const plus = addr.slice(0, at).indexOf('+');
  const candidates = plus > 0 ? [addr, addr.slice(0, plus) + addr.slice(at)] : [addr];
  for (const a of candidates) {
    const mb = await db.prepare('SELECT id FROM mailboxes WHERE address = ?').bind(a).first<string>('id');
    if (mb) return { mailboxId: mb, via: 'mailbox' };
    const al = await db.prepare('SELECT mailbox_id FROM aliases WHERE address = ?').bind(a).first<string>('mailbox_id');
    if (al) return { mailboxId: al, via: 'alias' };
  }
  const ca = await db.prepare('SELECT catch_all_mailbox_id FROM domains WHERE name = ?').bind(domainOf(addr)).first<string | null>('catch_all_mailbox_id');
  if (ca) return { mailboxId: ca, via: 'catch_all' };
  return null;
}
