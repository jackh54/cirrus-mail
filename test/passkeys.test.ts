import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PasskeyAssertionJSON, PasskeyAttestationJSON } from '../src/shared/api';
import { ulid } from '../src/shared/ulid';
import { fromBase64Url, hashPassword, randomBytes, toBase64Url } from '../src/worker/lib/crypto';
import { call, sessionCookie } from './helpers';

const PASSWORD = 'correct-horse-battery';
const ORIGIN = 'http://localhost'; // helpers.BASE, so the RP ID is "localhost"
const enc = new TextEncoder();

// ---------- a software authenticator ----------

type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
  return [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function cbor(v: Cbor): Uint8Array {
  if (typeof v === 'number') return new Uint8Array(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === 'string') {
    const b = enc.encode(v);
    return new Uint8Array([...head(3, b.length), ...b]);
  }
  if (v instanceof Uint8Array) return new Uint8Array([...head(2, v.length), ...v]);
  const parts: number[] = head(5, v.size);
  for (const [k, x] of v) parts.push(...cbor(k), ...cbor(x));
  return new Uint8Array(parts);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out: Uint8Array = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const sha256 = async (d: Uint8Array | string) => new Uint8Array(await crypto.subtle.digest('SHA-256', typeof d === 'string' ? enc.encode(d) : d));

function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v: Uint8Array = b.slice(i);
    if (v[0] & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

type Alg = 'ES256' | 'RS256' | 'EdDSA';
interface Opts { origin?: string; rpId?: string; uv?: boolean; up?: boolean; count?: number; badSig?: boolean; userHandle?: string | null; challenge?: string; type?: string }

class SoftAuthenticator {
  credId = randomBytes(32);
  signCount = 0;
  private constructor(private alg: Alg, private pair: CryptoKeyPair) {}

  static async make(alg: Alg = 'ES256'): Promise<SoftAuthenticator> {
    const pair = (alg === 'ES256'
      ? await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
      : alg === 'RS256'
        ? await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
        : await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    return new SoftAuthenticator(alg, pair);
  }

  async coseKey(): Promise<Uint8Array> {
    const jwk = (await crypto.subtle.exportKey('jwk', this.pair.publicKey)) as JsonWebKey;
    const b = (s: string | undefined) => fromBase64Url(s!);
    if (this.alg === 'ES256') return cbor(new Map<number, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, b(jwk.x)], [-3, b(jwk.y)]]));
    if (this.alg === 'RS256') return cbor(new Map<number, Cbor>([[1, 3], [3, -257], [-1, b(jwk.n)], [-2, b(jwk.e)]]));
    return cbor(new Map<number, Cbor>([[1, 1], [3, -8], [-1, 6], [-2, b(jwk.x)]]));
  }

  private async authData(rpId: string, o: Opts, withCred: boolean): Promise<Uint8Array> {
    const flags = (o.up === false ? 0 : 0x01) | (o.uv === false ? 0 : 0x04) | (withCred ? 0x40 : 0);
    const count = o.count ?? this.signCount;
    const head37 = concat(await sha256(rpId), new Uint8Array([flags, count >>> 24, (count >> 16) & 255, (count >> 8) & 255, count & 255]));
    if (!withCred) return head37;
    return concat(head37, new Uint8Array(16), new Uint8Array([this.credId.length >> 8, this.credId.length & 255]), this.credId, await this.coseKey());
  }

  private clientData(type: string, o: Opts, challenge: string): Uint8Array {
    return enc.encode(JSON.stringify({ type: o.type ?? type, challenge: o.challenge ?? challenge, origin: o.origin ?? ORIGIN, crossOrigin: false }));
  }

  async attest(options: Record<string, any>, o: Opts = {}): Promise<PasskeyAttestationJSON> {
    const authData = await this.authData(o.rpId ?? options.rp.id, o, true);
    const attestationObject = cbor(new Map<string, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: toBase64Url(this.credId), rawId: toBase64Url(this.credId), type: 'public-key',
      response: { clientDataJSON: toBase64Url(this.clientData('webauthn.create', o, options.challenge)), attestationObject: toBase64Url(attestationObject), transports: ['internal'] },
    };
  }

  async assert(options: Record<string, any>, userId: string, o: Opts = {}): Promise<PasskeyAssertionJSON> {
    if (o.count === undefined) this.signCount++;
    const authData = await this.authData(o.rpId ?? options.rpId, o, false);
    const cd = this.clientData('webauthn.get', o, options.challenge);
    const signed = concat(authData, await sha256(cd));
    let sig: Uint8Array;
    if (this.alg === 'ES256') sig = rawToDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.pair.privateKey, signed)));
    else if (this.alg === 'RS256') sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', this.pair.privateKey, signed));
    else sig = new Uint8Array(await crypto.subtle.sign('Ed25519', this.pair.privateKey, signed));
    if (o.badSig) sig = Uint8Array.from(sig, (x, i) => (i === sig.length - 1 ? x ^ 1 : x));
    return {
      id: toBase64Url(this.credId), rawId: toBase64Url(this.credId), type: 'public-key',
      response: {
        clientDataJSON: toBase64Url(cd), authenticatorData: toBase64Url(authData), signature: toBase64Url(sig),
        userHandle: o.userHandle === undefined ? toBase64Url(enc.encode(userId)) : o.userHandle,
      },
    };
  }
}

