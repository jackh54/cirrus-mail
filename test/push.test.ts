import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PushDevice, PushPayload, PushPublicKeyResponse } from '../src/shared/api';
import { ulid } from '../src/shared/ulid';
import { processInbound } from '../src/worker/inbound/handler';
import { hit } from '../src/worker/lib/ratelimit';
import { fromBase64Url, hmac, randomBytes, sha256Hex, toBase64Url } from '../src/worker/lib/crypto';
import { encryptPayload, generateVapidKeys, importVapidPrivateKey, isAllowedPushEndpoint, vapidAuthorization, vapidJwt } from '../src/worker/lib/webpush';
import { getVapid, notifyNewMail, PUSH_HOURLY_CAP } from '../src/worker/push';
import { buildEml, call, createMailbox, fakeEmail, randomLocal } from './helpers';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- helpers ----------

async function createUser(role: 'admin' | 'member' = 'member', pushPreview = 1): Promise<{ id: string; email: string; cookie: string }> {
  const id = ulid();
  const email = `${randomLocal('push')}@push.test`;
  const now = Date.now();
  const token = toBase64Url(randomBytes(32));
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, email, name, password_hash, role, push_preview, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, email, 'Push User', 'x', role, pushPreview, now, now),
    env.DB.prepare('INSERT INTO sessions (id, token_hash, user_id, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, NULL, ?, ?, ?)')
      .bind(ulid(), await sha256Hex(token), id, now, now, now + 86_400_000),
  ]);
  return { id, email, cookie: `cirrus_session=${token}` };
}

/** A browser-side subscription: a real ECDH key pair, so tests can decrypt what the server sends. */
async function browserKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer);
  const auth = randomBytes(16);
  return { pair, p256dh: toBase64Url(pub), auth: toBase64Url(auth), pub, authBytes: auth };
}

type BrowserKeys = Awaited<ReturnType<typeof browserKeys>>;

async function addSubscription(userId: string, keys: BrowserKeys, endpoint = `https://fcm.googleapis.com/fcm/send/${ulid()}`): Promise<{ id: string; endpoint: string }> {
  const id = ulid();
  await env.DB.prepare('INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)')
    .bind(id, userId, endpoint, keys.p256dh, keys.auth, Date.now()).run();
  return { id, endpoint };
}

/** Receiver side of RFC 8291, written independently of encryptPayload. */
async function decrypt(body: Uint8Array, keys: BrowserKeys): Promise<string> {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const alg: SubtleCryptoDeriveKeyAlgorithm & { public: CryptoKey } = { name: 'ECDH', public: asKey };
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits(alg, keys.pair.privateKey, 256));
  const join = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
  const one = new Uint8Array([1]);
  const prkKey = await hmac(keys.authBytes, ecdh);
  const ikm = await hmac(prkKey, join(enc.encode('WebPush: info\0'), keys.pub, asPublic, one));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, join(enc.encode('Content-Encoding: aes128gcm\0'), one))).slice(0, 16);
  const nonce = (await hmac(prk, join(enc.encode('Content-Encoding: nonce\0'), one))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  expect(pt[pt.length - 1]).toBe(2);
  return dec.decode(pt.slice(0, -1));
}

interface Sent { url: string; headers: Headers; body: Uint8Array }

/** Replaces global fetch: records each push and answers with `status(url)` (or throws). */
function stubFetch(status: (url: string) => number | Error = () => 201): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, headers: new Headers(init?.headers), body: new Uint8Array(init?.body as Uint8Array) });
    const s = status(url);
    if (s instanceof Error) throw s;
    return new Response(null, { status: s });
  });
  return sent;
}

function testCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.all(pending) };
}

async function deliverMail(to: string, opts: Partial<Parameters<typeof buildEml>[0]> = {}, from = 'Priya Natarajan <priya@partner.test>') {
  const { ctx, settle } = testCtx();
  const msg = fakeEmail(from.replace(/.*</, '').replace(/>.*/, ''), to, buildEml({ from, to, subject: 'Quarterly numbers', body: 'hello', ...opts }));
  const out = await processInbound(msg, env, ctx);
  await settle();
  return { msg, out };
}

let admin: { id: string; email: string; cookie: string };

