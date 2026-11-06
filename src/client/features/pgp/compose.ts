import type { Address, PgpKeyringEntry, PgpOwnKey, PgpSendMode } from '@shared/api';
import { getUnlocked } from '../../lib/pgp/session';
import { draftApi } from '../compose/draftApi';
import { toDraftInput, type ComposeDraft } from '../compose/types';

/** Recipients (To, Cc and Bcc) with no key in the keyring. */
export function missingKeys(recipients: Address[], keyring: PgpKeyringEntry[]): string[] {
  const have = new Set(keyring.map((k) => k.email));
  return [...new Set(recipients.map((r) => r.email.toLowerCase()))].filter((e) => !have.has(e));
}

export function pgpModeOf(d: Pick<ComposeDraft, 'pgpEncrypt' | 'pgpSign'>): PgpSendMode | null {
  return d.pgpEncrypt ? 'mime' : d.pgpSign ? 'inline' : null;
}

/**
 * Encrypts and/or signs the body in the browser and saves the result over the draft. After this the draft on the
 * server holds only the armored payload, with `pgp` telling the server to transport it as it is.
 * The caller makes sure a key is unlocked first when signing.
 */
export async function sealDraft(draft: ComposeDraft, draftId: string, keyring: PgpKeyringEntry[], own: PgpOwnKey): Promise<void> {
  const mode = pgpModeOf(draft);
  if (!mode) return;
  const [{ htmlToPlain }, crypto] = await Promise.all([import('../../lib/pgp/plain'), import('../../lib/pgp/crypto')]);
  const text = htmlToPlain(draft.html);
  let signer;
  if (draft.pgpSign) {
    const u = getUnlocked();
    if (!u || u.fingerprint !== own.fingerprint) throw new Error('Unlock your PGP key to sign.');
    signer = u.key;
  }
  let payload: string;
  if (mode === 'mime') {
    const byEmail = new Map(keyring.map((k) => [k.email, k.publicKey]));
    const recipients = [...draft.to, ...draft.cc, ...draft.bcc].map((r) => byEmail.get(r.email.toLowerCase()));
    if (recipients.some((k) => !k)) throw new Error('Some recipients have no PGP key.');
    payload = await crypto.encryptForSending({
      text, recipients: recipients as string[], own: own.publicKey, signer, hideRecipients: draft.bcc.length > 0,
    });
  } else {
    payload = await crypto.signCleartext(text, signer!);
  }
  await draftApi.update(draft.mailboxId, draftId, { ...toDraftInput(draft), html: '', text: payload, pgp: mode });
}
