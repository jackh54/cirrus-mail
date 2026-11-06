import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page, ReplyTemplate, ThreadDetail, ThreadSummary, UnsubscribeResponse } from '../src/shared/api';
import { ulid } from '../src/shared/ulid';
import { runCron } from '../src/worker/cron';
import { processInbound } from '../src/worker/inbound/handler';
import { randomBytes, sha256Hex, toBase64Url } from '../src/worker/lib/crypto';
import { hit } from '../src/worker/lib/ratelimit';
import { sendingStatus } from '../src/worker/lib/sendcount';
import { parseListUnsubscribe } from '../src/worker/lib/unsubscribe';
import { wakeDueSnoozed } from '../src/worker/snooze';
import { buildEml, call, createMailbox, fakeEmail, randomLocal, withEnv } from './helpers';

const HOUR = 3600_000;
const PASS = { 'Authentication-Results': 'mx.cloudflare.net; dkim=pass header.d=news.test header.s=s1; dmarc=pass header.from=news.test policy.dmarc=none; spf=pass smtp.mailfrom=news.test' };
const FAIL = { 'Authentication-Results': 'mx.cloudflare.net; dkim=fail; spf=fail; dmarc=fail header.from=news.test' };

async function createUser(): Promise<{ id: string; cookie: string }> {
  const id = ulid();
  const now = Date.now();
  const token = toBase64Url(randomBytes(32));
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, email, name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, `${randomLocal('x')}@extras.test`, 'Extras User', 'x', 'member', now, now),
    env.DB.prepare('INSERT INTO sessions (id, token_hash, user_id, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, NULL, ?, ?, ?)')
      .bind(ulid(), await sha256Hex(token), id, now, now, now + 86_400_000),
  ]);
  return { id, cookie: `cirrus_session=${token}` };
}