beforeAll(async () => {
  admin = await createUser('admin');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------- crypto ----------

describe('RFC 8291 encryption', () => {
  it('reproduces the §5 example ciphertext exactly', async () => {
    const asPublic = fromBase64Url('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
    const jwk: JsonWebKey = {
      kty: 'EC', crv: 'P-256', d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
      x: toBase64Url(asPublic.slice(1, 33)), y: toBase64Url(asPublic.slice(33, 65)),
    };
    const ephemeral: CryptoKeyPair = {
      privateKey: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
      publicKey: await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
    };
    const out = await encryptPayload(
      enc.encode('When I grow up, I want to be a watermelon'),
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      'BTBZMqHH6r4Tts7J_aSIgg',
      { ephemeral, salt: fromBase64Url('DGv6ra1nlYgDCS1FRnbzlw') },
    );
    expect(toBase64Url(out)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
      'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
      'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
    // 86-byte header + 41 plaintext + 1 delimiter + 16 tag. (The example's "Content-Length: 145" is off by one.)
    expect(out.byteLength).toBe(144);
  });

  it('round-trips with random keys and salt', async () => {
    const keys = await browserKeys();
    const a = await encryptPayload(enc.encode('{"hi":1}'), keys.p256dh, keys.auth);
    const b = await encryptPayload(enc.encode('{"hi":1}'), keys.p256dh, keys.auth);
    expect(toBase64Url(a)).not.toBe(toBase64Url(b));
    expect(await decrypt(a, keys)).toBe('{"hi":1}');
  });
});

describe('VAPID', () => {
  it('signs an ES256 JWT that verifies with WebCrypto', async () => {
    const gen = await generateVapidKeys();
    const priv = await importVapidPrivateKey(gen.privateJwk);
    const now = Date.now();
    const jwt = await vapidJwt('https://fcm.googleapis.com/fcm/send/abc', 'mailto:admin@push.test', priv, now);
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(dec.decode(fromBase64Url(h)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(dec.decode(fromBase64Url(p))) as { aud: string; exp: number; sub: string };
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toBe('mailto:admin@push.test');
    expect(claims.exp).toBeGreaterThan(now / 1000);
    expect(claims.exp).toBeLessThanOrEqual(now / 1000 + 24 * 3600);
    const sig = fromBase64Url(s);
    expect(sig.byteLength).toBe(64); // raw r||s, not DER
    const pub = await crypto.subtle.importKey('raw', fromBase64Url(gen.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, enc.encode(`${h}.${p}`))).toBe(true);
    const header = await vapidAuthorization('https://web.push.apple.com/x', 'mailto:a@b.test', { publicKey: gen.publicKey, privateKey: priv });
    expect(header).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${gen.publicKey}$`));
  });

  it('generates keys once, races safely, and uses the first admin as the subject', async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'vapid_%'").run();
    const all = await Promise.all([getVapid(env.DB, 'https://mail.push.test'), getVapid(env.DB), getVapid(env.DB)]);
    expect(new Set(all.map((v) => v.keys.publicKey)).size).toBe(1);
    expect(fromBase64Url(all[0].keys.publicKey).byteLength).toBe(65);
    const rows = await env.DB.prepare("SELECT key FROM settings WHERE key LIKE 'vapid_%' ORDER BY key").all<{ key: string }>();
    expect(rows.results.map((r) => r.key)).toEqual(['vapid_origin', 'vapid_private_jwk', 'vapid_public']);
    expect(all[0].subject).toBe(`mailto:${admin.email}`);
    const res = await call('/api/push/public-key', { cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect(await res.json<PushPublicKeyResponse>()).toEqual({ publicKey: all[0].keys.publicKey });
  });
});

describe('endpoint allowlist', () => {
  it('accepts only https endpoints on known push services', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc', 'https://web.push.apple.com/QGx', 'https://api.push.apple.com/x',
      'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://foo.push.services.mozilla.com/x',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) expect(isAllowedPushEndpoint(ok), ok).toBe(true);
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/abc', 'https://fcm.googleapis.com:8443/x', 'https://user:pw@fcm.googleapis.com/x',
      'https://evil.test/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.test/x', 'https://push.apple.com.evil.test/x',
      'https://evilpush.apple.com/x', 'https://notify.windows.com/x', 'https://127.0.0.1/x', 'https://localhost/x',
      'https://169.254.169.254/latest', 'file:///etc/passwd', 'not a url', `https://fcm.googleapis.com/${'a'.repeat(2100)}`,
    ]) expect(isAllowedPushEndpoint(bad), bad).toBe(false);
  });

  it('the API rejects other endpoints and malformed keys', async () => {
    const keys = await browserKeys();
    const u = await createUser();
    const bad = await call('/api/push/subscriptions', { cookie: u.cookie, body: { endpoint: 'https://attacker.test/hook', keys: { p256dh: keys.p256dh, auth: keys.auth } } });
    expect(bad.status).toBe(400);
    const badKey = await call('/api/push/subscriptions', { cookie: u.cookie, body: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'AAAA', auth: keys.auth } } });
    expect(badKey.status).toBe(400);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').bind(u.id).first<number>('n'))).toBe(0);
  });
});

// ---------- API ----------

describe('push API', () => {
  it('needs a session and the CSRF header', async () => {
    expect((await call('/api/push/subscriptions')).status).toBe(401);
    const u = await createUser();
    const keys = await browserKeys();
    const body = { endpoint: `https://fcm.googleapis.com/fcm/send/${ulid()}`, expirationTime: null, keys: { p256dh: keys.p256dh, auth: keys.auth } };
    expect((await call('/api/push/subscriptions', { cookie: u.cookie, body, csrf: false })).status).toBe(403);
    expect((await call('/api/push/test', { cookie: u.cookie, csrf: false, method: 'POST' })).status).toBe(403);
  });

  it('upserts by endpoint, lists own devices and toggles pushPreview', async () => {
    const u = await createUser();
    const keys = await browserKeys();
    const endpoint = `https://fcm.googleapis.com/fcm/send/${ulid()}`;
    const body = { endpoint, expirationTime: null, keys: { p256dh: keys.p256dh, auth: keys.auth } };
    const first = await call('/api/push/subscriptions', { cookie: u.cookie, body, headers: { 'user-agent': 'TestBrowser/1' } });
    expect(first.status).toBe(201);
    const again = await call('/api/push/subscriptions', { cookie: u.cookie, body });
    expect((await again.json<PushDevice>()).id).toBe((await first.json<PushDevice>()).id);
    const list = await (await call('/api/push/subscriptions', { cookie: u.cookie })).json<PushDevice[]>();
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]).sort()).toEqual(['createdAt', 'id', 'lastSuccessAt', 'userAgent']);

    const me = await call('/api/me', { method: 'PATCH', cookie: u.cookie, body: { pushPreview: false } });
    expect((await me.json<{ user: { pushPreview: boolean } }>()).user.pushPreview).toBe(false);
    expect(await env.DB.prepare('SELECT push_preview FROM users WHERE id = ?').bind(u.id).first<number>('push_preview')).toBe(0);

    expect((await call('/api/push/subscriptions', { method: 'DELETE', cookie: u.cookie, body: { endpoint } })).status).toBe(200);
    expect(await (await call('/api/push/subscriptions', { cookie: u.cookie })).json()).toEqual([]);
  });

  it('IDOR: another user cannot list, delete by id or delete by endpoint', async () => {
    const alice = await createUser();
    const mallory = await createUser();
    const sub = await addSubscription(alice.id, await browserKeys());
    expect(await (await call('/api/push/subscriptions', { cookie: mallory.cookie })).json()).toEqual([]);
    expect((await call(`/api/push/subscriptions/${sub.id}`, { method: 'DELETE', cookie: mallory.cookie })).status).toBe(404);
    await call('/api/push/subscriptions', { method: 'DELETE', cookie: mallory.cookie, body: { endpoint: sub.endpoint } });
    expect(await env.DB.prepare('SELECT user_id FROM push_subscriptions WHERE id = ?').bind(sub.id).first<string>('user_id')).toBe(alice.id);
    expect((await call(`/api/push/subscriptions/${sub.id}`, { method: 'DELETE', cookie: alice.cookie })).status).toBe(200);
    expect(await env.DB.prepare('SELECT 1 FROM push_subscriptions WHERE id = ?').bind(sub.id).first()).toBeNull();
  });

  it('sends a test notification only to your own devices', async () => {
    const u = await createUser();
    const other = await createUser();
    const keys = await browserKeys();
    const mine = await addSubscription(u.id, keys);
    const theirs = await addSubscription(other.id, await browserKeys());
    const sent = stubFetch();
    const res = await call('/api/push/test', { method: 'POST', cookie: u.cookie });
    expect(await res.json()).toEqual({ sent: 1, failed: 0 });
    expect(sent.map((s) => s.url)).toEqual([mine.endpoint]);
    expect(sent.map((s) => s.url)).not.toContain(theirs.endpoint);
    const payload = JSON.parse(await decrypt(sent[0].body, keys)) as PushPayload;
    expect(payload.type).toBe('test');
    expect(await env.DB.prepare('SELECT last_success_at FROM push_subscriptions WHERE id = ?').bind(mine.id).first<number>('last_success_at')).toBeGreaterThan(0);
  });
});