// ---------- fixtures and flows ----------

interface TestUser { id: string; email: string; cookie: string }

async function mkUser(prefix: string, opts: { totp?: boolean } = {}): Promise<TestUser> {
  const id = ulid();
  const email = `${prefix}-${id.slice(-6).toLowerCase()}@pk.test`;
  const now = Date.now();
  await env.DB.prepare('INSERT INTO users (id, email, name, password_hash, role, must_change_password, totp_secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)')
    .bind(id, email, prefix, await hashPassword(PASSWORD), 'member', opts.totp ? 'JBSWY3DPEHPK3PXP' : null, now, now).run();
  const res = await call('/api/auth/login', { body: { email, password: PASSWORD, ...(opts.totp ? { totp: '000000' } : {}) }, headers: ip() });
  // With TOTP the password login stops at the code, so open a session directly for the management calls.
  if (opts.totp) {
    const token = toBase64Url(randomBytes(32));
    const digest = Array.from(new Uint8Array(await sha256(token)), (b) => b.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare('INSERT INTO sessions (id, token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(ulid(), digest, id, now, now, now + 3600_000).run();
    return { id, email, cookie: `cirrus_session=${token}` };
  }
  return { id, email, cookie: sessionCookie(res) };
}

let ipN = 0;
const ip = (): Record<string, string> => ({ 'cf-connecting-ip': `10.9.${Math.floor(++ipN / 250)}.${ipN % 250}` });

async function regOptions(u: TestUser, password = PASSWORD) {
  return call('/api/me/passkeys/options', { body: { password }, cookie: u.cookie });
}

async function addPasskey(u: TestUser, auth?: SoftAuthenticator, name?: string, o: Opts = {}) {
  const a = auth ?? (await SoftAuthenticator.make());
  const { options } = await (await regOptions(u)).json() as { options: Record<string, unknown> };
  const res = await call('/api/me/passkeys', { body: { credential: await a.attest(options, o), name }, cookie: u.cookie });
  return { res, auth: a, options };
}

async function loginOptions(mfa = false) {
  const res = await call('/api/auth/passkey/options', { body: { mfa }, headers: ip() });
  expect(res.status).toBe(200);
  return (await res.json() as { options: Record<string, unknown> }).options;
}

async function passkeyLogin(credential: PasskeyAssertionJSON, headers = ip()) {
  return call('/api/auth/passkey/login', { body: { credential }, headers });
}

async function passkeyCount(userId: string) {
  return (await env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').bind(userId).first<number>('n'))!;
}

let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  alice = await mkUser('alice');
  bob = await mkUser('bob');
});

describe('registration', () => {
  it('registers a passkey and lists it', async () => {
    const { res } = await addPasskey(alice, undefined, 'Laptop');
    expect(res.status).toBe(201);
    const list = await (await call('/api/me/passkeys', { cookie: alice.cookie })).json() as { id: string; name: string; createdAt: number; lastUsedAt: number | null }[];
    expect(list.map((p) => p.name)).toContain('Laptop');
    expect(list[0].lastUsedAt).toBeNull();
    expect(JSON.stringify(list)).not.toContain('public');
  });

  it('asks for discoverable credentials, attestation none and the allowed algorithms', async () => {
    const { options } = await addPasskey(alice);
    const o = options as Record<string, any>;
    expect(o.rp.id).toBe('localhost');
    expect(o.attestation).toBe('none');
    expect(o.authenticatorSelection.residentKey).toBe('required');
    expect(o.pubKeyCredParams.map((p: any) => p.alg)).toEqual([-7, -8, -257]);
    expect(fromBase64Url(o.challenge as string).length).toBe(32);
  });

  it('requires the current password to get a challenge', async () => {
    const before = await passkeyCount(alice.id);
    expect((await regOptions(alice, 'wrong-password-123')).status).toBe(400);
    expect((await call('/api/me/passkeys/options', { body: {}, cookie: alice.cookie })).status).toBe(400);
    expect((await call('/api/me/passkeys/options', { body: { password: PASSWORD } })).status).toBe(401);
    expect(await passkeyCount(alice.id)).toBe(before);
  });

  it('rate-limits password attempts when adding', async () => {
    const u = await mkUser('limited');
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await regOptions(u, 'nope-nope-nope')).status;
    expect(last).toBe(429);
  });

  it('rejects a replayed registration challenge', async () => {
    const a = await SoftAuthenticator.make();
    const { options } = await (await regOptions(alice)).json() as { options: Record<string, unknown> };
    const cred = await a.attest(options);
    expect((await call('/api/me/passkeys', { body: { credential: cred }, cookie: alice.cookie })).status).toBe(201);
    const b = await SoftAuthenticator.make();
    const again = await b.attest(options);
    expect((await call('/api/me/passkeys', { body: { credential: again }, cookie: alice.cookie })).status).toBe(400);
  });

  it('binds the registration challenge to its user', async () => {
    const { options } = await (await regOptions(alice)).json() as { options: Record<string, unknown> };
    const a = await SoftAuthenticator.make();
    const res = await call('/api/me/passkeys', { body: { credential: await a.attest(options) }, cookie: bob.cookie });
    expect(res.status).toBe(400);
    expect(await passkeyCount(bob.id)).toBe(0);
  });

  it('rejects a login challenge used for registration, and a made-up one', async () => {
    const a = await SoftAuthenticator.make();
    const loginOpts = await loginOptions();
    const { options } = await (await regOptions(alice)).json() as { options: Record<string, any> };
    expect((await call('/api/me/passkeys', { body: { credential: await a.attest({ ...options, challenge: loginOpts.challenge }) }, cookie: alice.cookie })).status).toBe(400);
    const fake = toBase64Url(randomBytes(32));
    expect((await call('/api/me/passkeys', { body: { credential: await a.attest({ ...options, challenge: fake }) }, cookie: alice.cookie })).status).toBe(400);
  });

  it('rejects a wrong origin and a wrong rpId', async () => {
    for (const o of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }, { type: 'webauthn.get' }, { up: false }]) {
      const { res } = await addPasskey(bob, undefined, undefined, o);
      expect(res.status, JSON.stringify(o)).toBe(400);
    }
    expect(await passkeyCount(bob.id)).toBe(0);
  });

  it('rejects an expired challenge', async () => {
    const { options } = await (await regOptions(alice)).json() as { options: Record<string, any> };
    await env.DB.prepare('UPDATE webauthn_challenges SET expires_at = ? WHERE challenge = ?').bind(Date.now() - 1, options.challenge).run();
    const a = await SoftAuthenticator.make();
    expect((await call('/api/me/passkeys', { body: { credential: await a.attest(options) }, cookie: alice.cookie })).status).toBe(400);
  });

  it('rejects registering the same credential twice', async () => {
    const a = await SoftAuthenticator.make();
    expect((await addPasskey(alice, a)).res.status).toBe(201);
    expect((await addPasskey(bob, a)).res.status).toBe(409);
  });

  it('renames a passkey, but not someone else\'s', async () => {
    const u = await mkUser('rename');
    const { res } = await addPasskey(u, undefined, 'Old');
    const { id } = await res.json() as { id: string };
    expect((await call(`/api/me/passkeys/${id}`, { method: 'PATCH', body: { name: 'New' }, cookie: u.cookie })).status).toBe(200);
    expect((await env.DB.prepare('SELECT name FROM passkeys WHERE id = ?').bind(id).first<string>('name'))).toBe('New');
    expect((await call(`/api/me/passkeys/${id}`, { method: 'PATCH', body: { name: 'Hacked' }, cookie: bob.cookie })).status).toBe(404);
  });
});

