import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { ulid } from '../src/shared/ulid';
import { hourlyMaintenance } from '../src/worker/cron';
import { normalizeAppPassword } from '../src/worker/dav/auth';
import { processInbound } from '../src/worker/inbound/handler';
import { eventStream } from '../src/worker/jmap/handler';
import { deleteMessagesForever } from '../src/worker/lib/db';
import { hashPassword, sha256Hex } from '../src/worker/lib/crypto';
import { utcDay } from '../src/worker/lib/sendcount';
import worker from '../src/worker/index';
import { BASE, buildEml, call, createMailbox, ctx, fakeEmail, randomLocal, sessionCookie, withEnv } from './helpers';

const DOMAIN = 'jmap.test';
const PASSWORD = 'admin-password-123';
const basic = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;

interface Who { id: string; email: string; secret: string; auth: string; bearer: string; mb: string; addr: string; folders: Record<string, string> }
const A = {} as Who;
const B = {} as Who;

async function mkWho(name: string): Promise<Who> {
  const id = ulid();
  const email = `${randomLocal(name)}@${DOMAIN}`;
  const now = Date.now();
  await env.DB.prepare('INSERT INTO users (id, email, name, password_hash, role, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
    .bind(id, email, name, await hashPassword(PASSWORD), 'member', now, now).run();
  const secret = ulid().toLowerCase().slice(0, 24);
  await env.DB.prepare('INSERT INTO app_passwords (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(ulid(), id, 'test', await sha256Hex(normalizeAppPassword(secret)), now).run();
  const addr = `${randomLocal('box')}@${DOMAIN}`;
  const mb = await createMailbox(addr, [{ userId: id }]);
  return { id, email, secret, auth: basic(email, secret), bearer: `Bearer ${secret}`, mb: mb.id, addr, folders: mb.folders };
}

interface ReqOpts { auth?: string | null; headers?: Record<string, string>; env?: Env; body?: BodyInit | null; ip?: string }
function req(method: string, path: string, o: ReqOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { ...o.headers };
  const auth = o.auth === undefined ? A.auth : o.auth;
  if (auth) headers.authorization = auth;
  if (o.ip) headers['cf-connecting-ip'] = o.ip;
  return worker.fetch(new Request(BASE + path, { method, headers, body: o.body }) as Request<unknown, IncomingRequestCfProperties>, o.env ?? env, ctx);
}

type Call = [string, Record<string, unknown>, string];
type Resp = [string, Record<string, any>, string];
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission', 'urn:ietf:params:jmap:vacationresponse'];

async function jmap(calls: Call[], o: ReqOpts = {}): Promise<Resp[]> {
  const res = await req('POST', '/jmap/api', { ...o, headers: { 'content-type': 'application/json', ...o.headers }, body: JSON.stringify({ using: USING, methodCalls: calls }) });
  expect(res.status).toBe(200);
  return (await res.json<{ methodResponses: Resp[] }>()).methodResponses;
}
const one = async (name: string, args: Record<string, unknown>, o: ReqOpts = {}) => (await jmap([[name, { accountId: A.mb, ...args }, 'c']], o))[0][1];

async function deliver(who: Who, subject: string, extra: { body?: string; inReplyTo?: string; messageId?: string; from?: string } = {}): Promise<string> {
  const out = await processInbound(fakeEmail('sender@vendor.test', who.addr, buildEml({
    from: extra.from ?? 'Sender <sender@vendor.test>', to: who.addr, subject, body: extra.body ?? 'Hello there', inReplyTo: extra.inReplyTo, messageId: extra.messageId,
  })), env);
  expect(out.accepted).toBe(true);
  return (out as { messageId: string }).messageId;
}

const cookieFor = async (w: Who) => sessionCookie(await call('/api/auth/login', { body: { email: w.email, password: PASSWORD } }));

beforeAll(async () => {
  Object.assign(A, await mkWho('alice'));
  Object.assign(B, await mkWho('bob'));
});

describe('session and auth', () => {
  it('redirects the well-known URL and serves the session with limits and only our accounts', async () => {
    const wk = await req('GET', '/.well-known/jmap', { auth: null });
    expect(wk.status).toBe(301);
    expect(wk.headers.get('location')).toBe('/jmap/session');
    const res = await req('GET', '/jmap/session');
    expect(res.status).toBe(200);
    const s = await res.json<any>();
    expect(Object.keys(s.accounts)).toEqual([A.mb]);
    expect(s.accounts[A.mb]).toMatchObject({ isPersonal: true, isReadOnly: false, name: A.addr });
    expect(s.primaryAccounts['urn:ietf:params:jmap:mail']).toBe(A.mb);
    expect(s.capabilities['urn:ietf:params:jmap:core']).toMatchObject({ maxCallsInRequest: 16, maxObjectsInGet: 500, maxObjectsInSet: 500, maxSizeRequest: 10 * 1024 * 1024 });
    expect(s.username).toBe(A.email);
    expect(s.apiUrl).toBe(`${BASE}/jmap/api`);
    expect(s.downloadUrl).toContain('{accountId}/{blobId}/{name}');
  });

  it('accepts an app password as Basic or Bearer; rejects the login password and the session cookie', async () => {
    expect((await req('GET', '/jmap/session', { auth: A.bearer })).status).toBe(200);
    expect((await req('GET', '/jmap/session', { auth: A.bearer.toUpperCase().replace('BEARER', 'Bearer') })).status).toBe(200);
    const pw = await req('GET', '/jmap/session', { auth: basic(A.email, PASSWORD) });
    expect(pw.status).toBe(401);
    expect(pw.headers.get('www-authenticate')).toMatch(/^Basic /);
    expect((await req('GET', '/jmap/session', { auth: `Bearer ${PASSWORD}` })).status).toBe(401);
    const cookie = await cookieFor(A);
    expect((await req('GET', '/jmap/session', { auth: null, headers: { cookie } })).status).toBe(401);
    expect((await req('POST', '/jmap/api', { auth: null, headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await req('GET', '/jmap/session', { auth: null })).status).toBe(401);
  });

  it('shares the DAV failure counters (per-IP lockout also covers Bearer)', async () => {
    for (let i = 0; i < 30; i++) await req('GET', '/jmap/session', { auth: `Bearer wrong${i}`, ip: '10.9.9.9' });
    expect((await req('GET', '/jmap/session', { auth: A.bearer, ip: '10.9.9.9' })).status).toBe(429);
  });

  it('allows CORS only for origins on the allowlist', async () => {
    const origin = 'https://app.example.test';
    const none = await req('GET', '/jmap/session', { headers: { origin } });
    expect(none.headers.get('access-control-allow-origin')).toBeNull();
    expect((await req('OPTIONS', '/jmap/api', { auth: null, headers: { origin } })).headers.get('access-control-allow-origin')).toBeNull();
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('jmap_cors_origins', ?)").bind(`${origin}, https://other.test`).run();
    const ok = await req('GET', '/jmap/session', { headers: { origin } });
    expect(ok.headers.get('access-control-allow-origin')).toBe(origin);
    const pre = await req('OPTIONS', '/jmap/api', { auth: null, headers: { origin } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toContain('authorization');
    expect((await req('GET', '/jmap/session', { headers: { origin: 'https://evil.test' } })).headers.get('access-control-allow-origin')).toBeNull();
    await env.DB.prepare("DELETE FROM settings WHERE key = 'jmap_cors_origins'").run();
  });

  it('enforces request limits and method errors', async () => {
    const many = Array.from({ length: 17 }, (_, i): Call => ['Core/echo', { i }, `c${i}`]);
    const res = await req('POST', '/jmap/api', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ using: USING, methodCalls: many }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ type: 'urn:ietf:params:jmap:error:limit', limit: 'maxCallsInRequest' });
    const badCap = await req('POST', '/jmap/api', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ using: ['urn:nope'], methodCalls: [] }) });
    expect((await badCap.json<any>()).type).toBe('urn:ietf:params:jmap:error:unknownCapability');
    const notJson = await req('POST', '/jmap/api', { headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect((await notJson.json<any>()).type).toBe('urn:ietf:params:jmap:error:notJSON');
    const big = await req('POST', '/jmap/api', { headers: { 'content-type': 'application/json', 'content-length': String(11 * 1024 * 1024) }, body: '{}' });
    expect(big.status).toBe(413);
    const r = await jmap([['Core/echo', { hello: 1 }, 'a'], ['Nope/get', {}, 'b'], ['Email/get', { accountId: 'zzz', ids: [] }, 'c'], ['Email/get', { accountId: B.mb, ids: [] }, 'd']]);
    expect(r[0]).toEqual(['Core/echo', { hello: 1 }, 'a']);
    expect(r[1][1].type).toBe('unknownMethod');
    expect(r[2][1].type).toBe('accountNotFound');
    expect(r[3][1].type).toBe('accountNotFound');
    const ids = Array.from({ length: 501 }, (_, i) => `x${i}`);
    expect((await one('Email/get', { ids })).type).toBe('requestTooLarge');
  });
});

describe('Mailbox', () => {
  it('maps folder roles and exposes labels without a role; counts follow the data', async () => {
    const cookie = await cookieFor(A);
    const label = await (await call(`/api/mailboxes/${A.mb}/labels`, { cookie, body: { name: 'Receipts', color: 'teal' } })).json<{ id: string }>();
    await deliver(A, 'Counted');
    const r = await one('Mailbox/get', { ids: null });
    const byId = new Map<string, any>(r.list.map((m: any) => [m.id, m]));
    expect(byId.get(A.folders.inbox)).toMatchObject({ role: 'inbox', totalEmails: 1, unreadEmails: 1, totalThreads: 1, unreadThreads: 1 });
    expect(byId.get(A.folders.sent).role).toBe('sent');
    expect(byId.get(A.folders.drafts).role).toBe('drafts');
    expect(byId.get(A.folders.trash).role).toBe('trash');
    expect(byId.get(A.folders.spam).role).toBe('junk');
    expect(byId.get(A.folders.archive).role).toBe('archive');
    expect(byId.get(label.id)).toMatchObject({ name: 'Receipts', role: null, cirrusKind: 'label', parentId: null });
    expect(byId.get(A.folders.inbox).myRights.mayDelete).toBe(false);
    const q = await one('Mailbox/query', { filter: { role: 'inbox' } });
    expect(q.ids).toEqual([A.folders.inbox]);
  });

  it('creates, renames and destroys custom folders and labels; system ones are protected', async () => {
    const r = await one('Mailbox/set', {
      create: { f: { name: 'Projects' }, l: { name: 'Urgent', cirrusKind: 'label', cirrusColor: 'red' }, bad: { name: 'x', role: 'inbox' }, sub: { name: 'y', parentId: A.folders.inbox } },
    });
    expect(r.created.f.id).toBeTruthy();
    expect(r.created.l.id).toBeTruthy();
    expect(r.notCreated.bad.type).toBe('invalidProperties');
    expect(r.notCreated.sub.type).toBe('invalidProperties');
    const dup = await one('Mailbox/set', { create: { d: { name: 'Projects' } } });
    expect(dup.notCreated.d.type).toBe('invalidProperties');
    const up = await one('Mailbox/set', { update: { [r.created.f.id]: { name: 'Work' }, [A.folders.inbox]: { name: 'Mine' } } });
    expect(up.updated[r.created.f.id]).toBeNull();
    expect(up.notUpdated[A.folders.inbox].type).toBe('forbidden');
    const names = (await one('Mailbox/get', { ids: [r.created.f.id] })).list[0].name;
    expect(names).toBe('Work');
    const del = await one('Mailbox/set', { destroy: [A.folders.trash, r.created.f.id, r.created.l.id, 'nope'] });
    expect(del.destroyed.sort()).toEqual([r.created.f.id, r.created.l.id].sort());
    expect(del.notDestroyed[A.folders.trash].type).toBe('forbidden');
    expect(del.notDestroyed.nope.type).toBe('notFound');
  });
});

describe('Email/query and Email/get', () => {
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    ids.first = await deliver(B, 'Budget review', { body: 'Quarterly numbers attached', messageId: '<budget-1@vendor.test>' });
  });

  it('filters, sorts, paginates and collapses threads', async () => {
    const W = A;
    const m1 = await deliver(W, 'Invoice 42', { body: 'Please pay', messageId: '<inv-1@vendor.test>', from: 'Billing <billing@shop.test>' });
    const m2 = await deliver(W, 'Re: Invoice 42', { body: 'Paid already', inReplyTo: '<inv-1@vendor.test>', from: 'Billing <billing@shop.test>' });
    const m3 = await deliver(W, 'Lunch plans', { body: 'Pizza on Friday', from: 'Friend <friend@home.test>' });
    const all = await one('Email/query', { filter: { inMailbox: W.folders.inbox }, calculateTotal: true });
    expect(all.total).toBeGreaterThanOrEqual(4);
    expect(all.canCalculateChanges).toBe(false);
    expect(all.ids.slice(0, 3)).toEqual([m3, m2, m1]);
    const asc = await one('Email/query', { filter: { subject: 'invoice' }, sort: [{ property: 'receivedAt', isAscending: true }] });
    expect(asc.ids).toEqual([m1, m2]);
    const collapsed = await one('Email/query', { filter: { subject: 'invoice' }, collapseThreads: true, calculateTotal: true });
    expect(collapsed.ids).toEqual([m2]);
    expect(collapsed.total).toBe(1);
    expect((await one('Email/query', { filter: { text: 'pizza' } })).ids).toEqual([m3]);
    expect((await one('Email/query', { filter: { from: 'billing@shop' } })).ids.sort()).toEqual([m1, m2].sort());
    expect((await one('Email/query', { filter: { operator: 'AND', conditions: [{ from: 'billing' }, { operator: 'NOT', conditions: [{ text: 'already' }] }] } })).ids).toEqual([m1]);
    expect((await one('Email/query', { filter: { operator: 'OR', conditions: [{ text: 'pizza' }, { text: 'already' }] }, sort: [{ property: 'receivedAt' }] })).ids).toEqual([m3, m2]);
    expect((await one('Email/query', { filter: { hasKeyword: '$seen', inMailbox: W.folders.inbox } })).ids).toEqual([]);
    expect((await one('Email/query', { filter: { notKeyword: '$seen', subject: 'lunch' } })).ids).toEqual([m3]);
    expect((await one('Email/query', { filter: { hasAttachment: true } })).ids).toEqual([]);
    expect((await one('Email/query', { filter: { after: new Date(Date.now() + 3600_000).toISOString() } })).ids).toEqual([]);
    expect((await one('Email/query', { filter: { before: new Date(Date.now() + 3600_000).toISOString(), subject: 'lunch' } })).ids).toEqual([m3]);
    const page = await one('Email/query', { filter: { inMailbox: W.folders.inbox }, position: 1, limit: 2 });
    expect(page.ids).toEqual([m2, m1]);
    expect(page.position).toBe(1);
    const anchored = await one('Email/query', { filter: { inMailbox: W.folders.inbox }, anchor: m2, anchorOffset: -1, limit: 2 });
    expect(anchored.ids).toEqual([m3, m2]);
    expect((await one('Email/query', { anchor: 'nope' })).type).toBe('anchorNotFound');
    const neg = await one('Email/query', { filter: { inMailbox: W.folders.inbox }, position: -1 });
    expect(neg.ids.length).toBe(1);
    expect((await one('Email/query', { filter: { bogus: 1 } })).type).toBe('unsupportedFilter');
    expect((await one('Email/query', { sort: [{ property: 'bogus' }] })).type).toBe('unsupportedSort');
    expect((await one('Email/queryChanges', { sinceQueryState: '0' })).type).toBe('cannotCalculateChanges');
    // inMailboxOtherThan: everything here is in the inbox only.
    expect((await one('Email/query', { filter: { inMailboxOtherThan: [W.folders.inbox], subject: 'lunch' } })).ids).toEqual([]);
    expect((await one('Email/query', { filter: { inMailboxOtherThan: [W.folders.trash], subject: 'lunch' } })).ids).toEqual([m3]);
  });

  it('returns properties, body structure and truncated body values', async () => {
    const id = await deliver(A, 'Props check', { body: 'héllo wörld, this is a longer body', messageId: '<props-1@vendor.test>', from: 'Dana D <dana@props.test>' });
    const r = await one('Email/get', {
      ids: [id, 'missing'], properties: ['id', 'blobId', 'threadId', 'mailboxIds', 'keywords', 'size', 'receivedAt', 'messageId', 'inReplyTo', 'references', 'from', 'to', 'cc', 'bcc', 'replyTo',
        'subject', 'sentAt', 'preview', 'hasAttachment', 'bodyStructure', 'textBody', 'htmlBody', 'attachments', 'bodyValues', 'header:Subject:asText', 'header:Message-ID:asMessageIds', 'header:from:asAddresses'],
      fetchTextBodyValues: true, maxBodyValueBytes: 8,
    });
    expect(r.notFound).toEqual(['missing']);
    const e = r.list[0];
    expect(e).toMatchObject({
      id, blobId: `m_${id}`, mailboxIds: { [A.folders.inbox]: true }, keywords: {}, messageId: ['props-1@vendor.test'], inReplyTo: null, subject: 'Props check',
      from: [{ name: 'Dana D', email: 'dana@props.test' }], to: [{ name: null, email: A.addr }], hasAttachment: false, attachments: [], 'header:Subject:asText': 'Props check',
      'header:Message-ID:asMessageIds': ['props-1@vendor.test'], 'header:from:asAddresses': [{ name: 'Dana D', email: 'dana@props.test' }],
    });
    expect(e.receivedAt).toMatch(/^\d{4}-\d\d-\d\dT[\d:]+Z$/);
    expect(e.preview).toContain('héllo');
    expect(e.bodyStructure).toMatchObject({ type: 'text/plain', partId: '1', blobId: `t_${id}` });
    expect(e.textBody).toHaveLength(1);
    const v = e.bodyValues['1'];
    expect(v.isTruncated).toBe(true);
    expect(new TextEncoder().encode(v.value).length).toBeLessThanOrEqual(8);
    const full = await one('Email/get', { ids: [id], properties: ['bodyValues', 'htmlBody'], fetchTextBodyValues: true, fetchHTMLBodyValues: true });
    expect(full.list[0].bodyValues['1']).toMatchObject({ isEncodingProblem: false, isTruncated: false });
    expect(full.list[0].bodyValues['1'].value.trim()).toBe('héllo wörld, this is a longer body');
    const dflt = await one('Email/get', { ids: [id] });
    expect(dflt.list[0].bodyValues).toEqual({});
    expect(dflt.list[0].bodyStructure).toBeUndefined();
    expect((await one('Email/get', { ids: [id], properties: ['nope'] })).type).toBe('invalidArguments');
    // The raw blob is the stored message.
    const dl = await req('GET', `/jmap/download/${A.mb}/m_${id}/message.eml?accept=message/rfc822`);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toContain('Subject: Props check');
    expect(dl.headers.get('content-disposition')).toContain('attachment');
    expect(ids.first).toBeTruthy();
  });

  it('threads: Thread/get lists emails oldest first', async () => {
    const a = await deliver(A, 'Thread me', { messageId: '<thr-1@vendor.test>' });
    const b = await deliver(A, 'Re: Thread me', { inReplyTo: '<thr-1@vendor.test>' });
    const tid = (await one('Email/get', { ids: [a], properties: ['threadId'] })).list[0].threadId;
    const t = await one('Thread/get', { ids: [tid, 'nope'] });
    expect(t.list).toEqual([{ id: tid, emailIds: [a, b] }]);
    expect(t.notFound).toEqual(['nope']);
  });
});

describe('Email/set', () => {
  it('keeps keywords in step with the Cirrus API, both ways', async () => {
    const cookie = await cookieFor(A);
    const id = await deliver(A, 'Keyword sync');
    const tid = (await one('Email/get', { ids: [id], properties: ['threadId'] })).list[0].threadId;
    const set = await one('Email/set', { update: { [id]: { 'keywords/$seen': true, 'keywords/$flagged': true, 'keywords/$custom': true } } });
    expect(set.updated[id]).toBeNull();
    const detail = await (await call(`/api/mailboxes/${A.mb}/threads/${tid}`, { cookie })).json<any>();
    expect(detail.messages[0]).toMatchObject({ isRead: true, isStarred: true });
    expect(detail.thread.unreadCount).toBe(0);
    expect((await one('Email/get', { ids: [id], properties: ['keywords'] })).list[0].keywords).toEqual({ $seen: true, $flagged: true });
    await call(`/api/mailboxes/${A.mb}/threads/actions`, { cookie, body: { threadIds: [tid], action: 'unread' } });
    await call(`/api/mailboxes/${A.mb}/threads/actions`, { cookie, body: { threadIds: [tid], action: 'unstar' } });
    expect((await one('Email/get', { ids: [id], properties: ['keywords'] })).list[0].keywords).toEqual({});
    const bad = await one('Email/set', { update: { [id]: { keywords: { '$seen': false } }, nope: { 'keywords/$seen': true } } });
    expect(bad.notUpdated[id].type).toBe('invalidProperties');
    expect(bad.notUpdated.nope.type).toBe('notFound');
    const immutable = await one('Email/set', { update: { [id]: { subject: 'x' } } });
    expect(immutable.notUpdated[id]).toMatchObject({ type: 'invalidProperties', properties: ['subject'] });
  });

  it('enforces exactly one folder plus any labels in mailboxIds', async () => {
    const cookie = await cookieFor(A);
    const label = await (await call(`/api/mailboxes/${A.mb}/labels`, { cookie, body: { name: 'Tagged', color: 'amber' } })).json<{ id: string }>();
    const id = await deliver(A, 'Folder invariant');
    const cur = { [A.folders.inbox]: true };
    const res = await one('Email/set', {
      update: {
        zero: { mailboxIds: {} }, [id]: { mailboxIds: { [A.folders.inbox]: true, [A.folders.archive]: true } },
      },
    });
    expect(res.notUpdated[id]).toMatchObject({ type: 'invalidProperties', properties: ['mailboxIds'] });
    const zero = await one('Email/set', { update: { [id]: { mailboxIds: {} } } });
    expect(zero.notUpdated[id].type).toBe('invalidProperties');
    const onlyLabel = await one('Email/set', { update: { [id]: { mailboxIds: { [label.id]: true } } } });
    expect(onlyLabel.notUpdated[id].type).toBe('invalidProperties');
    const unknown = await one('Email/set', { update: { [id]: { 'mailboxIds/nonexistent': true } } });
    expect(unknown.notUpdated[id].type).toBe('invalidProperties');
    const removeFolder = await one('Email/set', { update: { [id]: { [`mailboxIds/${A.folders.inbox}`]: null } } });
    expect(removeFolder.notUpdated[id].type).toBe('invalidProperties');
    expect((await one('Email/get', { ids: [id], properties: ['mailboxIds'] })).list[0].mailboxIds).toEqual(cur);
    // Valid: add a label, then move to archive (label stays), then remove the label.
    expect((await one('Email/set', { update: { [id]: { [`mailboxIds/${label.id}`]: true } } })).updated[id]).toBeNull();
    expect((await one('Email/get', { ids: [id], properties: ['mailboxIds'] })).list[0].mailboxIds).toEqual({ [A.folders.inbox]: true, [label.id]: true });
    const lq = await one('Email/query', { filter: { inMailbox: label.id } });
    expect(lq.ids).toEqual([id]);
    expect((await one('Email/set', { update: { [id]: { [`mailboxIds/${A.folders.inbox}`]: null, [`mailboxIds/${A.folders.archive}`]: true } } })).updated[id]).toBeNull();
    expect((await one('Email/get', { ids: [id], properties: ['mailboxIds'] })).list[0].mailboxIds).toEqual({ [A.folders.archive]: true, [label.id]: true });
    const api = await (await call(`/api/mailboxes/${A.mb}/threads?folder=${A.folders.archive}`, { cookie })).json<any>();
    expect(api.items.map((t: any) => t.subject)).toContain('Folder invariant');
    expect((await one('Email/set', { update: { [id]: { mailboxIds: { [A.folders.archive]: true } } } })).updated[id]).toBeNull();
    expect((await one('Email/query', { filter: { inMailbox: label.id } })).ids).toEqual([]);
    const drafts = await one('Email/set', { update: { [id]: { mailboxIds: { [A.folders.drafts]: true } } } });
    expect(drafts.notUpdated[id].type).toBe('invalidProperties');
  });

  it('destroy moves to Trash first and deletes forever from Trash', async () => {
    const id = await deliver(A, 'Destroy me');
    const first = await one('Email/set', { destroy: [id, 'nope'] });
    expect(first.destroyed).toEqual([id]);
    expect(first.notDestroyed.nope.type).toBe('notFound');
    expect((await one('Email/get', { ids: [id], properties: ['mailboxIds'] })).list[0].mailboxIds).toEqual({ [A.folders.trash]: true });
    const second = await one('Email/set', { destroy: [id] });
    expect(second.destroyed).toEqual([id]);
    expect((await one('Email/get', { ids: [id] })).notFound).toEqual([id]);
  });

  it('creates drafts with back-references and creation ids, then sends them via EmailSubmission', async () => {
    const sent: any[] = [];
    const e = withEnv({ EMAIL: { send: async (b: unknown) => { sent.push(b); return { messageId: 'jmap-sent-1@jmap.test' }; } } as unknown as SendEmail });
    const day = utcDay(Date.now());
    const before = (await env.DB.prepare('SELECT sent FROM send_counts WHERE day = ?').bind(day).first<number>('sent')) ?? 0;
    const upload = await req('POST', `/jmap/upload/${A.mb}/`, { headers: { 'content-type': 'text/plain' }, body: 'attachment bytes' });
    expect(upload.status).toBe(201);
    const up = await upload.json<{ blobId: string; size: number; type: string; accountId: string }>();
    expect(up).toMatchObject({ accountId: A.mb, size: 16, type: 'text/plain' });

    const r = await jmap([
      ['Email/set', {
        accountId: A.mb,
        create: {
          d1: {
            mailboxIds: { [A.folders.drafts]: true }, keywords: { $draft: true }, from: [{ email: A.addr }], to: [{ name: 'Rcpt', email: 'rcpt@elsewhere.test' }, { email: 'two@elsewhere.test' }],
            cc: [{ email: 'cc@elsewhere.test' }], subject: 'From JMAP', textBody: [{ partId: 't', type: 'text/plain' }], htmlBody: [{ partId: 'h', type: 'text/html' }],
            bodyValues: { t: { value: 'plain body' }, h: { value: '<p>html body</p>' } }, attachments: [{ blobId: up.blobId, name: 'note.txt', type: 'text/plain', disposition: 'attachment' }],
          },
          bad: { mailboxIds: { [A.folders.inbox]: true }, subject: 'nope' },
        },
      }, 'e1'],
      ['EmailSubmission/set', {
        accountId: A.mb, create: { s1: { identityId: A.mb, emailId: '#d1' } },
        onSuccessUpdateEmail: { '#s1': { 'keywords/$draft': null, [`mailboxIds/${A.folders.drafts}`]: null, [`mailboxIds/${A.folders.sent}`]: true } },
      }, 's1'],
      ['Email/get', { accountId: A.mb, ids: ['#d1'], properties: ['mailboxIds', 'keywords', 'subject', 'attachments', 'messageId'] }, 'g1'],
    ], { env: e });
    expect(r[0][1].created.d1).toMatchObject({ blobId: expect.stringMatching(/^m_/), size: expect.any(Number) });
    expect(r[0][1].notCreated.bad.type).toBe('invalidProperties');
    const draftId = r[0][1].created.d1.id;
    expect(r[1][0]).toBe('EmailSubmission/set');
    expect(r[1][1].created.s1).toMatchObject({ undoStatus: 'final' });
    expect(r[2][0]).toBe('Email/set');
    expect(r[2][2]).toBe('s1');
    expect(r[2][1].updated[draftId]).toBeNull();
    expect(r[3][0]).toBe('Email/get');
    const got = r[3][1].list[0];
    expect(got.mailboxIds).toEqual({ [A.folders.sent]: true });
    expect(got.keywords).toEqual({ $seen: true });
    expect(got.attachments[0]).toMatchObject({ name: 'note.txt', type: 'text/plain', size: 16, disposition: 'attachment' });
    expect(got.messageId).toEqual(['jmap-sent-1@jmap.test']);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ subject: 'From JMAP', text: 'plain body', html: '<p>html body</p>' });
    expect(sent[0].attachments).toHaveLength(1);
    // Three recipients counted, once.
    const after = (await env.DB.prepare('SELECT sent FROM send_counts WHERE day = ?').bind(day).first<number>('sent')) ?? 0;
    expect(after).toBe(before + 3);
    // The sent mail's blob is synthesised and downloadable; the attachment blob serves the uploaded bytes.
    const raw = await req('GET', `/jmap/download/${A.mb}/m_${draftId}/x.eml`);
    expect(await raw.text()).toContain('Subject: From JMAP');
    const attId = got.attachments[0].blobId;
    expect(await (await req('GET', `/jmap/download/${A.mb}/${attId}/note.txt`)).text()).toBe('attachment bytes');
    // Sending again, or sending as someone else's address, fails cleanly.
    const again = await one('EmailSubmission/set', { create: { s: { identityId: A.mb, emailId: draftId } } }, { env: e });
    expect(again.notCreated.s.type).toBe('invalidProperties');
    expect(sent).toHaveLength(1);
  });

  it('rejects submissions that break the rules and reports quota failures', async () => {
    const d = await one('Email/set', { create: { d: { mailboxIds: { [A.folders.drafts]: true }, to: [{ email: 'x@elsewhere.test' }], subject: 'Quota', textBody: [{ partId: '1' }], bodyValues: { 1: { value: 'hi' } } } } });
    const id = d.created.d.id;
    const nobody = await one('Email/set', { create: { n: { mailboxIds: { [A.folders.drafts]: true }, subject: 'No rcpt', textBody: [{ partId: '1' }], bodyValues: { 1: { value: 'hi' } } } } });
    expect((await one('EmailSubmission/set', { create: { s: { identityId: A.mb, emailId: nobody.created.n.id } } })).notCreated.s.type).toBe('noRecipients');
    expect((await one('EmailSubmission/set', { create: { s: { identityId: 'zzz', emailId: id } } })).notCreated.s.type).toBe('invalidProperties');
    const foreignFrom = await one('Email/set', { create: { f: { mailboxIds: { [A.folders.drafts]: true }, from: [{ email: 'someone@else.test' }], subject: 'x', textBody: [{ partId: '1' }], bodyValues: { 1: { value: 'hi' } } } } });
    expect(foreignFrom.notCreated.f.type).toBe('invalidProperties');
    const quota = withEnv({ EMAIL: { send: async () => { throw Object.assign(new Error('raw'), { code: 'E_DAILY_LIMIT_EXCEEDED' }); } } as unknown as SendEmail });
    expect((await one('EmailSubmission/set', { create: { s: { identityId: A.mb, emailId: id } } }, { env: quota })).notCreated.s.type).toBe('forbiddenToSend');
  });

  it('imports an uploaded message', async () => {
    const raw = buildEml({ from: 'Import <imp@ort.test>', to: A.addr, subject: 'Imported mail', body: 'from a blob', messageId: '<imported-1@ort.test>' });
    const up = await (await req('POST', `/jmap/upload/${A.mb}/`, { headers: { 'content-type': 'message/rfc822' }, body: raw })).json<{ blobId: string }>();
    const r = await one('Email/import', {
      emails: { i1: { blobId: up.blobId, mailboxIds: { [A.folders.archive]: true }, keywords: { $seen: true }, receivedAt: '2026-01-02T03:04:05Z' }, i2: { blobId: 'u_missing', mailboxIds: { [A.folders.inbox]: true } }, i3: { blobId: up.blobId, mailboxIds: {} } },
    });
    expect(r.created.i1.id).toBeTruthy();
    expect(r.notCreated.i2.type).toBe('blobNotFound');
    expect(r.notCreated.i3.type).toBe('invalidProperties');
    const e = (await one('Email/get', { ids: [r.created.i1.id], properties: ['subject', 'keywords', 'mailboxIds', 'receivedAt', 'messageId'], })).list[0];
    expect(e).toMatchObject({ subject: 'Imported mail', keywords: { $seen: true }, mailboxIds: { [A.folders.archive]: true }, receivedAt: '2026-01-02T03:04:05Z', messageId: ['imported-1@ort.test'] });
    expect((await one('Email/query', { filter: { text: 'blob' } })).ids).toContain(r.created.i1.id);
    // Raw is the uploaded message.
    expect(await (await req('GET', `/jmap/download/${A.mb}/m_${r.created.i1.id}/a.eml`)).text()).toContain('Message-ID: <imported-1@ort.test>');
    // Someone else's upload is not importable.
    const bUp = await (await req('POST', `/jmap/upload/${B.mb}/`, { auth: B.auth, headers: { 'content-type': 'message/rfc822' }, body: raw })).json<{ blobId: string }>();
    expect((await one('Email/import', { emails: { x: { blobId: bUp.blobId, mailboxIds: { [A.folders.inbox]: true } } } })).notCreated.x.type).toBe('blobNotFound');
  });
});

