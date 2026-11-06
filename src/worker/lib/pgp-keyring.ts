// A user's keyring of other people's public keys, and the rule that a changed key never replaces silently.
import type { AuthResults, PgpKeyringEntry, PgpSource } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { autocryptTrusted, armorPublicKey, parseAutocrypt } from './pgp';

export const MAX_KEYRING_ENTRIES = 2000;

export interface KeyringRow {
  id: string; user_id: string; email: string; public_key: string; fingerprint: string; source: PgpSource;
  pending_public_key: string | null; pending_fingerprint: string | null; pending_source: PgpSource | null; pending_at: number | null;
  created_at: number; updated_at: number;
}

export function rowToEntry(r: KeyringRow): PgpKeyringEntry {
  return {
    id: r.id, email: r.email, publicKey: r.public_key, fingerprint: r.fingerprint, source: r.source,
    createdAt: r.created_at, updatedAt: r.updated_at,
    pending: r.pending_fingerprint && r.pending_public_key && r.pending_source
      ? { publicKey: r.pending_public_key, fingerprint: r.pending_fingerprint, source: r.pending_source, at: r.pending_at ?? r.updated_at }
      : null,
  };
}

export type UpsertStatus = 'created' | 'unchanged' | 'replaced' | 'pending' | 'conflict' | 'full';

/**
 * Adds or refreshes the key for `email`. A key with a different fingerprint than the stored one is never
 * written over it: an automatic source (Autocrypt, WKD) parks it as pending, and a manual import is refused
 * with 'conflict' unless the user explicitly chose to replace.
 */
export async function upsertKeyring(
  db: D1Database, userId: string, email: string, key: { armored: string; fingerprint: string },
  source: PgpSource, opts: { replace?: boolean } = {}, now = Date.now(),
): Promise<UpsertStatus> {
  const e = email.trim().toLowerCase();
  const row = await db.prepare('SELECT * FROM pgp_keyring WHERE user_id = ? AND email = ?').bind(userId, e).first<KeyringRow>();
  if (!row) {
    const n = await db.prepare('SELECT COUNT(*) AS n FROM pgp_keyring WHERE user_id = ?').bind(userId).first<number>('n');
    if ((n ?? 0) >= MAX_KEYRING_ENTRIES) return 'full';
    await db.prepare('INSERT INTO pgp_keyring (id, user_id, email, public_key, fingerprint, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(ulid(now), userId, e, key.armored, key.fingerprint, source, now, now).run();
    return 'created';
  }
  if (row.fingerprint === key.fingerprint) {
    // Same key (maybe with a new expiry or subkey). A manual import upgrades the label, nothing downgrades it.
    const keepSource = row.source === 'manual' ? 'manual' : source;
    await db.prepare(
      `UPDATE pgp_keyring SET public_key = ?, source = ?, updated_at = ?,
              pending_public_key = CASE WHEN pending_fingerprint = ?4 THEN NULL ELSE pending_public_key END,
              pending_source = CASE WHEN pending_fingerprint = ?4 THEN NULL ELSE pending_source END,
              pending_at = CASE WHEN pending_fingerprint = ?4 THEN NULL ELSE pending_at END,
              pending_fingerprint = CASE WHEN pending_fingerprint = ?4 THEN NULL ELSE pending_fingerprint END
        WHERE id = ?`,
    ).bind(key.armored, keepSource, now, key.fingerprint, row.id).run();
    return 'unchanged';
  }
  if (source === 'manual') {
    if (!opts.replace) return 'conflict';
    await db.prepare(
      `UPDATE pgp_keyring SET public_key = ?, fingerprint = ?, source = 'manual', updated_at = ?,
              pending_public_key = NULL, pending_fingerprint = NULL, pending_source = NULL, pending_at = NULL WHERE id = ?`,
    ).bind(key.armored, key.fingerprint, now, row.id).run();
    return 'replaced';
  }
  await db.prepare('UPDATE pgp_keyring SET pending_public_key = ?, pending_fingerprint = ?, pending_source = ?, pending_at = ? WHERE id = ?')
    .bind(key.armored, key.fingerprint, source, now, row.id).run();
  return 'pending';
}

/**
 * Inbound mail: stores the sender's Autocrypt key in the keyring of every member of the mailbox, but only when
 * the message passed aligned DMARC and the header's addr matches From. Never throws: mail delivery comes first.
 */
export async function storeAutocrypt(
  db: D1Database, mailboxId: string, fromEmail: string, headerValues: string[], auth: AuthResults | null,
): Promise<number> {
  try {
    if (!headerValues.length || !autocryptTrusted(auth)) return 0;
    const key = await parseAutocrypt(headerValues, fromEmail);
    if (!key) return 0;
    const armored = armorPublicKey(key.bytes);
    const { results } = await db.prepare('SELECT user_id FROM mailbox_members WHERE mailbox_id = ?').bind(mailboxId).all<{ user_id: string }>();
    let stored = 0;
    for (const m of results) {
      const status = await upsertKeyring(db, m.user_id, fromEmail, { armored, fingerprint: key.fingerprint }, 'autocrypt');
      if (status !== 'full') stored++;
    }
    return stored;
  } catch (e) {
    console.error('autocrypt error', (e as Error).name);
    return 0;
  }
}
