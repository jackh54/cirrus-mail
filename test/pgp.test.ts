import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MessageFull, PgpKeyResponse, PgpKeyringEntry, PgpKeyringResponse } from '../src/shared/api';
import { ulid } from '../src/shared/ulid';
import { processInbound } from '../src/worker/inbound/handler';
import { hashPassword, toBase64 } from '../src/worker/lib/crypto';
import {
  armoredToBase64, autocryptTrusted, dearmorPublicKey, lookupWkd, parseAutocrypt, parsePublicKey, parseWkdAddress, wkdHash, wkdUrls, zbase32,
} from '../src/worker/lib/pgp';
import { sendDueScheduled } from '../src/worker/cron';
import { buildPgpMime } from '../src/worker/outbound/pgpmime';
import { buildEml, call, createMailbox, fakeEmail, randomLocal, sessionCookie, withEnv } from './helpers';
import { KEY_A, KEY_B } from './pgp-fixtures';

const DOMAIN = 'pgptest.test';
const state = { a: '', b: '', aId: '', bId: '', mbId: '' };

async function mkUser(name: string, email: string): Promise<string> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, 'member', 0, ?, ?)")
    .bind(id, email, name, await hashPassword('admin-password-123'), now, now).run();
  return id;
}
const login = async (email: string) => sessionCookie(await call('/api/auth/login', { body: { email, password: 'admin-password-123' } }));