describe('deleting', () => {
  it('needs the current password', async () => {
    const u = await mkUser('del');
    const { res } = await addPasskey(u);
    const { id } = await res.json() as { id: string };
    expect((await call(`/api/me/passkeys/${id}`, { method: 'DELETE', body: { password: 'wrong-password-123' }, cookie: u.cookie })).status).toBe(400);
    expect((await call(`/api/me/passkeys/${id}`, { method: 'DELETE', body: {}, cookie: u.cookie })).status).toBe(400);
    expect(await passkeyCount(u.id)).toBe(1);
    expect((await call(`/api/me/passkeys/${id}`, { method: 'DELETE', body: { password: PASSWORD }, cookie: u.cookie })).status).toBe(200);
    expect(await passkeyCount(u.id)).toBe(0);
  });

  it('will not delete another user\'s passkey', async () => {
    const owner = await mkUser('owner');
    const { res } = await addPasskey(owner);
    const { id } = await res.json() as { id: string };
    const r = await call(`/api/me/passkeys/${id}`, { method: 'DELETE', body: { password: PASSWORD }, cookie: bob.cookie });
    expect(r.status).toBe(404);
    expect(await passkeyCount(owner.id)).toBe(1);
  });

  it('cascades when the user is deleted', async () => {
    const u = await mkUser('gone');
    await addPasskey(u);
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(u.id).run();
    expect(await passkeyCount(u.id)).toBe(0);
  });
});