// ---------- inbound trigger ----------

describe('new-mail push', () => {
  it('pushes an Inbox message to every member with the right headers and a preview payload', async () => {
    const owner = await createUser();
    const member = await createUser();
    const addr = `${randomLocal('box')}@push.test`;
    const mb = await createMailbox(addr, [{ userId: owner.id }, { userId: member.id, role: 'member' }]);
    const k1 = await browserKeys();
    const k2 = await browserKeys();
    const s1 = await addSubscription(owner.id, k1);
    const s2 = await addSubscription(member.id, k2);
    const sent = stubFetch();
    const { out } = await deliverMail(addr);
    expect(out.accepted).toBe(true);
    if (!out.accepted) return;
    expect(sent.map((s) => s.url).sort()).toEqual([s1.endpoint, s2.endpoint].sort());
    const req = sent.find((s) => s.url === s1.endpoint)!;
    expect(req.headers.get('ttl')).toBe('86400');
    expect(req.headers.get('urgency')).toBe('normal');
    expect(req.headers.get('content-encoding')).toBe('aes128gcm');
    expect(req.headers.get('authorization')).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
    expect(req.body.byteLength).toBeLessThan(3 * 1024);
    const payload = JSON.parse(await decrypt(req.body, k1)) as PushPayload;
    expect(payload).toEqual({ type: 'mail', mailboxId: mb.id, threadId: out.threadId, title: 'Priya Natarajan', body: 'Quarterly numbers', tag: out.threadId });
  });

  it('hides sender and subject when push_preview is off', async () => {
    const u = await createUser('member', 0);
    const addr = `${randomLocal('box')}@push.test`;
    await createMailbox(addr, [{ userId: u.id }]);
    const keys = await browserKeys();
    await addSubscription(u.id, keys);
    const sent = stubFetch();
    await deliverMail(addr, { subject: 'Secret merger plans' });
    expect(sent).toHaveLength(1);
    const payload = JSON.parse(await decrypt(sent[0].body, keys)) as PushPayload;
    expect(payload.title).toBe('New mail');
    expect(payload.body).toBe(addr);
    expect(JSON.stringify(payload)).not.toContain('Secret');
    expect(JSON.stringify(payload)).not.toContain('Priya');
  });

  it('only fires for unread Inbox mail: not spam, trash or filtered to read', async () => {
    const u = await createUser();
    const addr = `${randomLocal('box')}@push.test`;
    const mb = await createMailbox(addr, [{ userId: u.id }]);
    await addSubscription(u.id, await browserKeys());
    await env.DB.batch([
      env.DB.prepare('INSERT INTO blocked_senders (id, mailbox_id, pattern, created_at) VALUES (?, ?, ?, ?)').bind(ulid(), mb.id, '@blocked.test', Date.now()),
      env.DB.prepare('INSERT INTO filters (id, mailbox_id, name, match, conditions, actions, enabled, sort, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)')
        .bind(ulid(), mb.id, 'read', 'all', JSON.stringify([{ field: 'subject', op: 'contains', value: 'newsletter' }]), JSON.stringify([{ type: 'mark_read' }]), Date.now(), u.id),
      env.DB.prepare('INSERT INTO filters (id, mailbox_id, name, match, conditions, actions, enabled, sort, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, 1, 2, ?, ?)')
        .bind(ulid(), mb.id, 'trash', 'all', JSON.stringify([{ field: 'subject', op: 'contains', value: 'junkmail' }]), JSON.stringify([{ type: 'delete' }]), Date.now(), u.id),
    ]);
    const sent = stubFetch();
    const spam = await deliverMail(addr, { subject: 'Buy now' }, 'Spammer <x@blocked.test>');
    expect(spam.out.accepted && spam.out.folderId).toBe(mb.folders.spam);
    const read = await deliverMail(addr, { subject: 'The weekly newsletter' });
    expect(read.out.accepted && read.out.folderId).toBe(mb.folders.inbox);
    const trash = await deliverMail(addr, { subject: 'junkmail offer' });
    expect(trash.out.accepted && trash.out.folderId).toBe(mb.folders.trash);
    expect(sent).toHaveLength(0);
    await deliverMail(addr, { subject: 'A real message' });
    expect(sent).toHaveLength(1);
  });

  it('deletes subscriptions on 404/410 and after 5 other failures', async () => {
    const u = await createUser();
    const addr = `${randomLocal('box')}@push.test`;
    await createMailbox(addr, [{ userId: u.id }]);
    const gone = await addSubscription(u.id, await browserKeys());
    const flaky = await addSubscription(u.id, await browserKeys());
    const ok = await addSubscription(u.id, await browserKeys());
    stubFetch((url) => (url === gone.endpoint ? 410 : url === flaky.endpoint ? 500 : 201));
    await deliverMail(addr, { subject: 'first' });
    expect(await env.DB.prepare('SELECT 1 FROM push_subscriptions WHERE id = ?').bind(gone.id).first()).toBeNull();
    expect(await env.DB.prepare('SELECT failures FROM push_subscriptions WHERE id = ?').bind(flaky.id).first<number>('failures')).toBe(1);
    for (let i = 2; i <= 5; i++) await deliverMail(addr, { subject: `message ${i}` });
    expect(await env.DB.prepare('SELECT 1 FROM push_subscriptions WHERE id = ?').bind(flaky.id).first()).toBeNull();
    const okRow = await env.DB.prepare('SELECT failures, last_success_at FROM push_subscriptions WHERE id = ?').bind(ok.id).first<{ failures: number; last_success_at: number }>();
    expect(okRow).toMatchObject({ failures: 0 });
    expect(okRow!.last_success_at).toBeGreaterThan(0);
  });

  it('push failures never affect mail delivery', async () => {
    const u = await createUser();
    const addr = `${randomLocal('box')}@push.test`;
    const mb = await createMailbox(addr, [{ userId: u.id }]);
    const sub = await addSubscription(u.id, await browserKeys());
    // A corrupt key makes encryption throw; the network failing makes fetch throw.
    await addSubscription(u.id, { ...(await browserKeys()), p256dh: 'AAAA' });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(() => new TypeError('network down'));
    const { msg, out } = await deliverMail(addr, { subject: 'Still arrives' });
    expect(msg.rejected).toBeNull();
    expect(out.accepted).toBe(true);
    if (!out.accepted) return;
    expect(out.folderId).toBe(mb.folders.inbox);
    expect(await env.DB.prepare('SELECT subject FROM messages WHERE id = ?').bind(out.messageId).first<string>('subject')).toBe('Still arrives');
    expect(await env.DB.prepare('SELECT failures FROM push_subscriptions WHERE id = ?').bind(sub.id).first<number>('failures')).toBe(1);
    // Logs carry error names and status codes only, never content.
    for (const c of errors.mock.calls) expect(c.join(' ')).not.toMatch(/Still arrives|Priya|partner\.test/);
    errors.mockRestore();
  });

  it('rate-limits per user: one push per thread per 10 s, and at most 60 an hour', async () => {
    const u = await createUser();
    const addr = `${randomLocal('box')}@push.test`;
    const mb = await createMailbox(addr, [{ userId: u.id }]);
    await addSubscription(u.id, await browserKeys());
    const sent = stubFetch();
    const first = await deliverMail(addr, { subject: 'Lunch?', messageId: '<lunch-1@partner.test>' });
    await deliverMail(addr, { subject: 'Re: Lunch?', inReplyTo: '<lunch-1@partner.test>', references: '<lunch-1@partner.test>' });
    expect(first.out.accepted).toBe(true);
    expect(sent).toHaveLength(1);

    const threadId = first.out.accepted ? first.out.threadId! : '';
    const now = Date.now();
    const mail = { mailboxId: mb.id, mailboxAddress: addr, threadId, from: { email: 'a@b.test' }, subject: 's' };
    await notifyNewMail(env, mail, now + 11_000); // the thread window has passed
    expect(sent).toHaveLength(2);

    const hourly = await createUser();
    await createMailbox(`${randomLocal('box')}@push.test`, [{ userId: hourly.id }]);
    const hb = await env.DB.prepare('SELECT mailbox_id FROM mailbox_members WHERE user_id = ?').bind(hourly.id).first<string>('mailbox_id');
    await addSubscription(hourly.id, await browserKeys());
    // Spend all but one of the hour's pushes (each on its own thread), then three more threads: one goes out.
    for (let i = 0; i < PUSH_HOURLY_CAP - 1; i++) await hit(env.DB, `push:h:${hourly.id}`, 3600_000, now);
    const before = sent.length;
    for (let i = 0; i < 3; i++) await notifyNewMail(env, { ...mail, mailboxId: hb!, threadId: ulid() }, now);
    expect(sent.length - before).toBe(1);
    await notifyNewMail(env, { ...mail, mailboxId: hb!, threadId: ulid() }, now + 3601_000); // the next hour
    expect(sent.length - before).toBe(2);
  });
});