describe('uploads and downloads', () => {
  it('caps uploads, refuses foreign accounts and expires uploads', async () => {
    expect((await req('POST', `/jmap/upload/${B.mb}/`, { headers: { 'content-type': 'text/plain' }, body: 'x' })).status).toBe(404);
    const big = await req('POST', `/jmap/upload/${A.mb}/`, { headers: { 'content-type': 'text/plain', 'content-length': String(51 * 1024 * 1024) }, body: 'x' });
    expect(big.status).toBe(413);
    const up = await (await req('POST', `/jmap/upload/${A.mb}/`, { headers: { 'content-type': 'text/plain' }, body: 'old' })).json<{ blobId: string }>();
    const id = up.blobId.slice(2);
    await env.DB.prepare('UPDATE jmap_uploads SET created_at = ? WHERE id = ?').bind(Date.now() - 24 * 3600_000, id).run();
    await hourlyMaintenance(env, Date.now());
    const { pruneUploads } = await import('../src/worker/jmap/blob');
    await pruneUploads(env, Date.now());
    expect(await env.DB.prepare('SELECT 1 FROM jmap_uploads WHERE id = ?').bind(id).first()).toBeNull();
    expect(await env.BUCKET.get(`jmapup/${A.mb}/${id}`)).toBeNull();
    expect((await req('GET', `/jmap/download/${A.mb}/${up.blobId}/x`)).status).toBe(404);
  });

  it("authorises downloads by account membership: another user's mailbox gives 404", async () => {
    const id = await deliver(A, 'Private');
    const mine = await req('GET', `/jmap/download/${A.mb}/m_${id}/p.eml`);
    expect(mine.status).toBe(200);
    expect(mine.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await req('GET', `/jmap/download/${A.mb}/m_${id}/p.eml`, { auth: B.auth })).status).toBe(404);
    expect((await req('GET', `/jmap/download/${B.mb}/m_${id}/p.eml`)).status).toBe(404);
    expect((await req('GET', `/jmap/download/${B.mb}/m_${id}/p.eml`, { auth: B.auth })).status).toBe(404);
    expect((await req('GET', `/jmap/download/${A.mb}/m_${id}/p.eml`, { auth: null })).status).toBe(401);
    expect((await req('GET', `/jmap/download/${A.mb}/..%2F..%2Fx/p.eml`)).status).toBe(404);
    // Members of a shared mailbox can read its blobs; others cannot.
    const shared = await createMailbox(`${randomLocal('shared')}@${DOMAIN}`, [{ userId: A.id }, { userId: B.id, role: 'member' }]);
    const session = await (await req('GET', '/jmap/session', { auth: B.auth })).json<any>();
    expect(session.accounts[shared.id].isPersonal).toBe(false);
  });
});