describe('passwordless sign-in', () => {
  it('signs in with a passkey and creates a normal session', async () => {
    const u = await mkUser('pwless');
    const { auth } = await addPasskey(u);
    const res = await passkeyLogin(await auth.assert(await loginOptions(), u.id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { email: string } }).user.email).toBe(u.email);
    const me = await call('/api/me', { cookie: sessionCookie(res) });
    expect(me.status).toBe(200);
    const row = await env.DB.prepare('SELECT sign_count, last_used_at FROM passkeys WHERE user_id = ?').bind(u.id).first<{ sign_count: number; last_used_at: number }>();
    expect(row!.sign_count).toBe(1);
    expect(row!.last_used_at).toBeGreaterThan(0);
  });

  it('works with RS256 and Ed25519 keys', async () => {
    for (const alg of ['RS256', 'EdDSA'] as const) {
      const u = await mkUser(alg.toLowerCase());
      const { res, auth } = await addPasskey(u, await SoftAuthenticator.make(alg));
      expect(res.status, alg).toBe(201);
      expect((await passkeyLogin(await auth.assert(await loginOptions(), u.id))).status, alg).toBe(200);
    }
  });

  it('accepts authenticators whose counter stays at zero', async () => {
    const u = await mkUser('zero');
    const { auth } = await addPasskey(u);
    for (let i = 0; i < 2; i++) expect((await passkeyLogin(await auth.assert(await loginOptions(), u.id, { count: 0 }))).status).toBe(200);
  });

  it('rejects a replayed challenge', async () => {
    const u = await mkUser('replay');
    const { auth } = await addPasskey(u);
    const options = await loginOptions();
    expect((await passkeyLogin(await auth.assert(options, u.id))).status).toBe(200);
    expect((await passkeyLogin(await auth.assert(options, u.id))).status).toBe(401);
  });

  it('rejects an unknown, expired or login-bound-to-register challenge', async () => {
    const u = await mkUser('chal');
    const { auth } = await addPasskey(u);
    expect((await passkeyLogin(await auth.assert({ challenge: toBase64Url(randomBytes(32)), rpId: 'localhost' }, u.id))).status).toBe(401);
    const options = await loginOptions();
    await env.DB.prepare('UPDATE webauthn_challenges SET expires_at = ? WHERE challenge = ?').bind(Date.now() - 1, options.challenge).run();
    expect((await passkeyLogin(await auth.assert(options, u.id))).status).toBe(401);
    const { options: reg } = await (await regOptions(u)).json() as { options: Record<string, any> };
    expect((await passkeyLogin(await auth.assert({ ...reg, rpId: 'localhost' }, u.id))).status).toBe(401);
  });

  it('rejects a wrong origin, a wrong rpId and a wrong type', async () => {
    const u = await mkUser('origin');
    const { auth } = await addPasskey(u);
    for (const o of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }, { type: 'webauthn.create' }, { up: false }]) {
      expect((await passkeyLogin(await auth.assert(await loginOptions(), u.id, o))).status, JSON.stringify(o)).toBe(401);
    }
    expect((await passkeyLogin(await auth.assert(await loginOptions(), u.id))).status).toBe(200);
  });

  it('ignores a spoofed Origin or Host header', async () => {
    const u = await mkUser('spoof');
    const { auth } = await addPasskey(u);
    const cred = await auth.assert(await loginOptions(), u.id, { origin: 'https://evil.example', rpId: 'evil.example' });
    const res = await passkeyLogin(cred, { ...ip(), origin: 'https://evil.example', host: 'evil.example' });
    expect(res.status).toBe(401);
  });

  it('rejects a bad signature', async () => {
    const u = await mkUser('sig');
    const { auth } = await addPasskey(u);
    expect((await passkeyLogin(await auth.assert(await loginOptions(), u.id, { badSig: true }))).status).toBe(401);
  });

  it('rejects a signature from a different key for the same credential id', async () => {
    const u = await mkUser('otherkey');
    const { auth } = await addPasskey(u);
    const impostor = await SoftAuthenticator.make();
    impostor.credId = auth.credId;
    expect((await passkeyLogin(await impostor.assert(await loginOptions(), u.id))).status).toBe(401);
  });

  it('rejects a sign count that does not increase, and does not move the stored count', async () => {
    const u = await mkUser('count');
    const { auth } = await addPasskey(u);
    expect((await passkeyLogin(await auth.assert(await loginOptions(), u.id, { count: 5 }))).status).toBe(200);
    expect((await passkeyLogin(await auth.assert(await loginOptions(), u.id, { count: 3 }))).status).toBe(401);
    expect((await passkeyLogin(await auth.assert(await loginOptions(), u.id, { count: 5 }))).status).toBe(401);
    expect(await env.DB.prepare('SELECT sign_count FROM passkeys WHERE user_id = ?').bind(u.id).first<number>('sign_count')).toBe(5);
    expect((await passkeyLogin(await auth.assert(await loginOptions(), u.id, { count: 6 }))).status).toBe(200);
  });

  it('requires user verification', async () => {
    const u = await mkUser('uv');
    const { auth } = await addPasskey(u);
    expect((await passkeyLogin(await auth.assert(await loginOptions(), u.id, { uv: false }))).status).toBe(401);
    const options = await loginOptions();
    expect(options.userVerification).toBe('required');
  });

  it('rejects a user handle that is not the credential owner', async () => {
    const u = await mkUser('handle');
    const { auth } = await addPasskey(u);
    expect((await passkeyLogin(await auth.assert(await loginOptions(), bob.id))).status).toBe(401);
  });

  it('answers an unknown credential like any other failure', async () => {
    const stranger = await SoftAuthenticator.make();
    const res = await passkeyLogin(await stranger.assert(await loginOptions(), bob.id));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIALS');
  });

  it('blocks a disabled user, and works again once enabled', async () => {
    const u = await mkUser('off');
    const { auth } = await addPasskey(u);
    await env.DB.prepare('UPDATE users SET disabled = 1 WHERE id = ?').bind(u.id).run();
    const res = await passkeyLogin(await auth.assert(await loginOptions(), u.id));
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
    await env.DB.prepare('UPDATE users SET disabled = 0 WHERE id = ?').bind(u.id).run();
    expect((await passkeyLogin(await auth.assert(await loginOptions(), u.id))).status).toBe(200);
  });

  it('survives an admin password reset', async () => {
    const u = await mkUser('reset');
    const { auth } = await addPasskey(u);
    await env.DB.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').bind(await hashPassword('another-password-1'), u.id).run();
    expect((await passkeyLogin(await auth.assert(await loginOptions(), u.id))).status).toBe(200);
  });

  it('rate-limits failures per IP', async () => {
    const u = await mkUser('ratelimit');
    const { auth } = await addPasskey(u);
    const headers = ip();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await passkeyLogin(await auth.assert(await loginOptions(), u.id, { badSig: true }), headers)).status;
    expect(last).toBe(429);
    expect((await passkeyLogin(await auth.assert(await loginOptions(), u.id), headers)).status).toBe(429);
  });

  it('rate-limits challenge requests per IP', async () => {
    const headers = ip();
    let last = 0;
    for (let i = 0; i < 32; i++) last = (await call('/api/auth/passkey/options', { body: {}, headers })).status;
    expect(last).toBe(429);
  });
});

