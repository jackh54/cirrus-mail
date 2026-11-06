// The browser-side crypto (src/client/lib/pgp), exercised in the Workers runtime: it only needs WebCrypto.
import * as openpgp from 'openpgp';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  decryptArmored, encryptForSending, generateKey, importPrivateKey, signCleartext, unlockPrivateKey, verifyCleartext, verifyDetached,
} from '../src/client/lib/pgp/crypto';
import { detectPgp, extractEncryptedBlock } from '../src/client/lib/pgp/detect';
import { splitPgpSigned } from '../src/client/lib/pgp/mime';
import { normalizeArmoredPublicKey } from '../src/worker/lib/pgp';

type Gen = Awaited<ReturnType<typeof generateKey>>;
const keys: { alice?: Gen; bob?: Gen; eve?: Gen } = {};

beforeAll(async () => {
  keys.alice = await generateKey({ name: 'Alice', emails: ['alice@example.org'], passphrase: 'correct horse battery' });
  keys.bob = await generateKey({ name: 'Bob', emails: ['bob@example.org', 'bob@work.example.org'], passphrase: 'hunter2hunter2' });
  keys.eve = await generateKey({ name: 'Eve', emails: ['eve@example.org'], passphrase: 'evepassphrase' });
}, 60_000);

describe('keys', () => {
  it('generates a key whose private half is passphrase-protected and unlocks only with the right passphrase', async () => {
    const { alice } = keys;
    expect(alice!.addresses).toEqual(['alice@example.org']);
    expect(alice!.privateKey).toContain('BEGIN PGP PRIVATE KEY BLOCK');
    const locked = await openpgp.readPrivateKey({ armoredKey: alice!.privateKey });
    expect(locked.isDecrypted()).toBe(false);
    await expect(unlockPrivateKey(alice!.privateKey, 'wrong')).rejects.toThrow('Wrong passphrase.');
    const open = await unlockPrivateKey(alice!.privateKey, 'correct horse battery');
    expect(open.isDecrypted()).toBe(true);
    expect(open.getFingerprint().toUpperCase()).toBe(alice!.fingerprint);
  });

  it('the server accepts the generated public key and computes the same fingerprint', async () => {
    expect((await normalizeArmoredPublicKey(keys.alice!.publicKey)).fingerprint).toBe(keys.alice!.fingerprint);
    expect((await normalizeArmoredPublicKey(keys.bob!.publicKey)).fingerprint).toBe(keys.bob!.fingerprint);
  });

  it('imports an unprotected private key and re-encrypts it', async () => {
    const plain = await openpgp.generateKey({ type: 'curve25519', userIDs: [{ email: 'zed@example.org' }], format: 'armored' });
    const g = await importPrivateKey(plain.privateKey, '', 'new passphrase!');
    expect((await openpgp.readPrivateKey({ armoredKey: g.privateKey })).isDecrypted()).toBe(false);
    await expect(importPrivateKey('nonsense', '', 'x')).rejects.toThrow(/not an armored/);
    expect((await unlockPrivateKey(g.privateKey, 'new passphrase!')).getFingerprint().toUpperCase()).toBe(g.fingerprint);
  });
});

