// All OpenPGP work happens here, in the browser. This module imports openpgp.js (about 400 kB), so nothing
// outside lib/pgp may import it statically: load it with `loadCrypto()` (a dynamic import) so the main chunk stays small.
import * as openpgp from 'openpgp';
import type { KeyID, PrivateKey, PublicKey } from 'openpgp';

export interface GeneratedKey { publicKey: string; privateKey: string; fingerprint: string; addresses: string[] }

export type SigState =
  | { state: 'valid'; fingerprint: string }
  | { state: 'bad'; fingerprint?: string }
  | { state: 'unknown' }
  | { state: 'none' };

const fp = (k: PublicKey | PrivateKey) => k.getFingerprint().toUpperCase();

function emailsOf(key: PublicKey): string[] {
  const out = new Set<string>();
  for (const u of key.users) if (u.userID?.email) out.add(u.userID.email.toLowerCase());
  return [...out];
}

/** A new curve25519 key whose user IDs are `emails`. The private half comes back encrypted with `passphrase`. */
export async function generateKey(opts: { name: string; emails: string[]; passphrase: string }): Promise<GeneratedKey> {
  const { publicKey, privateKey } = await openpgp.generateKey({
    type: 'curve25519',
    userIDs: opts.emails.map((email) => ({ name: opts.name, email })),
    passphrase: opts.passphrase,
    format: 'armored',
  });
  const pub = await openpgp.readKey({ armoredKey: publicKey });
  return { publicKey, privateKey, fingerprint: fp(pub), addresses: emailsOf(pub) };
}

/**
 * Takes an armored private key (encrypted with `keyPassphrase`, or not encrypted at all) and returns it encrypted with
 * `newPassphrase`, ready to store. Throws a readable error when it is not a private key or the passphrase is wrong.
 */
export async function importPrivateKey(armored: string, keyPassphrase: string, newPassphrase: string): Promise<GeneratedKey> {
  let key: PrivateKey;
  try {
    key = await openpgp.readPrivateKey({ armoredKey: armored.trim() });
  } catch {
    throw new Error('That is not an armored PGP private key.');
  }
  if (!key.isDecrypted()) {
    try {
      key = await openpgp.decryptKey({ privateKey: key, passphrase: keyPassphrase });
    } catch {
      throw new Error('The key passphrase is wrong.');
    }
  }
  const encrypted = await openpgp.encryptKey({ privateKey: key, passphrase: newPassphrase });
  const pub = key.toPublic();
  return { publicKey: pub.armor(), privateKey: encrypted.armor(), fingerprint: fp(pub), addresses: emailsOf(pub) };
}

/** Decrypts the stored private key. Throws 'Wrong passphrase.' */
export async function unlockPrivateKey(encryptedArmored: string, passphrase: string): Promise<PrivateKey> {
  const locked = await openpgp.readPrivateKey({ armoredKey: encryptedArmored });
  try {
    return await openpgp.decryptKey({ privateKey: locked, passphrase });
  } catch {
    throw new Error('Wrong passphrase.');
  }
}

/** Revokes the key and returns the revoked public key plus the private key, re-encrypted with the same passphrase. */
export async function revokeStoredKey(encryptedArmored: string, passphrase: string): Promise<{ publicKey: string; privateKey: string }> {
  const key = await unlockPrivateKey(encryptedArmored, passphrase);
  const revoked = await openpgp.revokeKey({ key, reasonForRevocation: { flag: openpgp.enums.reasonForRevocation.noReason, string: '' }, format: 'object' });
  const reEncrypted = await openpgp.encryptKey({ privateKey: revoked.privateKey, passphrase });
  return { publicKey: revoked.publicKey.armor(), privateKey: reEncrypted.armor() };
}

export interface KeyInfo { fingerprint: string; emails: string[]; revoked: boolean; expires: Date | null; algorithm: string }

/** Describes an armored public key. Throws when it cannot be read. */
export async function describePublicKey(armored: string): Promise<KeyInfo> {
  const key = await openpgp.readKey({ armoredKey: armored });
  if (key.isPrivate()) throw new Error('That is a private key. Paste the public key.');
  const expiry = await key.getExpirationTime().catch(() => null);
  return {
    fingerprint: fp(key), emails: emailsOf(key), revoked: await key.isRevoked().catch(() => false),
    expires: expiry instanceof Date ? expiry : null, algorithm: String(key.getAlgorithmInfo().algorithm),
  };
}