describe('second factor', () => {
  it('lets a passkey stand in for the TOTP code after the password', async () => {
    const u = await mkUser('mfa', { totp: true });
    const { res, auth } = await addPasskey(u);
    expect(res.status).toBe(201);
    const headers = ip();
    // Without the second factor the password alone is not enough.
    const need = await call('/api/auth/login', { body: { email: u.email, password: PASSWORD }, headers });
    expect(need.status).toBe(401);
    expect(((await need.json()) as { error: { code: string } }).error.code).toBe('TOTP_REQUIRED');
    const options = await loginOptions(true);
    expect(options.userVerification).toBe('preferred');
    const ok = await call('/api/auth/login', { body: { email: u.email, password: PASSWORD, passkey: await auth.assert(options, u.id, { uv: false }) }, headers });
    expect(ok.status).toBe(200);
    expect((await call('/api/me', { cookie: sessionCookie(ok) })).status).toBe(200);
  });

  it('still needs the right password', async () => {
    const u = await mkUser('mfapw', { totp: true });
    const { auth } = await addPasskey(u);
    const res = await call('/api/auth/login', { body: { email: u.email, password: 'wrong-password-123', passkey: await auth.assert(await loginOptions(true), u.id) }, headers: ip() });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rejects another user\'s passkey, a replay and a bad signature', async () => {
    const u = await mkUser('mfaown', { totp: true });
    await addPasskey(u);
    const other = await mkUser('mfaother');
    const { auth: otherAuth } = await addPasskey(other);
    const headers = ip();
    const login = async (passkey: PasskeyAssertionJSON) => (await call('/api/auth/login', { body: { email: u.email, password: PASSWORD, passkey }, headers })).status;
    expect(await login(await otherAuth.assert(await loginOptions(true), other.id))).toBe(401);
    const { auth } = await addPasskey(u);
    expect(await login(await auth.assert(await loginOptions(true), u.id, { badSig: true }))).toBe(401);
    const options = await loginOptions(true);
    const cred = await auth.assert(options, u.id, { count: 50 });
    expect(await login(cred)).toBe(200);
    expect(await login(cred)).toBe(401);
  });

  it('skips TOTP for a passwordless sign-in with user verification', async () => {
    const u = await mkUser('mfaskip', { totp: true });
    const { auth } = await addPasskey(u);
    expect((await passkeyLogin(await auth.assert(await loginOptions(), u.id))).status).toBe(200);
  });

  it('rejects a disabled user on the second-factor path', async () => {
    const u = await mkUser('mfaoff', { totp: true });
    const { auth } = await addPasskey(u);
    await env.DB.prepare('UPDATE users SET disabled = 1 WHERE id = ?').bind(u.id).run();
    const res = await call('/api/auth/login', { body: { email: u.email, password: PASSWORD, passkey: await auth.assert(await loginOptions(true), u.id) }, headers: ip() });
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('password change', () => {
  const addAppPassword = (userId: string) =>
    env.DB.prepare('INSERT INTO app_passwords (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind(ulid(), userId, 'dav', ulid(), Date.now()).run();
  const appPasswordCount = async (userId: string) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM app_passwords WHERE user_id = ?').bind(userId).first<number>('n'))!;

  it('removes passkeys and app passwords by default, and when asked to', async () => {
    for (const body of [{}, { revokeCredentials: true }]) {
      const u = await mkUser('pwdrevoke');
      await addPasskey(u);
      await addAppPassword(u.id);
      const res = await call('/api/me/password', { body: { current: PASSWORD, next: 'brand-new-password-1', ...body }, cookie: u.cookie });
      expect(res.status).toBe(200);
      expect(await passkeyCount(u.id)).toBe(0);
      expect(await appPasswordCount(u.id)).toBe(0);
    }
  });

  it('keeps them with revokeCredentials: false, and never touches another user', async () => {
    const u = await mkUser('pwdkeep');
    const v = await mkUser('pwdother');
    await addPasskey(u);
    await addAppPassword(u.id);
    await addPasskey(v);
    const res = await call('/api/me/password', { body: { current: PASSWORD, next: 'brand-new-password-1', revokeCredentials: false }, cookie: u.cookie });
    expect(res.status).toBe(200);
    expect(await passkeyCount(u.id)).toBe(1);
    expect(await appPasswordCount(u.id)).toBe(1);
    expect((await call('/api/me/password', { body: { current: 'brand-new-password-1', next: 'brand-new-password-2' }, cookie: u.cookie })).status).toBe(200);
    expect(await passkeyCount(v.id)).toBe(1);
  });
});