describe('state and changes (triggers)', () => {
  it('tracks creates, updates and deletes for Email, Thread and Mailbox', async () => {
    const W = await mkWho('carol');
    const q = (name: string, args: Record<string, unknown>) => one(name, { ...args, accountId: W.mb }, { auth: W.auth }) as Promise<any>;
    const s0 = (await q('Email/get', { ids: [] })).state;
    const t0 = (await q('Thread/get', { ids: [] })).state;
    const m0 = (await q('Mailbox/get', { ids: [W.folders.inbox] })).state;
    const first = await deliver(W, 'Change me');
    const c1 = await q('Email/changes', { sinceState: s0 });
    expect(c1).toMatchObject({ created: [first], updated: [], destroyed: [], hasMoreChanges: false, oldState: s0 });
    expect(c1.newState).not.toBe(s0);
    expect((await q('Email/get', { ids: [] })).state).toBe(c1.newState);
    const tc = await q('Thread/changes', { sinceState: t0 });
    expect(tc.created).toHaveLength(1);
    const mc = await q('Mailbox/changes', { sinceState: m0 });
    expect(mc.updatedProperties).toEqual(['totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads']);
    expect(mc.updated).toContain(W.folders.inbox);
    expect(mc.newState).not.toBe(m0);

    // An update shows as updated (not created); an unchanged column write (fts rowid, updated_at) does not.
    await env.DB.prepare('UPDATE messages SET updated_at = updated_at + 1 WHERE id = ?').bind(first).run();
    expect((await q('Email/changes', { sinceState: c1.newState })).updated).toEqual([]);
    await q('Email/set', { update: { [first]: { 'keywords/$seen': true } } });
    const c2 = await q('Email/changes', { sinceState: c1.newState });
    expect(c2).toMatchObject({ created: [], updated: [first], destroyed: [] });

    // A second message, then a hard delete: the first goes to destroyed through the tombstone.
    const second = await deliver(W, 'Another');
    const c3 = await q('Email/changes', { sinceState: c2.newState });
    expect(c3.created).toEqual([second]);
    await deleteMessagesForever(env, W.mb, [first]);
    const c4 = await q('Email/changes', { sinceState: c3.newState });
    expect(c4).toMatchObject({ created: [], updated: [], destroyed: [first] });
    const tc2 = await q('Thread/changes', { sinceState: tc.newState });
    expect(tc2.destroyed).toHaveLength(1);
    // Everything since the start, in one go: the destroyed email is reported, the live one is created.
    const all = await q('Email/changes', { sinceState: s0 });
    expect(all.created).toEqual([second]);
    expect(all.destroyed).toEqual([first]);

    // Label changes are Email changes; folder changes are Mailbox changes.
    const lbl = (await q('Mailbox/set', { create: { l: { name: 'L', cirrusKind: 'label' } } })).created.l.id;
    const mc2 = await q('Mailbox/changes', { sinceState: mc.newState });
    expect(mc2.created).toEqual([lbl]);
    expect(mc2.updatedProperties).toBeNull();
    const before = (await q('Email/get', { ids: [] })).state;
    await q('Email/set', { update: { [second]: { [`mailboxIds/${lbl}`]: true } } });
    expect((await q('Email/changes', { sinceState: before })).updated).toEqual([second]);
    await q('Mailbox/set', { destroy: [lbl], onDestroyRemoveEmails: true });
    expect((await q('Mailbox/changes', { sinceState: mc2.newState })).destroyed).toEqual([lbl]);
    expect((await q('Email/changes', { sinceState: before })).updated).toEqual([second]);

    // maxChanges pages through with hasMoreChanges.
    const pageBase = (await q('Email/get', { ids: [] })).state;
    const a = await deliver(W, 'p1'); const b = await deliver(W, 'p2'); const c = await deliver(W, 'p3');
    const page1 = await q('Email/changes', { sinceState: pageBase, maxChanges: 2 });
    expect(page1.hasMoreChanges).toBe(true);
    expect(page1.created).toHaveLength(2);
    const page2 = await q('Email/changes', { sinceState: page1.newState, maxChanges: 2 });
    expect(page2.hasMoreChanges).toBe(false);
    expect([...page1.created, ...page2.created].sort()).toEqual([a, b, c].sort());
  });

  it('returns cannotCalculateChanges for unknown, future and pruned states; cron prunes old tombstones', async () => {
    const W = await mkWho('dave');
    const q = (name: string, args: Record<string, unknown>) => one(name, { ...args, accountId: W.mb }, { auth: W.auth }) as Promise<any>;
    const id = await deliver(W, 'Old news');
    const base = (await q('Email/get', { ids: [] })).state;
    expect((await q('Email/changes', { sinceState: 'garbage' })).type).toBe('cannotCalculateChanges');
    expect((await q('Email/changes', { sinceState: '99999999' })).type).toBe('cannotCalculateChanges');
    await deleteMessagesForever(env, W.mb, [id]);
    // Age the tombstone past 30 days and run the hourly job.
    await env.DB.prepare('UPDATE jmap_tombstones SET created_at = ? WHERE mailbox_id = ?').bind(Date.now() - 31 * 24 * 3600_000, W.mb).run();
    await hourlyMaintenance(env, Date.now());
    expect(await env.DB.prepare('SELECT 1 FROM jmap_tombstones WHERE mailbox_id = ?').bind(W.mb).first()).toBeNull();
    expect((await q('Email/changes', { sinceState: base })).type).toBe('cannotCalculateChanges');
    const now = (await q('Email/get', { ids: [] })).state;
    expect((await q('Email/changes', { sinceState: now })).created).toEqual([]);
  });

  it('streams StateChange events and closes after the first one with closeafter=state', async () => {
    const W = await mkWho('erin');
    const opts = { types: null, closeAfterState: true, pingSec: 0, intervalMs: 20, maxMs: 5000 };
    const stream = eventStream(env, W.id, opts);
    const read = (async () => {
      const reader = stream.getReader();
      let text = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return text;
        text += new TextDecoder().decode(value);
      }
    })();
    await new Promise((r) => setTimeout(r, 60));
    await deliver(W, 'Wake up');
    const text = await read;
    expect(text).toContain('event: state');
    const data = JSON.parse(text.split('data: ')[1].split('\n')[0]);
    expect(data['@type']).toBe('StateChange');
    expect(Object.keys(data.changed)).toEqual([W.mb]);
    expect(data.changed[W.mb]).toHaveProperty('Email');
    // Type filter and pings.
    const quiet = eventStream(env, W.id, { types: new Set(['Thread']), closeAfterState: false, pingSec: 15, intervalMs: 10, maxMs: 80 });
    const reader = quiet.getReader();
    let t = '';
    for (;;) { const { done, value } = await reader.read(); if (done) break; t += new TextDecoder().decode(value); }
    expect(t).not.toContain('event: state');
    // The HTTP route is a text/event-stream.
    const http = await req('GET', '/jmap/eventsource/?types=*&closeafter=state&ping=0', { auth: W.auth });
    expect(http.headers.get('content-type')).toBe('text/event-stream');
    await http.body!.cancel();
    expect((await req('GET', '/jmap/eventsource/', { auth: null })).status).toBe(401);
  });
});