// ---------- signatures ----------

interface RawSig { keyID: KeyID; verified: Promise<unknown> }

/** Matches each signature against the keys we trust for it. Unknown = signed by a key we don't have. */
async function classify(signatures: RawSig[], keys: PublicKey[]): Promise<SigState> {
  if (!signatures.length) return { state: 'none' };
  let valid: string | null = null;
  let bad: string | undefined;
  let sawBad = false;
  for (const s of signatures) {
    const owner = keys.find((k) => k.getKeyIDs().some((id) => id.equals(s.keyID)));
    if (!owner) continue;
    try {
      await s.verified;
      valid ??= fp(owner);
    } catch {
      sawBad = true;
      bad ??= fp(owner);
    }
  }
  if (sawBad) return { state: 'bad', fingerprint: bad };
  return valid ? { state: 'valid', fingerprint: valid } : { state: 'unknown' };
}

const readKeys = (armored: string[]) => Promise.all(armored.map((armoredKey) => openpgp.readKey({ armoredKey })));

// ---------- reading ----------

export interface Decrypted { data: Uint8Array; signature: SigState }

/** Decrypts an armored message. `verifyWith` are the public keys whose signatures count. */
export async function decryptArmored(armoredMessage: string, key: PrivateKey, verifyWith: string[]): Promise<Decrypted> {
  const message = await openpgp.readMessage({ armoredMessage });
  const keys = await readKeys(verifyWith);
  let res;
  try {
    res = await openpgp.decrypt({ message, decryptionKeys: key, verificationKeys: keys, format: 'binary' });
  } catch (e) {
    throw new Error(`Could not decrypt this message with your key. ${(e as Error).message}`);
  }
  return { data: res.data as Uint8Array, signature: await classify(res.signatures as RawSig[], keys) };
}

/** A cleartext-signed message ("-----BEGIN PGP SIGNED MESSAGE-----"): its text and whether the signature holds. */
export async function verifyCleartext(armored: string, verifyWith: string[]): Promise<{ text: string; signature: SigState }> {
  const message = await openpgp.readCleartextMessage({ cleartextMessage: armored });
  const keys = await readKeys(verifyWith);
  const res = await openpgp.verify({ message, verificationKeys: keys });
  return { text: res.data, signature: await classify(res.signatures as RawSig[], keys) };
}

/** A PGP/MIME `multipart/signed`: `signed` is the first part exactly as signed (CRLF line endings). */
export async function verifyDetached(signed: Uint8Array, armoredSignature: string, verifyWith: string[]): Promise<SigState> {
  const keys = await readKeys(verifyWith);
  const res = await openpgp.verify({
    message: await openpgp.createMessage({ binary: signed }),
    signature: await openpgp.readSignature({ armoredSignature }),
    verificationKeys: keys,
    format: 'binary',
  });
  return classify(res.signatures as RawSig[], keys);
}

// ---------- writing ----------

/** The MIME entity that goes inside a PGP/MIME encrypted message (RFC 3156 section 4). */
export function mimeEntity(text: string): string {
  return `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${text.replace(/\r?\n/g, '\r\n')}`;
}

/**
 * Encrypts `text` as a PGP/MIME payload (an armored message) for `recipients` plus yourself, signing it first
 * when `signer` is given. With `hideRecipients`, key IDs are left out of the message (use it with Bcc).
 */
export async function encryptForSending(opts: {
  text: string; recipients: string[]; own: string; signer?: PrivateKey; hideRecipients?: boolean;
}): Promise<string> {
  const encryptionKeys = await readKeys([...new Set([...opts.recipients, opts.own])]);
  const message = await openpgp.createMessage({ binary: new TextEncoder().encode(mimeEntity(opts.text)) });
  return openpgp.encrypt({
    message, encryptionKeys, signingKeys: opts.signer, wildcard: opts.hideRecipients, format: 'armored',
  });
}

/** Cleartext-signs `text` (for a message that is signed but not encrypted). */
export async function signCleartext(text: string, signer: PrivateKey): Promise<string> {
  const message = await openpgp.createCleartextMessage({ text });
  return openpgp.sign({ message, signingKeys: signer, format: 'armored' });
}
