import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MessageFull, Page, ThreadDetail, ThreadSummary } from '../src/shared/api';
import { ulid } from '../src/shared/ulid';
import worker from '../src/worker/index';
import { processInbound } from '../src/worker/inbound/handler';
import { randomBytes, sha256Hex, toBase64Url } from '../src/worker/lib/crypto';
import { BASE, buildEml, call, createMailbox, fakeEmail, randomLocal } from './helpers';

const DOMAIN = 'perf.test';
const s = {
  alice: '', bob: '', aliceId: '', bobId: '', aliceSession: '',
  mbA: '', mbB: '', foldersA: {} as Record<string, string>, threadA: '', threadB: '', addrA: '', addrB: '',
};

async function makeUser(name: string): Promise<{ id: string; cookie: string; sessionId: string }> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare('INSERT INTO users (id, email, name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, `${randomLocal(name)}@${DOMAIN}`, name, 'x', 'member', now, now).run();
  const token = toBase64Url(randomBytes(32));
  const sessionId = ulid();
  await env.DB.prepare('INSERT INTO sessions (id, token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(sessionId, await sha256Hex(token), id, now, now, now + 3600_000).run();
  return { id, cookie: `cirrus_session=${token}`, sessionId };
}

async function deliver(to: string, subject: string, body = 'Hello there') {
  const out = await processInbound(fakeEmail('sender@vendor.test', to, buildEml({ from: 'Sender <sender@vendor.test>', to, subject, body })), env);
  expect(out.accepted).toBe(true);
}

/** D1 round trips reported by Server-Timing (`d1;dur=…;desc="N"`). */
function d1Trips(res: Response): number {
  const m = (res.headers.get('server-timing') ?? '').match(/d1;dur=[\d.]+;desc="(\d+)"/);
  if (!m) throw new Error(`no d1 timing in ${res.headers.get('server-timing')}`);
  return Number(m[1]);
}

function r2Ops(res: Response): number {
  const m = (res.headers.get('server-timing') ?? '').match(/r2;dur=[\d.]+;desc="(\d+)"/);
  return m ? Number(m[1]) : -1;
}

beforeAll(async () => {
  const a = await makeUser('alice');
  const b = await makeUser('bob');
  s.alice = a.cookie; s.aliceId = a.id; s.aliceSession = a.sessionId;
  s.bob = b.cookie; s.bobId = b.id;
  s.addrA = `${randomLocal('a')}@${DOMAIN}`;
  s.addrB = `${randomLocal('b')}@${DOMAIN}`;
  const mA = await createMailbox(s.addrA, [{ userId: a.id }]);
  const mB = await createMailbox(s.addrB, [{ userId: b.id }]);
  s.mbA = mA.id; s.foldersA = mA.folders; s.mbB = mB.id;
  await deliver(s.addrA, 'Quarterly numbers');
  await deliver(s.addrA, 'Second thread');
  await deliver(s.addrB, 'Bob only');
  const listA = await (await call(`/api/mailboxes/${s.mbA}/threads`, { cookie: s.alice })).json<Page<ThreadSummary>>();
  s.threadA = listA.items[0].id;
  const listB = await (await call(`/api/mailboxes/${s.mbB}/threads`, { cookie: s.bob })).json<Page<ThreadSummary>>();
  s.threadB = listB.items[0].id;
});

describe('round trips per request (Server-Timing)', () => {
  it('reports total, d1 and r2 on every /api response, including errors', async () => {
    const ok = await call('/api/setup/status');
    expect(ok.headers.get('server-timing')).toMatch(/^total;dur=[\d.]+, d1;dur=[\d.]+;desc="1", r2;dur=[\d.]+;desc="0"$/);
    const missing = await call('/api/nope');
    expect(missing.status).toBe(404);
    expect(d1Trips(missing)).toBe(0);
  });

  it('GET /me, folders, threads, thread detail and poll are each one D1 round trip', async () => {
    const me = await call('/api/me', { cookie: s.alice });
    expect(me.status).toBe(200);
    expect(d1Trips(me)).toBe(1);
    const mailboxes = (await me.json<{ mailboxes: { id: string; unread: number }[] }>()).mailboxes;
    expect(mailboxes).toEqual([expect.objectContaining({ id: s.mbA, unread: 2 })]);

    const folders = await call(`/api/mailboxes/${s.mbA}/folders`, { cookie: s.alice });
    expect(d1Trips(folders)).toBe(1);
    const inbox = (await folders.json<{ role: string; total: number; unread: number }[]>()).find((f) => f.role === 'inbox');
    expect(inbox).toMatchObject({ total: 2, unread: 2 });

    const threads = await call(`/api/mailboxes/${s.mbA}/threads`, { cookie: s.alice });
    expect(d1Trips(threads)).toBe(1);
    const page = await threads.json<Page<ThreadSummary>>();
    expect(page.items.map((t) => t.subject)).toEqual(['Second thread', 'Quarterly numbers']);
    expect(page.items[0].folderIds).toEqual([s.foldersA.inbox]);

    const byFolder = await call(`/api/mailboxes/${s.mbA}/threads?folder=${s.foldersA.inbox}`, { cookie: s.alice });
    expect(d1Trips(byFolder)).toBe(1);
    expect((await byFolder.json<Page<ThreadSummary>>()).items).toHaveLength(2);

    const detail = await call(`/api/mailboxes/${s.mbA}/threads/${s.threadA}`, { cookie: s.alice });
    expect(d1Trips(detail)).toBe(1);
    expect(r2Ops(detail)).toBe(1);
    const d = await detail.json<ThreadDetail>();
    expect(d.thread).toMatchObject({ id: s.threadA, folderIds: [s.foldersA.inbox], messageCount: 1 });
    expect(d.messages[0].text).toContain('Hello there');

    const poll = await call(`/api/mailboxes/${s.mbA}/poll?since=${Date.now() + 1000}`, { cookie: s.alice });
    expect(d1Trips(poll)).toBe(1);
    expect(await poll.json()).toEqual({ newCount: 0, latest: [] });
    const pollAll = await call(`/api/mailboxes/${s.mbA}/poll?since=0`, { cookie: s.alice });
    expect(d1Trips(pollAll)).toBe(1);
    const p = await pollAll.json<{ newCount: number; latest: ThreadSummary[] }>();
    expect(p.newCount).toBe(2);
    expect(p.latest.map((t) => t.id)).toContain(s.threadA);
  });

  it('a thread action is two round trips and a draft save three', async () => {
    const read = await call(`/api/mailboxes/${s.mbA}/threads/actions`, { body: { threadIds: [s.threadA], action: 'read' }, cookie: s.alice });
    expect(read.status).toBe(200);
    expect(d1Trips(read)).toBe(2);
    const t = await env.DB.prepare('SELECT unread_count FROM threads WHERE id = ?').bind(s.threadA).first<number>('unread_count');
    expect(t).toBe(0);
    await call(`/api/mailboxes/${s.mbA}/threads/actions`, { body: { threadIds: [s.threadA], action: 'unread' }, cookie: s.alice });

    const created = await (await call(`/api/mailboxes/${s.mbA}/drafts`, { body: { from: s.addrA, to: [], cc: [], bcc: [], subject: 'Draft one', html: '<p>v1</p>' }, cookie: s.alice })).json<MessageFull>();
    const saved = await call(`/api/mailboxes/${s.mbA}/drafts/${created.id}`, { method: 'PUT', body: { from: s.addrA, to: [{ email: 'x@vendor.test' }], cc: [], bcc: [], subject: 'Draft two', html: '<p>v2</p>' }, cookie: s.alice });
    expect(saved.status).toBe(200);
    expect(d1Trips(saved)).toBe(3);
    expect(r2Ops(saved)).toBe(1);
    const m = await saved.json<MessageFull>();
    expect(m).toMatchObject({ id: created.id, subject: 'Draft two', html: '<p>v2</p>', status: 'draft', to: [{ email: 'x@vendor.test' }] });
    expect(m.text).toContain('v2');
    // The Drafts listing still shows the draft's own subject and recipients.
    const drafts = await (await call(`/api/mailboxes/${s.mbA}/threads?folder=${s.foldersA.drafts}`, { cookie: s.alice })).json<Page<ThreadSummary>>();
    expect(drafts.items[0]).toMatchObject({ subject: 'Draft two', participants: [{ email: 'x@vendor.test' }] });
    const again = await (await call(`/api/mailboxes/${s.mbA}/threads/${m.threadId}`, { cookie: s.alice })).json<ThreadDetail>();
    expect(again.messages[0]).toMatchObject({ html: '<p>v2</p>', subject: 'Draft two' });
    await call(`/api/mailboxes/${s.mbA}/drafts/${created.id}`, { method: 'DELETE', cookie: s.alice });
  });

  it('an unknown folder in the listing is still a 404', async () => {
    const res = await call(`/api/mailboxes/${s.mbA}/threads?folder=${ulid()}`, { cookie: s.alice });
    expect(res.status).toBe(404);
    expect((await res.json<{ error: { message: string } }>()).error.message).toBe('Folder not found');
  });
});

describe('authorization on the batched queries (IDOR regressions)', () => {
  const reads = () => [
    `/api/mailboxes/${s.mbA}/folders`,
    `/api/mailboxes/${s.mbA}/threads`,
    `/api/mailboxes/${s.mbA}/threads?folder=${s.foldersA.inbox}`,
    `/api/mailboxes/${s.mbA}/threads?q=Quarterly`,
    `/api/mailboxes/${s.mbA}/threads/${s.threadA}`,
    `/api/mailboxes/${s.mbA}/poll?since=0`,
  ];

  it("another user's valid session gets 404 and no data from A's mailbox", async () => {
    for (const path of reads()) {
      const res = await call(path, { cookie: s.bob });
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({ error: { code: 'NOT_FOUND', message: 'Mailbox not found' } });
    }
    // A's thread id through B's own mailbox finds nothing.
    expect((await call(`/api/mailboxes/${s.mbB}/threads/${s.threadA}`, { cookie: s.bob })).status).toBe(404);
    const me = await (await call('/api/me', { cookie: s.bob })).json<{ mailboxes: { id: string }[] }>();
    expect(me.mailboxes.map((m) => m.id)).toEqual([s.mbB]);
  });

  it('no session, an expired session or a disabled user gets 401', async () => {
    for (const path of [...reads(), '/api/me']) expect((await call(path)).status, path).toBe(401);
    const expired = await makeUser('carol');
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, expired.sessionId).run();
    await env.DB.prepare('INSERT INTO mailbox_members (mailbox_id, user_id, role) VALUES (?, ?, ?)').bind(s.mbA, expired.id, 'member').run();
    const disabled = await makeUser('dave');
    await env.DB.prepare('UPDATE users SET disabled = 1 WHERE id = ?').bind(disabled.id).run();
    await env.DB.prepare('INSERT INTO mailbox_members (mailbox_id, user_id, role) VALUES (?, ?, ?)').bind(s.mbA, disabled.id, 'member').run();
    for (const cookie of [expired.cookie, disabled.cookie]) {
      for (const path of [...reads(), '/api/me']) expect((await call(path, { cookie })).status, path).toBe(401);
      expect((await call(`/api/mailboxes/${s.mbA}/threads/actions`, { body: { threadIds: [s.threadA], action: 'read' }, cookie })).status).toBe(401);
    }
  });

  it("actions through B's mailbox never touch A's threads, even mixed with B's own", async () => {
    const before = await env.DB.prepare('SELECT unread_count, folder_id FROM threads t JOIN messages m ON m.thread_id = t.id WHERE t.id = ?').bind(s.threadA).first();
    for (const action of ['read', 'archive', 'trash', 'spam', 'star']) {
      const only = await call(`/api/mailboxes/${s.mbB}/threads/actions`, { body: { threadIds: [s.threadA], action }, cookie: s.bob });
      expect(only.status, action).toBe(404);
    }
    const mixed = await call(`/api/mailboxes/${s.mbB}/threads/actions`, { body: { threadIds: [s.threadB, s.threadA], action: 'read' }, cookie: s.bob });
    expect(mixed.status).toBe(200);
    const after = await env.DB.prepare('SELECT unread_count, folder_id FROM threads t JOIN messages m ON m.thread_id = t.id WHERE t.id = ?').bind(s.threadA).first();
    expect(after).toEqual(before);
    expect(await env.DB.prepare('SELECT unread_count FROM threads WHERE id = ?').bind(s.threadB).first<number>('unread_count')).toBe(0);
    // A's mailbox via A's thread id from a non-member: 404 before any write.
    expect((await call(`/api/mailboxes/${s.mbA}/threads/actions`, { body: { threadIds: [s.threadA], action: 'trash' }, cookie: s.bob })).status).toBe(404);
  });
});