const PRIVATE = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${'A'.repeat(120)}\n-----END PGP PRIVATE KEY BLOCK-----\n`;
const keyBody = { publicKey: KEY_A.armored, privateKey: PRIVATE, addresses: ['alice@pgptest.test'] };
const CIPHERTEXT = '-----BEGIN PGP MESSAGE-----\n\nwcBMA0mZ0pQ3sGFQAQf/AbCdEf\n=abcd\n-----END PGP MESSAGE-----\n';
const SIGNED = '-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nhello\n-----BEGIN PGP SIGNATURE-----\n\nxyz\n=abcd\n-----END PGP SIGNATURE-----\n';

beforeAll(async () => {
  state.aId = await mkUser('Alice', 'alice@pgptest.test');
  state.bId = await mkUser('Bob', 'bob@pgptest.test');
  state.a = await login('alice@pgptest.test');
  state.b = await login('bob@pgptest.test');
  state.mbId = (await createMailbox('alice-box@pgptest.test', [{ userId: state.aId, role: 'owner' }])).id;
});

afterEach(() => vi.restoreAllMocks());

describe('WKD URLs', () => {
  it('hashes the lowercased local part with z-base-32 (known vector)', async () => {
    expect(await wkdHash('Joe.Doe')).toBe('iy9q119eutrkn8s1mk4r39qejnbu3n5q');
    expect(await wkdHash('JOE.DOE')).toBe('iy9q119eutrkn8s1mk4r39qejnbu3n5q');
    expect(zbase32(new Uint8Array([0xff, 0x00]))).toBe('9hyy');
  });

  it('builds the advanced URL first, then the direct one; domain lowercased, local part keeps its case in ?l=', async () => {
    expect(await wkdUrls('Joe.Doe@Example.ORG')).toEqual([
      'https://openpgpkey.example.org/.well-known/openpgpkey/example.org/hu/iy9q119eutrkn8s1mk4r39qejnbu3n5q?l=Joe.Doe',
      'https://example.org/.well-known/openpgpkey/hu/iy9q119eutrkn8s1mk4r39qejnbu3n5q?l=Joe.Doe',
    ]);
  });

  it('percent-encodes the local part in ?l=', async () => {
    const [url] = await wkdUrls('a+b@example.org');
    expect(url.endsWith('?l=a%2Bb')).toBe(true);
  });
});

describe('WKD SSRF rules', () => {
  it.each([
    'a@localhost', 'a@127.0.0.1', 'a@[::1]', 'a@10.0.0.1', 'a@intranet', 'a@host.internal', 'a@host.local', 'a@evil.com/path',
    'a@evil.com:8080', 'a@evil.com#x', 'a@evil.com?x=1', 'a@user:pw@evil.com', 'a@-evil.com', 'a b@evil.com', '@evil.com', 'a@', 'a@ex ample.com',
  ])('rejects %s', (email) => {
    expect(() => parseWkdAddress(email)).toThrow();
  });

  it('the endpoint rejects a bad domain with 400 and never fetches', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await call('/api/pgp/keyring/wkd', { body: { email: 'bob@host.internal' }, cookie: state.a });
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('requires a session', async () => {
    expect((await call('/api/pgp/keyring/wkd', { body: { email: 'bob@example.org' } })).status).toBe(401);
  });

  it('does not follow a redirect to another host, and drops oversized answers', async () => {
    const seen: string[] = [];
    const redirecting = async (url: string) => {
      seen.push(url);
      return new Response(null, { status: 302, headers: { location: 'https://evil.example.net/key' } });
    };
    expect(await lookupWkd('x@example.org', redirecting)).toBeNull();
    expect(seen.some((u) => u.includes('evil.example.net'))).toBe(false);
    expect(seen).toHaveLength(2); // both methods tried, neither followed

    const big = async () => new Response(new Uint8Array(70 * 1024));
    expect(await lookupWkd('x@example.org', big)).toBeNull();
  });

  it('follows a same-host redirect and parses the key', async () => {
    const bytes = dearmorPublicKey(KEY_A.armored)!;
    let n = 0;
    const f = async (url: string) => {
      n++;
      if (n === 1) return new Response(null, { status: 301, headers: { location: new URL('/elsewhere', url).toString() } });
      return new Response(bytes);
    };
    const got = await lookupWkd('x@example.org', f);
    expect(got?.fingerprint).toBe(KEY_A.fingerprint);
  });
});

describe('public key parsing', () => {
  it('computes the v4 fingerprint', async () => {
    expect((await parsePublicKey(dearmorPublicKey(KEY_A.armored)!)).fingerprint).toBe(KEY_A.fingerprint);
    expect((await parsePublicKey(dearmorPublicKey(KEY_B.armored)!)).fingerprint).toBe(KEY_B.fingerprint);
  });

  it('rejects garbage, truncated data and secret key packets', async () => {
    await expect(parsePublicKey(new Uint8Array([1, 2, 3]))).rejects.toThrow();
    const bytes = dearmorPublicKey(KEY_A.armored)!;
    await expect(parsePublicKey(bytes.subarray(0, 30))).rejects.toThrow();
    const secret = new Uint8Array(bytes.length + 3);
    secret.set(bytes);
    secret.set([0xc5, 0x01, 0x00], bytes.length); // a trailing secret-key packet (tag 5)
    await expect(parsePublicKey(secret)).rejects.toThrow(/private/);
    await expect(parsePublicKey(Uint8Array.of(0xc5, 0x01, 0x00))).rejects.toThrow();
  });

  it('rejects a corrupted armor checksum', () => {
    expect(dearmorPublicKey(KEY_A.armored.replace(/=[A-Za-z0-9+/]{4}\n-----END/, '=AAAA\n-----END'))).toBeNull();
  });
});

describe('Autocrypt parsing', () => {
  const keydata = toBase64(dearmorPublicKey(KEY_A.armored)!);
  const header = (addr: string, extra = '') => `addr=${addr}; ${extra}keydata=${keydata.replace(/.{1,60}/g, '\r\n $&')}`;

  it('accepts a header whose addr matches From (case-insensitive, folded keydata)', async () => {
    const k = await parseAutocrypt([header('Carol@Example.org', 'prefer-encrypt=mutual; ')], 'carol@example.org');
    expect(k?.fingerprint).toBe(KEY_A.fingerprint);
  });

  it('rejects a mismatched addr, two headers, an unknown critical attribute and bad keydata', async () => {
    expect(await parseAutocrypt([header('mallory@example.org')], 'carol@example.org')).toBeNull();
    expect(await parseAutocrypt([header('carol@example.org'), header('carol@example.org')], 'carol@example.org')).toBeNull();
    expect(await parseAutocrypt([header('carol@example.org', 'danger=1; ')], 'carol@example.org')).toBeNull();
    expect((await parseAutocrypt([header('carol@example.org', '_ok=1; ')], 'carol@example.org'))?.fingerprint).toBe(KEY_A.fingerprint);
    expect(await parseAutocrypt(['addr=carol@example.org; keydata=AAAA'], 'carol@example.org')).toBeNull();
  });

  it('is trusted only after an aligned DMARC pass', () => {
    expect(autocryptTrusted({ dmarc: 'pass', aligned: true })).toBe(true);
    expect(autocryptTrusted({ dmarc: 'pass', aligned: false })).toBe(false);
    expect(autocryptTrusted({ dkim: 'pass', aligned: true })).toBe(false);
    expect(autocryptTrusted({ dmarc: 'fail', aligned: true })).toBe(false);
    expect(autocryptTrusted(null)).toBe(false);
  });

  describe('on inbound mail', () => {
    const PASS = (d: string) => ({ 'Authentication-Results': `mx.cloudflare.net; dkim=pass header.d=${d}; dmarc=pass header.from=${d}; spf=pass smtp.mailfrom=${d}` });
    const keyring = (userId: string, email: string) => env.DB.prepare('SELECT * FROM pgp_keyring WHERE user_id = ? AND email = ?').bind(userId, email).first<{ fingerprint: string; source: string; pending_fingerprint: string | null }>();

    async function deliver(to: string, from: string, autocrypt: string, auth: Record<string, string>) {
      const raw = buildEml({ from, to, subject: 'hi', body: 'hello', headers: { Autocrypt: autocrypt, ...auth } });
      return processInbound(fakeEmail(from, to, raw), env);
    }

    it('stores the key for every member when DMARC is aligned and addr matches', async () => {
      const addr = `${randomLocal()}@pgpin.test`;
      await createMailbox(addr, [{ userId: state.aId }, { userId: state.bId }]);
      const out = await deliver(addr, 'carol@example.org', header('carol@example.org'), PASS('example.org'));
      expect(out.accepted).toBe(true);
      for (const id of [state.aId, state.bId]) {
        const row = await keyring(id, 'carol@example.org');
        expect(row?.fingerprint).toBe(KEY_A.fingerprint);
        expect(row?.source).toBe('autocrypt');
      }
    });

    it('ignores the header without a DMARC pass, or when addr is not the From address', async () => {
      const addr = `${randomLocal()}@pgpin.test`;
      await createMailbox(addr, [{ userId: state.aId }]);
      await deliver(addr, 'dave@example.org', header('dave@example.org'), {});
      await deliver(addr, 'dave@example.org', header('dave@example.org'), { 'Authentication-Results': 'mx.cloudflare.net; dkim=none; spf=fail; dmarc=fail header.from=example.org' });
      await deliver(addr, 'erin@example.org', header('someone-else@example.org'), PASS('example.org'));
      expect(await keyring(state.aId, 'dave@example.org')).toBeNull();
      expect(await keyring(state.aId, 'erin@example.org')).toBeNull();
      expect(await keyring(state.aId, 'someone-else@example.org')).toBeNull();
    });

    it('parks a changed key as pending instead of replacing the stored one', async () => {
      const addr = `${randomLocal()}@pgpin.test`;
      await createMailbox(addr, [{ userId: state.aId }]);
      await deliver(addr, 'frank@example.org', header('frank@example.org'), PASS('example.org'));
      const keydataB = toBase64(dearmorPublicKey(KEY_B.armored)!);
      await deliver(addr, 'frank@example.org', `addr=frank@example.org; keydata=${keydataB}`, PASS('example.org'));
      const row = await keyring(state.aId, 'frank@example.org');
      expect(row?.fingerprint).toBe(KEY_A.fingerprint);
      expect(row?.pending_fingerprint).toBe(KEY_B.fingerprint);
    });
  });
});

describe('key storage endpoints', () => {
  it('requires a session', async () => {
    expect((await call('/api/pgp/key')).status).toBe(401);
    expect((await call('/api/pgp/key', { method: 'PUT', body: keyBody })).status).toBe(401);
    expect((await call('/api/pgp/keyring')).status).toBe(401);
  });

  it('only the owner can read, write or delete their key', async () => {
    expect((await (await call('/api/pgp/key', { cookie: state.a })).json<PgpKeyResponse>()).key).toBeNull();
    const put = await call('/api/pgp/key', { method: 'PUT', body: keyBody, cookie: state.a });
    expect(put.status).toBe(200);
    const stored = (await put.json<PgpKeyResponse>()).key!;
    expect(stored.fingerprint).toBe(KEY_A.fingerprint);
    expect(stored.privateKey).toBe(PRIVATE);

    // Bob has his own (empty) slot: he sees nothing of Alice's, and his delete leaves hers alone.
    expect((await (await call('/api/pgp/key', { cookie: state.b })).json<PgpKeyResponse>()).key).toBeNull();
    expect((await call('/api/pgp/key', { method: 'DELETE', cookie: state.b })).status).toBe(200);
    expect((await (await call('/api/pgp/key', { cookie: state.a })).json<PgpKeyResponse>()).key?.fingerprint).toBe(KEY_A.fingerprint);

    // Replacing with another key keeps one row; deleting removes it.
    const b2 = await call('/api/pgp/key', { method: 'PUT', body: { ...keyBody, publicKey: KEY_B.armored, revoked: true }, cookie: state.a });
    expect((await b2.json<PgpKeyResponse>()).key).toMatchObject({ fingerprint: KEY_B.fingerprint, revoked: true });
    expect((await call('/api/pgp/key', { method: 'DELETE', cookie: state.a })).status).toBe(200);
    expect((await (await call('/api/pgp/key', { cookie: state.a })).json<PgpKeyResponse>()).key).toBeNull();
  });

  it('keeps only addresses the user can send from', async () => {
    const mine = (await createMailbox('addr-box@pgptest.test', [{ userId: state.aId }])).id;
    await env.DB.prepare("INSERT INTO aliases (id, mailbox_id, address, can_send, created_at) VALUES (?, ?, 'addr-alias@pgptest.test', 1, ?)").bind(ulid(), mine, Date.now()).run();
    await env.DB.prepare("INSERT INTO aliases (id, mailbox_id, address, can_send, created_at) VALUES (?, ?, 'addr-recv@pgptest.test', 0, ?)").bind(ulid(), mine, Date.now()).run();
    const addresses = ['Addr-Box@pgptest.test', 'addr-alias@pgptest.test', 'addr-recv@pgptest.test', 'alice-box@pgptest.test', 'victim@example.org', 'bob@pgptest.test'];
    const put = await call('/api/pgp/key', { method: 'PUT', body: { ...keyBody, addresses }, cookie: state.a });
    expect(put.status).toBe(200);
    expect((await put.json<PgpKeyResponse>()).key!.addresses.sort()).toEqual(['addr-alias@pgptest.test', 'addr-box@pgptest.test', 'alice-box@pgptest.test']);
    // Bob is in none of those mailboxes
    const bob = await call('/api/pgp/key', { method: 'PUT', body: { ...keyBody, publicKey: KEY_B.armored, addresses }, cookie: state.b });
    expect((await bob.json<PgpKeyResponse>()).key!.addresses).toEqual([]);
    await call('/api/pgp/key', { method: 'DELETE', cookie: state.a });
    await call('/api/pgp/key', { method: 'DELETE', cookie: state.b });
  });

  it('rejects a private key that is not armored, and a "public key" that holds secret material', async () => {
    expect((await call('/api/pgp/key', { method: 'PUT', body: { ...keyBody, privateKey: 'x'.repeat(200) }, cookie: state.a })).status).toBe(400);
    expect((await call('/api/pgp/key', { method: 'PUT', body: { ...keyBody, publicKey: PRIVATE }, cookie: state.a })).status).toBe(400);
  });
});

describe('keyring', () => {
  const post = (body: unknown, cookie = state.a) => call('/api/pgp/keyring', { body, cookie });

  it('imports, refuses a silent change, replaces on request, and keeps keys per user', async () => {
    const first = await post({ email: 'Harry@Example.org', publicKey: KEY_A.armored });
    expect(first.status).toBe(200);
    const entry = (await first.json<PgpKeyringResponse>()).entry;
    expect(entry).toMatchObject({ email: 'harry@example.org', fingerprint: KEY_A.fingerprint, source: 'manual', pending: null });

    const changed = await post({ email: 'harry@example.org', publicKey: KEY_B.armored });
    expect(changed.status).toBe(409);
    expect((await changed.json<{ error: { code: string } }>()).error.code).toBe('KEY_CHANGED');
    const listed = (await (await call('/api/pgp/keyring', { cookie: state.a })).json<{ items: PgpKeyringEntry[] }>()).items;
    expect(listed.find((e) => e.email === 'harry@example.org')?.fingerprint).toBe(KEY_A.fingerprint);

    const replaced = await post({ email: 'harry@example.org', publicKey: KEY_B.armored, replace: true });
    expect((await replaced.json<PgpKeyringResponse>()).entry.fingerprint).toBe(KEY_B.fingerprint);

    const bobs = (await (await call('/api/pgp/keyring', { cookie: state.b })).json<{ items: PgpKeyringEntry[] }>()).items;
    expect(bobs.find((e) => e.email === 'harry@example.org')).toBeUndefined();
    expect((await call(`/api/pgp/keyring/${entry.id}`, { method: 'DELETE', cookie: state.b })).status).toBe(404);
    expect((await call(`/api/pgp/keyring/${entry.id}`, { method: 'DELETE', cookie: state.a })).status).toBe(200);
  });

  it('WKD stores the key with source wkd, and a changed key waits as pending until accepted', async () => {
    const bytesA = dearmorPublicKey(KEY_A.armored)!;
    const bytesB = dearmorPublicKey(KEY_B.armored)!;
    let answer = bytesA;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(answer));
    const first = await call('/api/pgp/keyring/wkd', { body: { email: 'wendy@example.org' }, cookie: state.a });
    expect(first.status).toBe(200);
    expect((await first.json<PgpKeyringResponse>()).entry).toMatchObject({ source: 'wkd', fingerprint: KEY_A.fingerprint });

    answer = bytesB;
    const second = (await (await call('/api/pgp/keyring/wkd', { body: { email: 'wendy@example.org' }, cookie: state.a })).json<PgpKeyringResponse>());
    expect(second.status).toBe('pending');
    expect(second.entry.fingerprint).toBe(KEY_A.fingerprint);
    expect(second.entry.pending?.fingerprint).toBe(KEY_B.fingerprint);

    expect((await call(`/api/pgp/keyring/${second.entry.id}/accept`, { method: 'POST', body: {}, cookie: state.b })).status).toBe(404);
    const accepted = await call(`/api/pgp/keyring/${second.entry.id}/accept`, { method: 'POST', body: {}, cookie: state.a });
    expect((await accepted.json<{ entry: PgpKeyringEntry }>()).entry).toMatchObject({ fingerprint: KEY_B.fingerprint, pending: null });
  });

  it('WKD answers 404 when nothing is published', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('nope', { status: 404 }));
    expect((await call('/api/pgp/keyring/wkd', { body: { email: 'nobody@example.org' }, cookie: state.a })).status).toBe(404);
  });
});

describe('sending OpenPGP bodies', () => {
  function stubEmail() {
    const calls: unknown[] = [];
    const e = withEnv({ EMAIL: { send: async (m: unknown) => { calls.push(m); return { messageId: 'cf-1@pgptest.test' }; } } as unknown as SendEmail });
    return { e, calls };
  }
  const addr = (email: string) => ({ email, name: '' });

  async function draft(over: Record<string, unknown> = {}): Promise<MessageFull> {
    const base = { from: 'alice-box@pgptest.test', to: [addr('carol@example.org'), addr('dan@example.org')], cc: [], bcc: [addr('eve@example.org')], subject: 'Secret', html: '' };
    const d = await call(`/api/mailboxes/${state.mbId}/drafts`, { body: { ...base, html: '<p>draft</p>' }, cookie: state.a });
    const created = await d.json<MessageFull>();
    const put = await call(`/api/mailboxes/${state.mbId}/drafts/${created.id}`, { method: 'PUT', body: { ...base, ...over }, cookie: state.a });
    expect(put.status).toBe(200);
    return created;
  }
  const send = (id: string, e: Env) => call(`/api/mailboxes/${state.mbId}/drafts/${id}/send`, { body: {}, cookie: state.a, env: e });

  it('inline mode: the armored text goes out unchanged, text/plain only', async () => {
    for (const text of [CIPHERTEXT, SIGNED]) {
      const d = await draft({ text, pgp: 'inline' });
      const { e, calls } = stubEmail();
      expect((await send(d.id, e)).status).toBe(200);
      expect(calls).toHaveLength(1);
      const b = calls[0] as { text: string; html?: string; attachments?: unknown };
      expect(b.text).toBe(text);
      expect(b.html).toBeUndefined();
      expect(b.attachments).toBeUndefined();
    }
  });

  it('mime mode: sends raw MIME, one envelope per recipient, and records it as sent', async () => {
    await call('/api/pgp/key', { method: 'PUT', body: { ...keyBody, addresses: ['alice-box@pgptest.test'] }, cookie: state.a });
    const d = await draft({ text: CIPHERTEXT, pgp: 'mime' });
    const { e, calls } = stubEmail();
    const res = await send(d.id, e);
    expect(res.status).toBe(200);
    // carol, dan (to) and eve (bcc): three envelopes, same message
    expect(calls).toHaveLength(3);
    const msgs = calls as { from: string; to: string; raw?: ReadableStream }[];
    expect(msgs.map((m) => m.to).sort()).toEqual(['carol@example.org', 'dan@example.org', 'eve@example.org']);
    expect(msgs.every((m) => m.from === 'alice-box@pgptest.test')).toBe(true);
    const sent = (await res.json<{ message: MessageFull; status: string }>()).message;
    expect(sent.status).toBe('sent');
    expect(sent.snippet).toBe('Encrypted message');
    await call('/api/pgp/key', { method: 'DELETE', cookie: state.a });
  });

  it('buildPgpMime is RFC 3156 shaped and passes the payload through', () => {
    const raw = buildPgpMime({
      from: { email: 'a@x.test', name: 'Zoë "Z" A' }, to: [addr('b@y.test')], cc: [], subject: 'Grüße', messageId: '<id@x.test>',
      date: new Date(0), armored: CIPHERTEXT, boundary: 'BOUND', autocryptKeydata: 'QUJD'.repeat(40),
    });
    expect(raw).toMatch(/\r\nAutocrypt: addr=a@x\.test; keydata=\r\n QUJD/);
    expect(raw).not.toMatch(/^Bcc:/im);
    expect(raw).toContain('From: =?UTF-8?B?');
    expect(raw).toContain('Subject: =?UTF-8?B?');
    expect(raw).toContain('Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="BOUND"');
    expect(raw).toContain('Content-Type: application/pgp-encrypted\r\nContent-Description: PGP/MIME version identification\r\n\r\nVersion: 1\r\n');
    expect(raw).toContain(`filename="encrypted.asc"\r\n\r\n${CIPHERTEXT.trim().replace(/\n/g, '\r\n')}\r\n--BOUND--`);
    expect(/[^\r]\n/.test(raw)).toBe(false); // CRLF only
  });

  it('folds References and In-Reply-To at spaces so no line is too long', () => {
    const ids = Array.from({ length: 120 }, (_, i) => `<${String(i).padStart(3, '0')}.${'x'.repeat(30)}@long.test>`);
    const raw = buildPgpMime({
      from: addr('a@x.test'), to: [addr('b@y.test')], cc: [], subject: 'Re: long', messageId: '<id@x.test>', date: new Date(0),
      inReplyTo: ids[ids.length - 1], references: ids.join(' '), armored: CIPHERTEXT, boundary: 'BOUND',
    });
    const head = raw.slice(0, raw.indexOf('\r\n\r\n'));
    const idLines = head.split('\r\n').filter((l) => /^(References:|In-Reply-To:| <)/.test(l));
    expect(idLines.length).toBeGreaterThan(40);
    expect(Math.max(...idLines.map((l) => l.length))).toBeLessThanOrEqual(78);
    const refs = /\r\nReferences: ((?:.|\r\n )*)/.exec(head)![1];
    expect(refs).toContain('\r\n <');
    expect(refs.replace(/\r\n /g, ' ')).toBe(ids.join(' '));
    expect(head).toContain(`\r\nIn-Reply-To: ${ids[ids.length - 1]}\r\n`);
  });

  it('a scheduled send attaches only the scheduling member\'s key as Autocrypt, not another member\'s', async () => {
    const addrBox = 'shared-box@pgptest.test';
    const mb = await createMailbox(addrBox, [{ userId: state.aId }, { userId: state.bId, role: 'member' }]);
    // Bob holds a key that claims the shared address; Alice schedules the send.
    await env.DB.prepare('INSERT INTO pgp_keys (user_id, fingerprint, public_key, private_key_enc, addresses, revoked, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
      .bind(state.bId, KEY_B.fingerprint, KEY_B.armored, PRIVATE, JSON.stringify([addrBox]), 1, 1).run();
    const base = { from: addrBox, to: [addr('carol@example.org')], cc: [], bcc: [], subject: 'Sched', html: '<p>draft</p>' };
    const schedule = async () => {
      const d = (await (await call(`/api/mailboxes/${mb.id}/drafts`, { body: base, cookie: state.a })).json<MessageFull>());
      expect((await call(`/api/mailboxes/${mb.id}/drafts/${d.id}`, { method: 'PUT', body: { ...base, html: '', text: CIPHERTEXT, pgp: 'mime' }, cookie: state.a })).status).toBe(200);
      const sendAt = Date.now() + 3600_000;
      expect((await call(`/api/mailboxes/${mb.id}/drafts/${d.id}/send`, { body: { sendAt }, cookie: state.a })).status).toBe(200);
      const sent: string[] = [];
      const e = withEnv({ EMAIL: { send: async (m: Record<string, unknown>) => { sent.push(await new Response(m['EmailMessage::raw'] as BodyInit).text()); return { messageId: 'cf-2@pgptest.test' }; } } as unknown as SendEmail });
      expect(await sendDueScheduled(e, sendAt + 1)).toBe(1);
      expect(sent).toHaveLength(1);
      return sent[0];
    };
    expect(await schedule()).not.toContain('Autocrypt:');
    // With Alice's own key, hers is the one attached.
    await env.DB.prepare('INSERT INTO pgp_keys (user_id, fingerprint, public_key, private_key_enc, addresses, revoked, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
      .bind(state.aId, KEY_A.fingerprint, KEY_A.armored, PRIVATE, JSON.stringify([addrBox]), 2, 2).run();
    const withKey = (await schedule()).replace(/\r\n /g, '');
    expect(withKey).toContain(`keydata=${armoredToBase64(KEY_A.armored)}`);
    expect(withKey).not.toContain(armoredToBase64(KEY_B.armored));
    await env.DB.prepare('DELETE FROM pgp_keys WHERE user_id IN (?, ?)').bind(state.aId, state.bId).run();
  });

  it('refuses HTML or non-armored bodies in PGP mode, and attachments at send time', async () => {
    const d = await draft();
    const put = (body: Record<string, unknown>) => call(`/api/mailboxes/${state.mbId}/drafts/${d.id}`, {
      method: 'PUT', cookie: state.a,
      body: { from: 'alice-box@pgptest.test', to: [addr('carol@example.org')], cc: [], bcc: [], subject: 'S', html: '', ...body },
    });
    expect((await put({ html: '<p>x</p>', text: CIPHERTEXT, pgp: 'mime' })).status).toBe(400);
    expect((await put({ text: 'plain words', pgp: 'mime' })).status).toBe(400);
    expect((await put({ text: SIGNED, pgp: 'mime' })).status).toBe(400);
    expect((await put({ text: 'plain words', pgp: 'inline' })).status).toBe(400);
    expect((await put({ text: CIPHERTEXT, pgp: 'mime' })).status).toBe(200);

    const form = new FormData();
    form.set('file', new File(['hi'], 'a.txt', { type: 'text/plain' }));
    expect((await call(`/api/mailboxes/${state.mbId}/drafts/${d.id}/attachments`, { form, cookie: state.a })).status).toBe(201);
    const { e, calls } = stubEmail();
    const res = await send(d.id, e);
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('PGP_ATTACHMENTS');
    expect(calls).toHaveLength(0);
  });

  it('an ordinary save clears the PGP mode', async () => {
    const d = await draft({ text: CIPHERTEXT, pgp: 'mime' });
    const row = () => env.DB.prepare('SELECT pgp_mode FROM messages WHERE id = ?').bind(d.id).first<string>('pgp_mode');
    expect(await row()).toBe('mime');
    await call(`/api/mailboxes/${state.mbId}/drafts/${d.id}`, {
      method: 'PUT', cookie: state.a, body: { from: 'alice-box@pgptest.test', to: [addr('carol@example.org')], cc: [], bcc: [], subject: 'S', html: '<p>plain again</p>' },
    });
    expect(await row()).toBeNull();
  });
});
