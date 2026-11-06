// Passkey ceremonies on top of lib/webauthn.ts: challenge storage, options, and the register / sign-in checks.
import { z } from 'zod';
import type { PasskeyAssertionJSON, PasskeyAttestationJSON } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { randomBytes, toBase64Url } from './crypto';
import { HttpError } from './errors';
import {
  ALLOWED_ALGS, parseClientData, verifyAssertion, verifyRegistration, type ClientData, type Expected,
} from './webauthn';

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MAX_PASSKEYS_PER_USER = 20;
const TRANSPORTS = new Set(['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card']);

const b64 = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+$/);
export const PasskeyAssertionSchema = z.object({
  id: b64(1400), rawId: b64(1400), type: z.literal('public-key'),
  response: z.object({ clientDataJSON: b64(4096), authenticatorData: b64(4096), signature: b64(2048), userHandle: b64(256).nullish() }),
});
export const PasskeyAttestationSchema = z.object({
  id: b64(1400), rawId: b64(1400), type: z.literal('public-key'),
  response: z.object({ clientDataJSON: b64(4096), attestationObject: b64(32768), transports: z.array(z.string().max(20)).max(8).optional() }),
});

export interface PasskeyRow {
  id: string; user_id: string; credential_id: string; public_key: string; alg: number; sign_count: number;
  transports: string | null; name: string; created_at: number; last_used_at: number | null;
}

/** Where the ceremony must have happened: derived from the request URL, never from a header the client controls. */
export interface RelyingParty { origin: string; rpId: string }

export function relyingParty(requestUrl: string): RelyingParty {
  const u = new URL(requestUrl);
  return { origin: u.origin, rpId: u.hostname };
}

export const loginFailed = () => new HttpError(401, 'INVALID_CREDENTIALS', 'Passkey sign-in failed');
const registerFailed = () => new HttpError(400, 'PASSKEY_INVALID', 'Could not verify the passkey. Try again.');

// ---------- challenges ----------

export async function issueChallenge(db: D1Database, purpose: 'register' | 'login', userId: string | null, now: number): Promise<string> {
  const challenge = toBase64Url(randomBytes(32));
  await db.batch([
    db.prepare('DELETE FROM webauthn_challenges WHERE expires_at < ?').bind(now),
    db.prepare('INSERT INTO webauthn_challenges (challenge, purpose, user_id, expires_at) VALUES (?, ?, ?, ?)')
      .bind(challenge, purpose, userId, now + CHALLENGE_TTL_MS),
  ]);
  return challenge;
}

/** Spends a challenge. The conditional DELETE ... RETURNING makes "use once" atomic; purpose and user must match. */
export async function consumeChallenge(db: D1Database, challenge: string, purpose: 'register' | 'login', userId: string | null, now: number): Promise<boolean> {
  if (challenge.length > 64) return false;
  const row = await db.prepare(
    'DELETE FROM webauthn_challenges WHERE challenge = ? AND purpose = ? AND user_id IS ? AND expires_at >= ? RETURNING challenge',
  ).bind(challenge, purpose, userId, now).first();
  return row !== null;
}

// ---------- options (PublicKeyCredential*OptionsJSON) ----------

const utf8B64 = (s: string) => toBase64Url(new TextEncoder().encode(s));

export async function registrationOptions(
  db: D1Database, user: { id: string; email: string; name: string }, rp: RelyingParty, appName: string, now: number,
) {
  const challenge = await issueChallenge(db, 'register', user.id, now);
  const { results } = await db.prepare('SELECT credential_id, transports FROM passkeys WHERE user_id = ?').bind(user.id).all<Pick<PasskeyRow, 'credential_id' | 'transports'>>();
  return {
    rp: { id: rp.rpId, name: appName },
    user: { id: utf8B64(user.id), name: user.email, displayName: user.name },
    challenge,
    pubKeyCredParams: ALLOWED_ALGS.map((alg) => ({ type: 'public-key', alg })),
    timeout: CHALLENGE_TTL_MS,
    attestation: 'none',
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
    excludeCredentials: results.map((r) => ({
      type: 'public-key', id: r.credential_id, ...(r.transports ? { transports: JSON.parse(r.transports) as string[] } : {}),
    })),
  };
}

/** `mfa` asks for user verification only if available (the password already was a factor); otherwise it is required. */
export async function authenticationOptions(db: D1Database, rp: RelyingParty, mfa: boolean, now: number) {
  return {
    challenge: await issueChallenge(db, 'login', null, now),
    rpId: rp.rpId,
    timeout: CHALLENGE_TTL_MS,
    userVerification: mfa ? 'preferred' : 'required',
  };
}