describe('sessions and caching headers', () => {
  it('touches a stale session off the critical path and re-issues the cookie', async () => {
    const old = Date.now() - 10 * 60 * 1000;
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(old, s.aliceSession).run();
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    const res = await worker.fetch(new Request(`${BASE}/api/mailboxes/${s.mbA}/poll?since=0`, { headers: { cookie: s.alice } }) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/cirrus_session=/);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    const seen = await env.DB.prepare('SELECT last_seen_at FROM sessions WHERE id = ?').bind(s.aliceSession).first<number>('last_seen_at');
    expect(seen).toBeGreaterThan(old);
  });

  it('API JSON is no-store and signed attachment URLs are immutable', async () => {
    const res = await call(`/api/mailboxes/${s.mbA}/threads`, { cookie: s.alice });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const to = s.addrA;
    const raw = buildEml({ from: 'x@vendor.test', to, subject: 'With file', body: 'see file', attachments: [{ filename: 'a.txt', type: 'text/plain', content: new TextEncoder().encode('hi') }] });
    await processInbound(fakeEmail('x@vendor.test', to, raw), env);
    const page = await (await call(`/api/mailboxes/${s.mbA}/threads`, { cookie: s.alice })).json<Page<ThreadSummary>>();
    const detail = await (await call(`/api/mailboxes/${s.mbA}/threads/${page.items[0].id}`, { cookie: s.alice })).json<ThreadDetail>();
    const url = new URL(detail.messages[0].attachments[0].url);
    const file = await call(url.pathname + url.search);
    expect(file.status).toBe(200);
    expect(file.headers.get('cache-control')).toBe('private, max-age=3600, immutable');
  });
});