async function setup() {
  const user = await createUser();
  const address = `${randomLocal('box')}@extras.test`;
  const mb = await createMailbox(address, [{ userId: user.id }]);
  return { user, address, mb, base: `/api/mailboxes/${mb.id}` };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function deliver(address: string, opts: Partial<Parameters<typeof buildEml>[0]> = {}, from = 'News <news@news.test>') {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const email = from.replace(/.*</, '').replace(/>.*/, '');
  const msg = fakeEmail(email, address, buildEml({ from, to: address, subject: 'Weekly digest', body: 'hello', ...opts }));
  const out = await processInbound(msg, env, ctx);
  await Promise.all(pending);
  if (!out.accepted || out.duplicate) throw new Error('not delivered');
  return out;
}

async function inboxList(t: Ctx, folder?: string): Promise<ThreadSummary[]> {
  const res = await call(`${t.base}/threads${folder ? `?folder=${folder}` : ''}`, { cookie: t.user.cookie });
  return (await res.json<Page<ThreadSummary>>()).items;
}

const act = (t: Ctx, body: Record<string, unknown>) => call(`${t.base}/threads/actions`, { body, cookie: t.user.cookie });

async function messageOf(threadId: string) {
  return (await env.DB.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC, id DESC').bind(threadId).first<{ id: string; folder_id: string; is_read: number; date: number; display_date: number; unsub_json: string | null; message_id_hdr: string }>())!;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------- snooze ----------

describe('snooze', () => {
  it('hides the thread from the Inbox, lists it under Snoozed, and the cron wakes it unread at the top', async () => {
    const t = await setup();
    const a = await deliver(t.address, { subject: 'Snooze me' });
    await act(t, { threadIds: [a.threadId], action: 'read' });
    const b = await deliver(t.address, { subject: 'Other mail' });
    const until = Date.now() + 3 * HOUR;
    expect((await act(t, { threadIds: [a.threadId], action: 'snooze', until })).status).toBe(200);

    expect((await inboxList(t)).map((x) => x.id)).toEqual([b.threadId]);
    expect((await inboxList(t, t.mb.folders.inbox)).map((x) => x.id)).toEqual([b.threadId]);
    const snoozed = await inboxList(t, 'snoozed');
    expect(snoozed.map((x) => x.id)).toEqual([a.threadId]);
    expect(snoozed[0].snoozedUntil).toBe(until);

    // Not due yet: nothing happens.
    expect(await wakeDueSnoozed(env, until - 1)).toBe(0);
    expect((await inboxList(t)).map((x) => x.id)).toEqual([b.threadId]);

    // The cron path wakes it (fake time: the tick's scheduledTime does not matter, `now` is passed in directly).
    expect(await wakeDueSnoozed(env, until + 1)).toBe(1);
    const inbox = await inboxList(t);
    expect(inbox.map((x) => x.id)).toEqual([a.threadId, b.threadId]);
    expect(inbox[0].lastMessageAt).toBe(until + 1);
    expect(inbox[0].unreadCount).toBe(1);
    expect(inbox[0].snoozedUntil).toBeNull();
    expect(await inboxList(t, 'snoozed')).toEqual([]);
    // The sender-visible date is untouched.
    const detail = await (await call(`${t.base}/threads/${a.threadId}`, { cookie: t.user.cookie })).json<ThreadDetail>();
    const row = await messageOf(a.threadId!);
    expect(detail.messages[0].date).toBe(row.display_date);
    expect(row.date).toBe(until + 1);
  });

  it('rejects past, far-future and missing times', async () => {
    const t = await setup();
    const a = await deliver(t.address);
    for (const until of [Date.now() - 1000, Date.now() + 400 * 24 * HOUR, undefined]) {
      expect((await act(t, { threadIds: [a.threadId], action: 'snooze', until })).status).toBe(400);
    }
  });

  it('a snoozed thread archived by hand is no longer snoozed', async () => {
    const t = await setup();
    const a = await deliver(t.address);
    await act(t, { threadIds: [a.threadId], action: 'snooze', until: Date.now() + HOUR });
    await act(t, { threadIds: [a.threadId], action: 'archive' });
    expect(await inboxList(t, 'snoozed')).toEqual([]);
    expect(await wakeDueSnoozed(env, Date.now() + 2 * HOUR)).toBe(0);
  });

  it('an archived thread snoozed from elsewhere comes back to the Inbox on wake', async () => {
    const t = await setup();
    const a = await deliver(t.address);
    await act(t, { threadIds: [a.threadId], action: 'archive' });
    const until = Date.now() + HOUR;
    await act(t, { threadIds: [a.threadId], action: 'snooze', until });
    expect((await inboxList(t, 'snoozed')).map((x) => x.id)).toEqual([a.threadId]);
    expect(await wakeDueSnoozed(env, until + 1)).toBe(1);
    expect((await inboxList(t)).map((x) => x.id)).toEqual([a.threadId]);
  });

  it('a reply un-snoozes the thread immediately', async () => {
    const t = await setup();
    const a = await deliver(t.address, { subject: 'Question', messageId: '<q1@news.test>' });
    await act(t, { threadIds: [a.threadId], action: 'snooze', until: Date.now() + 5 * HOUR });
    expect(await inboxList(t)).toEqual([]);
    const r = await deliver(t.address, { subject: 'Re: Question', inReplyTo: '<q1@news.test>', references: '<q1@news.test>' });
    expect(r.threadId).toBe(a.threadId);
    const inbox = await inboxList(t);
    expect(inbox.map((x) => x.id)).toEqual([a.threadId]);
    expect(inbox[0].snoozedUntil).toBeNull();
    expect(await wakeDueSnoozed(env, Date.now() + 6 * HOUR)).toBe(0);
  });

  it('the wake claim is atomic: overlapping runs wake and notify a thread once', async () => {
    const t = await setup();
    const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const pub = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey) as ArrayBuffer);
    await env.DB.prepare('INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)')
      .bind(ulid(), t.user.id, `https://fcm.googleapis.com/fcm/send/${ulid()}`, toBase64Url(pub), toBase64Url(randomBytes(16)), Date.now()).run();
    const pushes: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      pushes.push(String(input));
      return new Response(null, { status: 201 });
    });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await deliver(t.address, { subject: `Mail ${i}` })).threadId!);
    const until = Date.now() + HOUR;
    await act(t, { threadIds: ids, action: 'snooze', until });
    // Arrival pushes are done; the per-thread push window must not hide the wake pushes.
    pushes.length = 0;
    await env.DB.prepare("DELETE FROM rate_limits WHERE key LIKE 'push:%'").run();
    const runs = await Promise.all([wakeDueSnoozed(env, until + 1), wakeDueSnoozed(env, until + 1), runCron(env, 0).then(() => 0)]);
    // Every thread was woken exactly once across the overlapping runs (cron's own run uses the real clock: not yet due).
    expect(runs[0] + runs[1]).toBe(3);
    expect(pushes).toHaveLength(3);
    const woke = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = ? AND date = ?').bind(t.mb.id, until + 1).first<number>('n');
    expect(woke).toBe(3);
  });

  it('cannot snooze another mailbox’s thread', async () => {
    const t = await setup();
    const a = await deliver(t.address);
    await act(t, { threadIds: [a.threadId], action: 'snooze', until: Date.now() + HOUR });
    // A thread of another mailbox cannot be snoozed through this one.
    const other = await setup();
    expect((await act(other, { threadIds: [a.threadId], action: 'snooze', until: Date.now() + HOUR })).status).toBe(404);
  });
});