describe('identities, vacation and snippets', () => {
  it('lists the mailbox address and sendable aliases as identities', async () => {
    await env.DB.prepare('INSERT INTO aliases (id, address, mailbox_id, can_send, created_at) VALUES (?, ?, ?, 1, ?), (?, ?, ?, 0, ?)')
      .bind(ulid(), `sales-${A.mb.slice(-6).toLowerCase()}@${DOMAIN}`, A.mb, Date.now(), ulid(), `noreply-${A.mb.slice(-6).toLowerCase()}@${DOMAIN}`, A.mb, Date.now()).run();
    const r = await one('Identity/get', { ids: null });
    expect(r.list.map((i: any) => i.email).sort()).toEqual([A.addr, `sales-${A.mb.slice(-6).toLowerCase()}@${DOMAIN}`].sort());
    expect(r.list.find((i: any) => i.id === A.mb)).toMatchObject({ email: A.addr, mayDelete: false });
  });

  it('maps VacationResponse to the mailbox auto-reply settings', async () => {
    const cookie = await cookieFor(A);
    const g = await one('VacationResponse/get', { ids: null });
    expect(g.list[0]).toMatchObject({ id: 'singleton', isEnabled: false });
    const s = await one('VacationResponse/set', { update: { singleton: { isEnabled: true, subject: 'Away', textBody: 'Back soon', fromDate: '2026-01-01T00:00:00Z', toDate: '2026-02-01T00:00:00Z' } } });
    expect(s.updated.singleton).toBeNull();
    expect(s.newState).not.toBe(s.oldState);
    const api = await (await call(`/api/mailboxes/${A.mb}/settings`, { cookie })).json<any>();
    expect(api.autoreply).toMatchObject({ enabled: true, subject: 'Away', body: 'Back soon', start: Date.parse('2026-01-01T00:00:00Z'), end: Date.parse('2026-02-01T00:00:00Z') });
    const bad = await one('VacationResponse/set', { update: { singleton: { fromDate: 'soon' }, other: {} } });
    expect(bad.notUpdated.singleton.type).toBe('invalidProperties');
    expect(bad.notUpdated.other.type).toBe('notFound');
    await one('VacationResponse/set', { update: { singleton: { isEnabled: false } } });
  });

  it('SearchSnippet/get highlights the matched terms', async () => {
    const id = await deliver(A, 'Snippet target', { body: 'The <b>zebra</b> crossing' });
    const r = await one('SearchSnippet/get', { filter: { text: 'zebra' }, emailIds: [id, 'nope'] });
    expect(r.list[0].emailId).toBe(id);
    expect(r.list[0].preview).toContain('<mark>zebra</mark>');
    expect(r.list[0].preview).toContain('&lt;b&gt;');
    expect(r.notFound).toEqual(['nope']);
  });
});

