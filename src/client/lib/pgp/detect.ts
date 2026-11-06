// Spots OpenPGP content in a message without loading openpgp.js (this file is in the main chunk).
import type { Attachment, MessageFull } from '@shared/api';

export type PgpKind = 'encrypted-mime' | 'encrypted-inline' | 'signed-mime' | 'signed-inline';

export interface PgpDetection {
  kind: PgpKind;
  /** For PGP/MIME: the part holding the armored encrypted message. */
  payload?: Attachment;
}

const ENCRYPTED_BLOCK = /-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/;
const SIGNED_BLOCK = /-----BEGIN PGP SIGNED MESSAGE-----[\s\S]*?-----END PGP SIGNATURE-----/;

export function extractEncryptedBlock(text: string): string | null {
  return ENCRYPTED_BLOCK.exec(text)?.[0] ?? null;
}

export function extractSignedBlock(text: string): string | null {
  return SIGNED_BLOCK.exec(text)?.[0] ?? null;
}

const isControl = (a: Attachment) => a.mimeType === 'application/pgp-encrypted';
const looksLikePayload = (a: Attachment) => /\.(asc|pgp|gpg)$/i.test(a.filename) || a.mimeType === 'application/octet-stream' || a.mimeType === 'application/pgp-encrypted';

export function detectPgp(m: MessageFull): PgpDetection | null {
  if (m.status === 'draft') return null;
  if (m.attachments.some(isControl)) {
    const payload = m.attachments.find((a) => !isControl(a) && looksLikePayload(a)) ?? m.attachments.find((a) => !isControl(a));
    if (payload) return { kind: 'encrypted-mime', payload };
  }
  const text = m.text ?? '';
  if (ENCRYPTED_BLOCK.test(text)) return { kind: 'encrypted-inline' };
  if (m.attachments.some((a) => a.mimeType === 'application/pgp-signature')) return { kind: 'signed-mime' };
  if (SIGNED_BLOCK.test(text)) return { kind: 'signed-inline' };
  return null;
}

/** Attachments to list: the PGP plumbing parts (version marker, payload, signature) are not real attachments. */
export function visibleAttachments(m: MessageFull, d: PgpDetection | null): Attachment[] {
  if (!d) return m.attachments;
  return m.attachments.filter((a) => !isControl(a) && a.mimeType !== 'application/pgp-signature' && a.id !== d.payload?.id);
}