// ---------- mute ----------

describe('mute', () => {
  it('routes new mail in a muted thread to Archive, read, without a push; unmute restores the Inbox', async () => {
    const t = await setup();
    const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const pub = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey) as ArrayBuffer);
    await env.DB.prepare('INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)')
      .bind(ulid(), t.user.id, `https://fcm.googleapis.com/fcm/send/${ulid()}`, toBase64Url(pub), toBase64Url(randomBytes(16)), Date.now()).run();
    const pushes: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      pushes.push(String(input));
      return new Response(null, { status: 201 });
    });
    const a = await deliver(t.address, { subject: 'Noisy thread', messageId: '<n1@news.test>' });
    expect(pushes).toHaveLength(1);
    expect((await act(t, { threadIds: [a.threadId], action: 'mute' })).status).toBe(200);
    expect((await inboxList(t))[0].muted).toBe(true);

    const r = await deliver(t.address, { subject: 'Re: Noisy thread', inReplyTo: '<n1@news.test>' });
    expect(r.threadId).toBe(a.threadId);
    expect(r.folderId).toBe(t.mb.folders.archive);
    expect((await messageOf(a.threadId!)).is_read).toBe(1);
    expect(pushes).toHaveLength(1);

    await act(t, { threadIds: [a.threadId], action: 'unmute' });
    await env.DB.prepare("DELETE FROM rate_limits WHERE key LIKE 'push:%'").run();
    const r2 = await deliver(t.address, { subject: 'Re: Noisy thread', inReplyTo: '<n1@news.test>' });
    expect(r2.folderId).toBe(t.mb.folders.inbox);
    expect(pushes).toHaveLength(2);
  });

  it('only acts on threads of this mailbox', async () => {
    const t = await setup();
    const o = await setup();
    const a = await deliver(o.address);
    expect((await act(t, { threadIds: [a.threadId], action: 'mute' })).status).toBe(404);
    expect((await inboxList(o))[0].muted).toBe(false);
  });
});

// ---------- unsubscribe ----------