// ---------- registration ----------

export async function finishRegistration(
  db: D1Database, user: { id: string }, cred: PasskeyAttestationJSON, name: string, rp: RelyingParty, now: number,
): Promise<PasskeyRow> {
  let verified;
  try {
    const { data } = parseClientData(cred.response.clientDataJSON);
    if (!(await consumeChallenge(db, data.challenge, 'register', user.id, now))) throw new Error('challenge');
    const exp: Expected = { type: 'webauthn.create', origin: rp.origin, rpId: rp.rpId };
    verified = await verifyRegistration(cred.response, data, exp);
    if (verified.credentialId !== cred.id) throw new Error('credential id mismatch');
  } catch {
    throw registerFailed();
  }
  const count = await db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').bind(user.id).first<number>('n');
  if ((count ?? 0) >= MAX_PASSKEYS_PER_USER) throw new HttpError(400, 'PASSKEY_LIMIT', `You can have at most ${MAX_PASSKEYS_PER_USER} passkeys`);
  const transports = (cred.response.transports ?? []).filter((t) => TRANSPORTS.has(t));
  const row: PasskeyRow = {
    id: ulid(now), user_id: user.id, credential_id: verified.credentialId, public_key: verified.publicKey, alg: verified.alg,
    sign_count: verified.signCount, transports: transports.length ? JSON.stringify(transports) : null, name, created_at: now, last_used_at: null,
  };
  try {
    await db.prepare(
      'INSERT INTO passkeys (id, user_id, credential_id, public_key, alg, sign_count, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(row.id, row.user_id, row.credential_id, row.public_key, row.alg, row.sign_count, row.transports, row.name, row.created_at).run();
  } catch {
    throw new HttpError(409, 'PASSKEY_EXISTS', 'This passkey is already registered');
  }
  return row;
}

// ---------- sign-in ----------

export interface PreparedAssertion {
  pk: PasskeyRow; cred: PasskeyAssertionJSON; data: ClientData; raw: Uint8Array;
}

/**
 * Step 1 of a sign-in: parse the client data, spend the challenge, check type and origin, find the credential.
 * Every failure is the same 401, so nothing says whether a credential or an account exists.
 */
export async function prepareAssertion(db: D1Database, cred: PasskeyAssertionJSON, rp: RelyingParty, now: number): Promise<PreparedAssertion> {
  try {
    const { data, raw } = parseClientData(cred.response.clientDataJSON);
    if (!(await consumeChallenge(db, data.challenge, 'login', null, now))) throw new Error('challenge');
    if (data.type !== 'webauthn.get' || data.origin !== rp.origin) throw new Error('client data');
    if (cred.rawId !== cred.id) throw new Error('id mismatch');
    const pk = await db.prepare('SELECT * FROM passkeys WHERE credential_id = ?').bind(cred.id).first<PasskeyRow>();
    if (!pk) throw new Error('unknown credential');
    // A discoverable credential reports its user handle; when present it must name the owner.
    const handle = cred.response.userHandle;
    if (handle && handle !== utf8B64(pk.user_id)) throw new Error('user handle');
    return { pk, cred, data, raw };
  } catch {
    throw loginFailed();
  }
}

/**
 * Step 2: rpId, flags, signature, then the sign counter. Returns the owner's user id.
 * The counter update is conditional, so two concurrent uses of one assertion cannot both pass.
 */
export async function completeAssertion(db: D1Database, p: PreparedAssertion, rp: RelyingParty, requireUv: boolean, now: number): Promise<string> {
  let signCount: number;
  try {
    const exp: Expected = { type: 'webauthn.get', origin: rp.origin, rpId: rp.rpId };
    signCount = await verifyAssertion(p.cred.response, p.data, p.raw, { publicKey: p.pk.public_key, alg: p.pk.alg }, exp, requireUv);
  } catch {
    throw loginFailed();
  }
  // Counters that stay at zero are allowed (many authenticators never count). Otherwise it must strictly increase.
  const res = await db.prepare(
    'UPDATE passkeys SET sign_count = ?1, last_used_at = ?2 WHERE id = ?3 AND ((?1 = 0 AND sign_count = 0) OR sign_count < ?1)',
  ).bind(signCount, now, p.pk.id).run();
  if (res.meta.changes === 0) throw loginFailed();
  return p.pk.user_id;
}