describe('encrypt, decrypt and verify', () => {
  it('round-trips a PGP/MIME payload to a recipient and to self, with a valid signature', async () => {
    const alice = await unlockPrivateKey(keys.alice!.privateKey, 'correct horse battery');
    const armored = await encryptForSending({ text: 'Meet at noon.\nBring the files.', recipients: [keys.bob!.publicKey], own: keys.alice!.publicKey, signer: alice });
    expect(armored).toContain('BEGIN PGP MESSAGE');
    expect(armored).not.toContain('Meet at noon');

    const bob = await unlockPrivateKey(keys.bob!.privateKey, 'hunter2hunter2');
    const out = await decryptArmored(armored, bob, [keys.alice!.publicKey]);
    const entity = new TextDecoder().decode(out.data);
    expect(entity).toBe('Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nMeet at noon.\r\nBring the files.');
    expect(out.signature).toEqual({ state: 'valid', fingerprint: keys.alice!.fingerprint });

    // The sender can read their own copy.
    const self = await decryptArmored(armored, alice, [keys.alice!.publicKey]);
    expect(new TextDecoder().decode(self.data)).toBe(entity);
  });

  it('reports an unknown key when the signer is not in the keyring, and none when unsigned', async () => {
    const alice = await unlockPrivateKey(keys.alice!.privateKey, 'correct horse battery');
    const bob = await unlockPrivateKey(keys.bob!.privateKey, 'hunter2hunter2');
    const signed = await encryptForSending({ text: 'hi', recipients: [keys.bob!.publicKey], own: keys.alice!.publicKey, signer: alice });
    expect((await decryptArmored(signed, bob, [keys.eve!.publicKey])).signature).toEqual({ state: 'unknown' });
    expect((await decryptArmored(signed, bob, [])).signature).toEqual({ state: 'unknown' });
    const unsigned = await encryptForSending({ text: 'hi', recipients: [keys.bob!.publicKey], own: keys.alice!.publicKey });
    expect((await decryptArmored(unsigned, bob, [keys.alice!.publicKey])).signature).toEqual({ state: 'none' });
  });

  it('cannot be decrypted by someone who was not a recipient', async () => {
    const eve = await unlockPrivateKey(keys.eve!.privateKey, 'evepassphrase');
    const armored = await encryptForSending({ text: 'secret', recipients: [keys.bob!.publicKey], own: keys.alice!.publicKey });
    await expect(decryptArmored(armored, eve, [])).rejects.toThrow(/Could not decrypt/);
  });

  it('hides recipient key IDs when asked (Bcc)', async () => {
    const armored = await encryptForSending({ text: 'x', recipients: [keys.bob!.publicKey], own: keys.alice!.publicKey, hideRecipients: true });
    const msg = await openpgp.readMessage({ armoredMessage: armored });
    expect(msg.getEncryptionKeyIDs().every((id) => id.toHex() === '0000000000000000')).toBe(true);
    const bob = await unlockPrivateKey(keys.bob!.privateKey, 'hunter2hunter2');
    expect(new TextDecoder().decode((await decryptArmored(armored, bob, [])).data)).toContain('\r\n\r\nx');
  });
});

describe('cleartext signatures', () => {
  it('signs, verifies, and flags a tampered body as bad', async () => {
    const alice = await unlockPrivateKey(keys.alice!.privateKey, 'correct horse battery');
    const armored = await signCleartext('Pay the invoice by Friday.\n', alice);
    expect(armored).toContain('BEGIN PGP SIGNED MESSAGE');
    const ok = await verifyCleartext(armored, [keys.alice!.publicKey]);
    expect(ok.signature).toEqual({ state: 'valid', fingerprint: keys.alice!.fingerprint });
    expect(ok.text.trim()).toBe('Pay the invoice by Friday.');

    const tampered = armored.replace('by Friday', 'by Monday');
    expect((await verifyCleartext(tampered, [keys.alice!.publicKey])).signature.state).toBe('bad');
    expect((await verifyCleartext(armored, [keys.eve!.publicKey])).signature.state).toBe('unknown');
  });
});