const HDR = { 'List-Unsubscribe': '<https://news.test/u/abc?x=1>, <mailto:unsub@news.test?subject=Remove%20me>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };

describe('unsubscribe headers', () => {
  it('parses https and mailto, one-click only with the post header, and drops unsafe URLs', () => {
    expect(parseListUnsubscribe(HDR['List-Unsubscribe'], HDR['List-Unsubscribe-Post'])).toEqual({
      url: 'https://news.test/u/abc?x=1', mailto: 'unsub@news.test', subject: 'Remove me', oneClick: true,
    });
    expect(parseListUnsubscribe(HDR['List-Unsubscribe'], null)).toEqual({ url: 'https://news.test/u/abc?x=1', mailto: 'unsub@news.test', subject: 'Remove me' });
    expect(parseListUnsubscribe('<http://news.test/u>', 'List-Unsubscribe=One-Click')).toBeNull();
    expect(parseListUnsubscribe('<https://127.0.0.1/u>, <https://localhost/u>, <https://u:p@news.test/x>, <https://intranet/u>', null)).toBeNull();
    expect(parseListUnsubscribe('<mailto:not an address>', null)).toBeNull();
    expect(parseListUnsubscribe('<mailto:a@news.test>', 'List-Unsubscribe=One-Click')).toEqual({ mailto: 'a@news.test' });
    expect(parseListUnsubscribe(null, null)).toBeNull();
  });

  it('stores the header only when the message passed aligned authentication', async () => {
    const t = await setup();
    const ok = await deliver(t.address, { headers: { ...HDR, ...PASS } });
    expect((await messageOf(ok.threadId!)).unsub_json).toContain('https://news.test/u/abc');
    const bad = await deliver(t.address, { subject: 'Spoofed', headers: { ...HDR, ...FAIL } });
    expect((await messageOf(bad.threadId!)).unsub_json).toBeNull();
    const none = await deliver(t.address, { subject: 'Unauthenticated', headers: HDR });
    expect((await messageOf(none.threadId!)).unsub_json).toBeNull();
    const detail = await (await call(`${t.base}/threads/${ok.threadId}`, { cookie: t.user.cookie })).json<ThreadDetail>();
    expect(detail.messages[0].unsubscribe).toEqual({ method: 'one_click', host: 'news.test', url: 'https://news.test/u/abc?x=1' });
  });
});

describe('unsubscribe action', () => {
  const unsub = (t: Ctx, id: string, body: unknown = {}) => call(`${t.base}/messages/${id}/unsubscribe`, { body, cookie: t.user.cookie });

  it('one-click POSTs only the stored URL (never one from the client), https only, without following redirects', async () => {
    const t = await setup();
    const out = await deliver(t.address, { headers: { ...HDR, ...PASS } });
    const msg = await messageOf(out.threadId!);
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(null, { status: 202 });
    });
    const res = await unsub(t, msg.id, { blockSender: true, url: 'https://evil.test/steal', mailto: 'evil@evil.test' });
    expect(res.status).toBe(200);
    expect(await res.json<UnsubscribeResponse>()).toEqual({ method: 'one_click', ok: true, blocked: true, url: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://news.test/u/abc?x=1');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.redirect).toBe('manual');
    expect(calls[0].init.body).toBe('List-Unsubscribe=One-Click');
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    const blocked = await env.DB.prepare('SELECT pattern FROM blocked_senders WHERE mailbox_id = ?').bind(t.mb.id).all<{ pattern: string }>();
    expect(blocked.results.map((r) => r.pattern)).toEqual(['news@news.test']);

    // A redirect or an error answer is a failure, not followed.
    vi.stubGlobal('fetch', async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }));
    expect((await (await unsub(t, msg.id)).json<UnsubscribeResponse>()).ok).toBe(false);
    vi.stubGlobal('fetch', async () => { throw new Error('timeout'); });
    expect((await (await unsub(t, msg.id)).json<UnsubscribeResponse>()).ok).toBe(false);
  });

  it('sends the mailto email from the mailbox and counts it', async () => {
    const t = await setup();
    const out = await deliver(t.address, { headers: { 'List-Unsubscribe': '<mailto:unsub@news.test?subject=Remove%20me>, <https://news.test/u/1>', ...PASS } });
    const msg = await messageOf(out.threadId!);
    const sent: { from: unknown; to: string; subject: string }[] = [];
    const e = withEnv({ EMAIL: { send: async (b: { from: unknown; to: string; subject: string }) => { sent.push(b); return { messageId: '<x@test>' }; } } as unknown as SendEmail });
    const before = (await sendingStatus(env.DB, Date.now())).sentToday;
    const res = await call(`${t.base}/messages/${msg.id}/unsubscribe`, { body: {}, cookie: t.user.cookie, env: e });
    expect(await res.json<UnsubscribeResponse>()).toEqual({ method: 'mailto', ok: true, blocked: false, url: null });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('unsub@news.test');
    expect(sent[0].subject).toBe('Remove me');
    expect(sent[0].from).toBe(t.address);
    expect((await sendingStatus(env.DB, Date.now())).sentToday).toBe(before + 1);
  });

  it('a mailto send that fails reports ok: false and counts nothing', async () => {
    const t = await setup();
    const out = await deliver(t.address, { headers: { 'List-Unsubscribe': '<mailto:unsub@news.test>', ...PASS } });
    const msg = await messageOf(out.threadId!);
    const e = withEnv({ EMAIL: { send: async () => { throw Object.assign(new Error('raw'), { code: 'E_SENDER_NOT_VERIFIED' }); } } as unknown as SendEmail });
    const before = (await sendingStatus(env.DB, Date.now())).sentToday;
    const res = await call(`${t.base}/messages/${msg.id}/unsubscribe`, { body: {}, cookie: t.user.cookie, env: e });
    expect((await res.json<UnsubscribeResponse>()).ok).toBe(false);
    expect((await sendingStatus(env.DB, Date.now())).sentToday).toBe(before);
  });

  it('link-only messages return the https URL for the browser and do nothing server-side', async () => {
    const t = await setup();
    const out = await deliver(t.address, { headers: { 'List-Unsubscribe': '<https://news.test/u/9>', ...PASS } });
    const msg = await messageOf(out.threadId!);
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    const res = await unsub(t, msg.id);
    expect(await res.json<UnsubscribeResponse>()).toEqual({ method: 'link', ok: true, blocked: false, url: 'https://news.test/u/9' });
    expect(fetched).not.toHaveBeenCalled();
  });

  it('is member-only, 404s without stored data, and is rate-limited per user', async () => {
    const t = await setup();
    const out = await deliver(t.address, { headers: { ...HDR, ...PASS } });
    const plain = await deliver(t.address, { subject: 'Plain' });
    const msg = await messageOf(out.threadId!);
    const stranger = await createUser();
    expect((await call(`${t.base}/messages/${msg.id}/unsubscribe`, { body: {}, cookie: stranger.cookie })).status).toBe(404);
    expect((await unsub(t, (await messageOf(plain.threadId!)).id)).status).toBe(404);
    vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }));
    for (let i = 0; i < 30; i++) await hit(env.DB, `unsub:${t.user.id}`, HOUR);
    expect((await unsub(t, msg.id)).status).toBe(429);
  });
});

