// OpenPGP key storage. Cryptography happens in the browser: the server keeps the user's passphrase-encrypted
// private key (opaque to it), their public key, and a keyring of other people's public keys.
import { Hono } from 'hono';
import { z } from 'zod';
import type { PgpKeyResponse, PgpKeyringEntry, PgpKeyringResponse, PgpOwnKey } from '../../shared/api';
import { HttpError, notFound } from '../lib/errors';
import { lookupWkd, normalizeArmoredPublicKey, armorPublicKey, parseWkdAddress } from '../lib/pgp';
import { rowToEntry, upsertKeyring, type KeyringRow } from '../lib/pgp-keyring';
import { hit } from '../lib/ratelimit';
import { jsonBody, zEmail, zId } from '../lib/validate';
import { requireAuth } from '../middleware/session';
import type { AppEnv } from '../types';

export const pgp = new Hono<AppEnv>();

pgp.use('*', requireAuth);

const WKD_WINDOW_MS = 10 * 60 * 1000;
const WKD_MAX_PER_WINDOW = 30;

interface KeyRow {
  user_id: string; fingerprint: string; public_key: string; private_key_enc: string; addresses: string; revoked: number;
  created_at: number; updated_at: number;
}

function rowToKey(r: KeyRow): PgpOwnKey {
  let addresses: string[] = [];
  try {
    addresses = JSON.parse(r.addresses) as string[];
  } catch { /* keep empty */ }
  return {
    fingerprint: r.fingerprint, publicKey: r.public_key, privateKey: r.private_key_enc, addresses,
    revoked: !!r.revoked, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const zPublicKey = z.string().min(50).max(150_000);
const zPrivateKey = z.string().min(50).max(300_000).refine(
  (s) => /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]+-----END PGP PRIVATE KEY BLOCK-----/.test(s),
  'Expected an armored PGP private key',
);

// ---------- the caller's own key ----------

pgp.get('/key', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM pgp_keys WHERE user_id = ?').bind(c.get('user').id).first<KeyRow>();
  const body: PgpKeyResponse = { key: row ? rowToKey(row) : null };
  return c.json(body);
});

pgp.put('/key', async (c) => {
  const b = await jsonBody(c, z.object({
    publicKey: zPublicKey, privateKey: zPrivateKey, addresses: z.array(zEmail).max(50), revoked: z.boolean().optional(),
  }));
  const pub = await normalizeArmoredPublicKey(b.publicKey);
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO pgp_keys (user_id, fingerprint, public_key, private_key_enc, addresses, revoked, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
     ON CONFLICT(user_id) DO UPDATE SET fingerprint = ?2, public_key = ?3, private_key_enc = ?4, addresses = ?5, revoked = ?6,
       created_at = CASE WHEN pgp_keys.fingerprint = ?2 THEN pgp_keys.created_at ELSE ?7 END, updated_at = ?7`,
  ).bind(c.get('user').id, pub.fingerprint, pub.armored, b.privateKey, JSON.stringify([...new Set(b.addresses)]), b.revoked ? 1 : 0, now).run();
  const row = await c.env.DB.prepare('SELECT * FROM pgp_keys WHERE user_id = ?').bind(c.get('user').id).first<KeyRow>();
  const body: PgpKeyResponse = { key: rowToKey(row!) };
  return c.json(body);
});

pgp.delete('/key', async (c) => {
  await c.env.DB.prepare('DELETE FROM pgp_keys WHERE user_id = ?').bind(c.get('user').id).run();
  return c.json({ ok: true });
});

// ---------- keyring ----------

async function entry(db: D1Database, userId: string, email: string): Promise<PgpKeyringEntry> {
  const row = await db.prepare('SELECT * FROM pgp_keyring WHERE user_id = ? AND email = ?').bind(userId, email.toLowerCase()).first<KeyringRow>();
  return rowToEntry(row!);
}

pgp.get('/keyring', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM pgp_keyring WHERE user_id = ? ORDER BY email').bind(c.get('user').id).all<KeyringRow>();
  return c.json({ items: results.map(rowToEntry) });
});

async function finish(
  c: { get(k: 'user'): { id: string }; env: Env }, email: string, key: { armored: string; fingerprint: string },
  source: 'manual' | 'wkd', replace?: boolean,
) {
  const userId = c.get('user').id;
  const status = await upsertKeyring(c.env.DB, userId, email, key, source, { replace });
  if (status === 'full') throw new HttpError(400, 'KEYRING_FULL', 'Your keyring is full. Remove some keys first.');
  if (status === 'conflict') {
    const cur = await entry(c.env.DB, userId, email);
    throw new HttpError(409, 'KEY_CHANGED', 'A different key is already saved for this address', { existingFingerprint: cur.fingerprint, newFingerprint: key.fingerprint });
  }
  const body: PgpKeyringResponse = { entry: await entry(c.env.DB, userId, email), status };
  return body;
}

pgp.post('/keyring', async (c) => {
  const b = await jsonBody(c, z.object({ email: zEmail, publicKey: zPublicKey, replace: z.boolean().optional() }));
  const key = await normalizeArmoredPublicKey(b.publicKey);
  return c.json(await finish(c, b.email, key, 'manual', b.replace));
});

pgp.post('/keyring/wkd', async (c) => {
  const b = await jsonBody(c, z.object({ email: zEmail }));
  parseWkdAddress(b.email); // reject before spending rate limit or touching the network
  if ((await hit(c.env.DB, `wkd:${c.get('user').id}`, WKD_WINDOW_MS)) > WKD_MAX_PER_WINDOW) {
    throw new HttpError(429, 'RATE_LIMITED', 'Too many key lookups. Try again in a few minutes.');
  }
  const found = await lookupWkd(b.email);
  if (!found) throw notFound('No key published for that address');
  return c.json(await finish(c, b.email, { armored: armorPublicKey(found.bytes), fingerprint: found.fingerprint }, 'wkd'));
});

pgp.post('/keyring/:id/accept', async (c) => {
  const id = zId.parse(c.req.param('id'));
  const res = await c.env.DB.prepare(
    `UPDATE pgp_keyring SET public_key = pending_public_key, fingerprint = pending_fingerprint, source = pending_source, updated_at = ?,
            pending_public_key = NULL, pending_fingerprint = NULL, pending_source = NULL, pending_at = NULL
      WHERE id = ? AND user_id = ? AND pending_fingerprint IS NOT NULL`,
  ).bind(Date.now(), id, c.get('user').id).run();
  if (!res.meta.changes) throw notFound('No pending key');
  const row = await c.env.DB.prepare('SELECT * FROM pgp_keyring WHERE id = ?').bind(id).first<KeyringRow>();
  return c.json({ entry: rowToEntry(row!) });
});

pgp.delete('/keyring/:id/pending', async (c) => {
  const res = await c.env.DB.prepare(
    `UPDATE pgp_keyring SET pending_public_key = NULL, pending_fingerprint = NULL, pending_source = NULL, pending_at = NULL
      WHERE id = ? AND user_id = ? AND pending_fingerprint IS NOT NULL`,
  ).bind(zId.parse(c.req.param('id')), c.get('user').id).run();
  if (!res.meta.changes) throw notFound('No pending key');
  return c.json({ ok: true });
});

pgp.delete('/keyring/:id', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM pgp_keyring WHERE id = ? AND user_id = ?').bind(zId.parse(c.req.param('id')), c.get('user').id).run();
  if (!res.meta.changes) throw notFound('Key not found');
  return c.json({ ok: true });
});