describe('back references', () => {
  it('resolves #ids from an earlier Email/query and wildcards across Thread/get', async () => {
    const x = await deliver(A, 'Backref one', { messageId: '<br-1@vendor.test>' });
    await deliver(A, 'Re: Backref one', { inReplyTo: '<br-1@vendor.test>' });
    const r = await jmap([
      ['Email/query', { accountId: A.mb, filter: { subject: 'backref one' }, collapseThreads: true }, 'q'],
      ['Email/get', { accountId: A.mb, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['threadId', 'subject'] }, 'g'],
      ['Thread/get', { accountId: A.mb, '#ids': { resultOf: 'g', name: 'Email/get', path: '/list/*/threadId' } }, 't'],
      ['Email/get', { accountId: A.mb, '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' }, properties: ['subject'] }, 'all'],
      ['Email/get', { accountId: A.mb, '#ids': { resultOf: 'q', name: 'Email/get', path: '/ids' } }, 'wrongname'],
      ['Email/get', { accountId: A.mb, ids: [], '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' } }, 'both'],
      ['Email/get', { accountId: A.mb, '#ids': { resultOf: 'q', name: 'Email/query', path: '/nope' } }, 'badpath'],
    ]);
    expect(r[0][1].ids).toHaveLength(1);
    expect(r[1][1].list).toHaveLength(1);
    expect(r[2][1].list).toHaveLength(1);
    expect(r[3][1].list.map((e: any) => e.subject).sort()).toEqual(['Backref one', 'Re: Backref one']);
    expect(r[4][1].type).toBe('invalidResultReference');
    expect(r[5][1].type).toBe('invalidArguments');
    expect(r[6][1].type).toBe('invalidResultReference');
    expect(x).toBeTruthy();
  });
});