// ---------- reply templates ----------

describe('reply templates', () => {
  it('members share create, read, update and delete; HTML is sanitised on the way in', async () => {
    const owner = await createUser();
    const member = await createUser();
    const address = `${randomLocal('sup')}@extras.test`;
    const mb = await createMailbox(address, [{ userId: owner.id }, { userId: member.id, role: 'member' }]);
    const base = `/api/mailboxes/${mb.id}/templates`;
    const dirty = '<p onclick="x()">Hi <b>there</b></p><script>alert(1)</script><a href="javascript:alert(1)">x</a><a href="https://ok.test/p">ok</a><img src="https://i.test/a.png" onerror="y()">';
    const created = await call(base, { body: { name: 'Greeting', subject: 'Re: your question', bodyHtml: dirty }, cookie: owner.cookie });
    expect(created.status).toBe(201);
    const tpl = await created.json<ReplyTemplate>();
    expect(tpl.bodyHtml).not.toMatch(/script|onclick|onerror|javascript:/i);
    expect(tpl.bodyHtml).toContain('<b>there</b>');
    expect(tpl.bodyHtml).toContain('href="https://ok.test/p"');

    const list = await (await call(base, { cookie: member.cookie })).json<ReplyTemplate[]>();
    expect(list.map((x) => x.name)).toEqual(['Greeting']);
    const upd = await call(`${base}/${tpl.id}`, { method: 'PATCH', body: { name: 'Greeting 2', subject: '', bodyHtml: '<p>Hello</p>' }, cookie: member.cookie });
    expect(upd.status).toBe(200);
    expect((await upd.json<ReplyTemplate>()).name).toBe('Greeting 2');
    expect((await call(`${base}/${tpl.id}`, { method: 'DELETE', cookie: member.cookie })).status).toBe(200);
    expect(await (await call(base, { cookie: owner.cookie })).json()).toEqual([]);
  });

  it('a non-member gets 404 on every route and cannot touch another mailbox’s template', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const mb = await createMailbox(`${randomLocal('sup')}@extras.test`, [{ userId: owner.id }]);
    const other = await createMailbox(`${randomLocal('sup')}@extras.test`, [{ userId: stranger.id }]);
    const base = `/api/mailboxes/${mb.id}/templates`;
    const tpl = await (await call(base, { body: { name: 'Secret', subject: '', bodyHtml: '<p>x</p>' }, cookie: owner.cookie })).json<ReplyTemplate>();
    expect((await call(base, { cookie: stranger.cookie })).status).toBe(404);
    expect((await call(base, { body: { name: 'n', subject: '', bodyHtml: '' }, cookie: stranger.cookie })).status).toBe(404);
    expect((await call(`${base}/${tpl.id}`, { method: 'PATCH', body: { name: 'n', subject: '', bodyHtml: '' }, cookie: stranger.cookie })).status).toBe(404);
    expect((await call(`${base}/${tpl.id}`, { method: 'DELETE', cookie: stranger.cookie })).status).toBe(404);
    // Through a mailbox they do belong to, the id is not found either.
    const via = `/api/mailboxes/${other.id}/templates/${tpl.id}`;
    expect((await call(via, { method: 'PATCH', body: { name: 'n', subject: '', bodyHtml: '' }, cookie: stranger.cookie })).status).toBe(404);
    expect((await call(via, { method: 'DELETE', cookie: stranger.cookie })).status).toBe(404);
    expect((await call(`/api/mailboxes/${mb.id}/templates`, { cookie: stranger.cookie, csrf: false })).status).toBe(404);
    expect((await (await call(base, { cookie: owner.cookie })).json<ReplyTemplate[]>())).toHaveLength(1);
  });

  it('validates input', async () => {
    const owner = await createUser();
    const mb = await createMailbox(`${randomLocal('sup')}@extras.test`, [{ userId: owner.id }]);
    const res = await call(`/api/mailboxes/${mb.id}/templates`, { body: { name: '  ', subject: '', bodyHtml: '' }, cookie: owner.cookie });
    expect(res.status).toBe(400);
  });
});