describe('PGP/MIME multipart/signed', () => {
  async function build(body: string, signer: openpgp.PrivateKey, lineEnd = '\r\n') {
    const part = `Content-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
    const sig = await openpgp.sign({ message: await openpgp.createMessage({ binary: new TextEncoder().encode(part) }), signingKeys: signer, detached: true, format: 'armored' });
    const eml = [
      'From: alice@example.org', 'To: bob@example.org', 'Subject: signed', 'MIME-Version: 1.0',
      'Content-Type: multipart/signed; micalg=pgp-sha256; protocol="application/pgp-signature"; boundary="SIG"', '',
      '--SIG', part, '--SIG', 'Content-Type: application/pgp-signature; name="signature.asc"', '', sig.trim(), '--SIG--', '',
    ].join('\r\n');
    return new TextEncoder().encode(lineEnd === '\r\n' ? eml : eml.replace(/\r\n/g, lineEnd));
  }

  it('extracts the exact signed part and verifies it', async () => {
    const alice = await unlockPrivateKey(keys.alice!.privateKey, 'correct horse battery');
    const raw = await build('Signed body.\r\nSecond line.', alice);
    const parts = splitPgpSigned(raw)!;
    expect(new TextDecoder().decode(parts.signed)).toBe('Content-Type: text/plain; charset=utf-8\r\n\r\nSigned body.\r\nSecond line.');
    expect(await verifyDetached(parts.signed, parts.signature, [keys.alice!.publicKey])).toEqual({ state: 'valid', fingerprint: keys.alice!.fingerprint });
    expect((await verifyDetached(parts.signed, parts.signature, [keys.eve!.publicKey])).state).toBe('unknown');
  });

  it('is bad when the content changed, and still verifies after LF-only transport', async () => {
    const alice = await unlockPrivateKey(keys.alice!.privateKey, 'correct horse battery');
    const raw = await build('Original.', alice);
    const forged = new TextEncoder().encode(new TextDecoder().decode(raw).replace('Original.', 'Altered.'));
    const bad = splitPgpSigned(forged)!;
    expect((await verifyDetached(bad.signed, bad.signature, [keys.alice!.publicKey])).state).toBe('bad');

    const lf = splitPgpSigned(await build('Original.', alice, '\n'))!;
    expect((await verifyDetached(lf.signed, lf.signature, [keys.alice!.publicKey])).state).toBe('valid');
  });

  it('returns null for anything that is not a PGP multipart/signed', () => {
    expect(splitPgpSigned(new TextEncoder().encode('Subject: hi\r\n\r\nplain'))).toBeNull();
    expect(splitPgpSigned(new TextEncoder().encode('Content-Type: multipart/signed; protocol="application/pkcs7-signature"; boundary=x\r\n\r\n--x\r\n\r\na\r\n--x\r\n\r\nb\r\n--x--\r\n'))).toBeNull();
  });
});

describe('detection', () => {
  const base = { status: 'received', text: '', html: null, attachments: [] } as unknown as Parameters<typeof detectPgp>[0];
  const att = (mimeType: string, filename = '', id = mimeType) => ({ id, mimeType, filename, size: 1, contentId: null, inline: false, url: '/f' });

  it('recognises PGP/MIME encrypted, inline encrypted, PGP/MIME signed and cleartext signed', () => {
    const enc = detectPgp({ ...base, attachments: [att('application/pgp-encrypted'), att('application/octet-stream', 'encrypted.asc')] });
    expect(enc?.kind).toBe('encrypted-mime');
    expect(enc?.payload?.filename).toBe('encrypted.asc');
    expect(detectPgp({ ...base, text: 'hello\n-----BEGIN PGP MESSAGE-----\n\nabc\n-----END PGP MESSAGE-----\n' })?.kind).toBe('encrypted-inline');
    expect(detectPgp({ ...base, attachments: [att('application/pgp-signature', 'signature.asc')] })?.kind).toBe('signed-mime');
    expect(detectPgp({ ...base, text: '-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nx\n-----BEGIN PGP SIGNATURE-----\n\nabc\n-----END PGP SIGNATURE-----' })?.kind).toBe('signed-inline');
    expect(detectPgp({ ...base, text: 'just mail' })).toBeNull();
    expect(detectPgp({ ...base, status: 'draft', text: '-----BEGIN PGP MESSAGE-----\nx\n-----END PGP MESSAGE-----' })).toBeNull();
    expect(extractEncryptedBlock('a\n-----BEGIN PGP MESSAGE-----\nx\n-----END PGP MESSAGE-----\nb')).toBe('-----BEGIN PGP MESSAGE-----\nx\n-----END PGP MESSAGE-----');
  });
});
