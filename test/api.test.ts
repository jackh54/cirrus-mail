import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MessageFull, Page, ThreadDetail, ThreadSummary } from '../src/shared/api';
import { sendDueScheduled } from '../src/worker/cron';
import { processInbound } from '../src/worker/inbound/handler';
import { isSafeRemoteUrl, signFileUrl, signProxyUrl, verifyFileSig, verifyProxySig } from '../src/worker/lib/sign';
import { base32Decode, totp } from '../src/worker/lib/crypto';
import { buildEml, call, fakeEmail, sessionCookie, withEnv } from './helpers';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
const DOMAIN = 'apitest.test';

const state = {
  admin: '', bob: '', adminId: '', bobId: '',
  mbA: '', mbB: '', threadA: '', inboundMsgA: '', attachmentA: '', draftA: '',
};

function stubEmail(impl: (b: EmailMessageBuilder) => Promise<{ messageId: string }>) {
  const calls: EmailMessageBuilder[] = [];
  const e = withEnv({ EMAIL: { send: async (b: EmailMessageBuilder) => { calls.push(b); return impl(b); } } as unknown as SendEmail });
  return { e, calls };
}

beforeAll(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM sessions'), env.DB.prepare('DELETE FROM users')]);
});

describe('setup and auth', () => {
  it('reports needsSetup and enforces the token and CSRF header', async () => {
    expect(await (await call('/api/setup/status')).json()).toEqual({ needsSetup: true });
    const body = { token: env.SETUP_TOKEN, name: 'Alex Rivera', email: 'alex@apitest.test', password: 'demo-password-123' };
    const noCsrf = await call('/api/setup', { body, csrf: false });
    expect(noCsrf.status).toBe(403);
    expect(await noCsrf.json()).toEqual({ error: { code: 'CSRF', message: 'Missing X-Cirrus header' } });
    const badToken = await call('/api/setup', { body: { ...body, token: 'wrong' } });
    expect(badToken.status).toBe(403);
    const ok = await call('/api/setup', { body });
    expect(ok.status).toBe(200);
    const json = await ok.json<{ user: { id: string; role: string } }>();
    expect(json.user.role).toBe('admin');
    state.adminId = json.user.id;
    expect(ok.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect((await call('/api/setup', { body })).status).toBe(409);
  });

  it('logs in, rejects bad passwords, and requires X-Cirrus on writes', async () => {
    const bad = await call('/api/auth/login', { body: { email: 'alex@apitest.test', password: 'nope-nope-nope' } });
    expect(bad.status).toBe(401);
    expect((await bad.json<{ error: { code: string } }>()).error.code).toBe('INVALID_CREDENTIALS');
    const ok = await call('/api/auth/login', { body: { email: 'ALEX@apitest.test', password: 'demo-password-123' } });
    expect(ok.status).toBe(200);
    state.admin = sessionCookie(ok);
    expect((await call('/api/me', { cookie: state.admin })).status).toBe(200);
    expect((await call('/api/me')).status).toBe(401);
    const csrf = await call('/api/me', { method: 'PATCH', body: { name: 'X' }, cookie: state.admin, csrf: false });
    expect(csrf.status).toBe(403);
    const patched = await call('/api/me', { method: 'PATCH', body: { theme: 'dark' }, cookie: state.admin });
    expect((await patched.json<{ user: { theme: string } }>()).user.theme).toBe('dark');
  });

  it('marks the cookie Secure on https', async () => {
    const res = await (await import('../src/worker/index')).default.fetch(
      new Request<unknown, IncomingRequestCfProperties>('https://mail.example/api/auth/login', { method: 'POST', headers: { 'x-cirrus': '1', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'alex@apitest.test', password: 'demo-password-123' }) }),
      env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    expect(res.headers.get('set-cookie')).toMatch(/Secure/);
  });
});

describe('admin', () => {
  it('creates a domain, mailboxes and a second user', async () => {
    const d = await call('/api/admin/domains', { body: { name: DOMAIN }, cookie: state.admin });
    expect(d.status).toBe(201);
    const domainId = (await d.json<{ id: string }>()).id;
    const mb = await call('/api/admin/mailboxes', { body: { localPart: 'alex', domainId, displayName: 'Alex Rivera', members: [{ userId: state.adminId, role: 'owner' }] }, cookie: state.admin });
    expect(mb.status).toBe(201);
    state.mbA = (await mb.json<{ id: string }>()).id;
    const folders = await (await call(`/api/mailboxes/${state.mbA}/folders`, { cookie: state.admin })).json<{ role: string; sort: number }[]>();
    expect(folders.map((f) => f.role)).toEqual(['inbox', 'sent', 'drafts', 'scheduled', 'archive', 'spam', 'trash']);

    const u = await call('/api/admin/users', { body: { name: 'Sam Okafor', email: 'sam@apitest.test', role: 'member', tempPassword: 'temporary-pass-1', mailbox: { localPart: 'sam', domainId } }, cookie: state.admin });
    expect(u.status).toBe(201);
    state.bobId = (await u.json<{ id: string }>()).id;
    const login = await call('/api/auth/login', { body: { email: 'sam@apitest.test', password: 'temporary-pass-1' } });
    state.bob = sessionCookie(login);
    const me = await (await call('/api/me', { cookie: state.bob })).json<{ user: { mustChangePassword: boolean }; mailboxes: { id: string; address: string }[] }>();
    expect(me.user.mustChangePassword).toBe(true);
    expect(me.mailboxes.map((m) => m.address)).toEqual(['sam@apitest.test']);
    state.mbB = me.mailboxes[0].id;
  });

  it('guards admin routes and protects the last admin', async () => {
    expect((await call('/api/admin/users', { cookie: state.bob })).status).toBe(403);
    const demote = await call(`/api/admin/users/${state.adminId}`, { method: 'PATCH', body: { role: 'member' }, cookie: state.admin });
    expect((await demote.json<{ error: { code: string } }>()).error.code).toBe('CANNOT_DEMOTE_SELF');
    const disable = await call(`/api/admin/users/${state.adminId}`, { method: 'PATCH', body: { disabled: true }, cookie: state.admin });
    expect(disable.status).toBe(400);
    expect((await call(`/api/admin/users/${state.adminId}`, { method: 'DELETE', cookie: state.admin })).status).toBe(400);
  });

  it('evaluates DNS answers', async () => {
    const { evaluateDns } = await import('../src/worker/routes/admin');
    const ok = evaluateDns('x.test', ['10 route1.mx.cloudflare.net.', '20 route2.mx.cloudflare.net.'], ['v=spf1 include:_spf.mx.cloudflare.net ~all'], ['v=DMARC1; p=none']);
    expect([ok.mx.ok, ok.spf.ok, ok.dmarc.ok, ok.dkim.ok]).toEqual([true, true, true, null]);
    const bad = evaluateDns('x.test', ['10 mx.other.test.'], ['v=spf1 -all'], []);
    expect([bad.mx.ok, bad.spf.ok, bad.dmarc.ok]).toEqual([false, false, false]);
  });
});

describe('mail', () => {
  it('lists, opens and searches an inbound thread with signed attachment URLs', async () => {
    const raw = buildEml({
      from: 'Jordan Lee <jordan@vendor.test>', to: 'alex@apitest.test', subject: 'Q3 roadmap draft', messageId: '<roadmap-1@vendor.test>',
      html: '<p>Roadmap attached</p><img src="cid:chart1">',
      attachments: [{ filename: 'chart.png', type: 'image/png', content: PNG, cid: 'chart1' }, { filename: 'roadmap.pdf', type: 'application/pdf', content: new TextEncoder().encode('%PDF-1.4') }],
    });
    const out = await processInbound(fakeEmail('jordan@vendor.test', 'alex@apitest.test', raw), env);
    expect(out.accepted).toBe(true);
    const page = await (await call(`/api/mailboxes/${state.mbA}/threads`, { cookie: state.admin })).json<Page<ThreadSummary>>();
    expect(page.items).toHaveLength(1);
    state.threadA = page.items[0].id;
    const detail = await (await call(`/api/mailboxes/${state.mbA}/threads/${state.threadA}`, { cookie: state.admin })).json<ThreadDetail>();
    const m = detail.messages[0];
    state.inboundMsgA = m.id;
    state.attachmentA = m.attachments.find((a) => a.filename === 'roadmap.pdf')!.id;
    expect(m.html).toContain('http://localhost/api/files/');
    expect(m.html).not.toContain('cid:chart1');
    expect(m.attachments.every((a) => /\/api\/files\/[A-Z0-9]+\?e=\d+&s=/.test(a.url))).toBe(true);

    const chartUrl = new URL(m.attachments.find((a) => a.filename === 'chart.png')!.url);
    const file = await call(chartUrl.pathname + chartUrl.search);
    expect(file.headers.get('content-disposition')).toMatch(/^inline/);
    expect(file.status).toBe(200);

    const q = (s: string) => call(`/api/mailboxes/${state.mbA}/threads?q=${encodeURIComponent(s)}`, { cookie: state.admin }).then((r) => r.json<Page<ThreadSummary>>());
    expect((await q('roadm')).items).toHaveLength(1);
    expect((await q('from:jordan has:attachment')).items).toHaveLength(1);
    expect((await q('subject:"Q3 roadmap" is:starred')).items).toHaveLength(0);
    expect((await q('nonexistentword')).items).toHaveLength(0);
    expect((await q('foo" OR "1')).items).toHaveLength(0);
  });

  it('IDOR: another user gets 404 on mailbox, thread, message, attachment and draft', async () => {
    const d = await call(`/api/mailboxes/${state.mbA}/drafts`, { body: { from: 'alex@apitest.test', to: [{ email: 'jordan@vendor.test' }], cc: [], bcc: [], subject: 'Re: Q3', html: '<p>Thanks</p>', parentId: state.inboundMsgA }, cookie: state.admin });
    expect(d.status).toBe(201);
    state.draftA = (await d.json<MessageFull>()).id;

    const B = state.bob;
    expect((await call(`/api/mailboxes/${state.mbA}/folders`, { cookie: B })).status).toBe(404);
    expect((await call(`/api/mailboxes/${state.mbA}/threads`, { cookie: B })).status).toBe(404);
    expect((await call(`/api/mailboxes/${state.mbA}/threads/${state.threadA}`, { cookie: B })).status).toBe(404);
    expect((await call(`/api/mailboxes/${state.mbB}/threads/${state.threadA}`, { cookie: B })).status).toBe(404);
    expect((await call(`/api/mailboxes/${state.mbB}/messages/${state.inboundMsgA}/raw`, { cookie: B })).status).toBe(404);
    expect((await call(`/api/files/${state.attachmentA}`, { cookie: B })).status).toBe(403);
    expect((await call(`/api/mailboxes/${state.mbB}/drafts/${state.draftA}`, { method: 'PUT', body: { from: 'sam@apitest.test', to: [], cc: [], bcc: [], subject: 'x', html: 'x' }, cookie: B })).status).toBe(404);
    expect((await call(`/api/mailboxes/${state.mbB}/drafts/${state.draftA}`, { method: 'DELETE', cookie: B })).status).toBe(404);
    expect((await call(`/api/mailboxes/${state.mbB}/drafts/${state.draftA}/send`, { body: {}, cookie: B })).status).toBe(404);
    expect((await call(`/api/mailboxes/${state.mbB}/threads/actions`, { body: { threadIds: [state.threadA], action: 'trash' }, cookie: B })).status).toBe(404);
    expect((await call(`/api/mailboxes/${state.mbB}/drafts`, { body: { from: 'sam@apitest.test', to: [], cc: [], bcc: [], subject: 'x', html: 'x', parentId: state.inboundMsgA }, cookie: B })).status).toBe(404);
    // B cannot send as A's address from B's own mailbox either.
    expect((await call(`/api/mailboxes/${state.mbB}/drafts`, { body: { from: 'alex@apitest.test', to: [], cc: [], bcc: [], subject: 'x', html: 'x' }, cookie: B })).status).toBe(400);
  });

  it('sends a reply: stores the returned Message-ID, threads it, moves it to Sent', async () => {
    const { e, calls } = stubEmail(async () => ({ messageId: 'cf-abc123@apitest.test' }));
    const res = await call(`/api/mailboxes/${state.mbA}/drafts/${state.draftA}/send`, { body: {}, cookie: state.admin, env: e });
    expect(res.status).toBe(200);
    const { message, status } = await res.json<{ message: MessageFull; status: string }>();
    expect(status).toBe('sent');
    expect(message.messageIdHeader).toBe('<cf-abc123@apitest.test>');
    expect(message.status).toBe('sent');
    expect(message.threadId).toBe(state.threadA);
    const folders = await (await call(`/api/mailboxes/${state.mbA}/folders`, { cookie: state.admin })).json<{ id: string; role: string }[]>();
    expect(message.folderId).toBe(folders.find((f) => f.role === 'sent')!.id);
    expect(calls[0].headers).toEqual({ 'In-Reply-To': '<roadmap-1@vendor.test>', References: '<roadmap-1@vendor.test>' });
    expect(calls[0].text).toBe('Thanks');
    const contacts = await (await call('/api/contacts?q=jord', { cookie: state.admin })).json<{ email: string }[]>();
    expect(contacts.map((c) => c.email)).toEqual(['jordan@vendor.test']);
    const t = await env.DB.prepare('SELECT message_count FROM threads WHERE id = ?').bind(state.threadA).first<number>('message_count');
    expect(t).toBe(2);
  });

  it('maps E_DAILY_LIMIT_EXCEEDED to 429 and keeps the draft as failed', async () => {
    const d = await call(`/api/mailboxes/${state.mbA}/drafts`, { body: { from: 'alex@apitest.test', to: [{ email: 'x@vendor.test', name: 'X' }], cc: [], bcc: [], subject: 'Limit', html: '<p>hi</p>' }, cookie: state.admin });
    const draft = await d.json<MessageFull>();
    const { e } = stubEmail(async () => { throw Object.assign(new Error('Daily sending limit exceeded'), { code: 'E_DAILY_LIMIT_EXCEEDED' }); });
    const res = await call(`/api/mailboxes/${state.mbA}/drafts/${draft.id}/send`, { body: {}, cookie: state.admin, env: e });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { code: 'E_DAILY_LIMIT_EXCEEDED', message: 'The daily sending limit for this account has been reached. Try again tomorrow.' } });
    const row = await env.DB.prepare('SELECT status, error_code, error_message, folder_id FROM messages WHERE id = ?').bind(draft.id).first<{ status: string; error_code: string; folder_id: string }>();
    expect(row).toMatchObject({ status: 'failed', error_code: 'E_DAILY_LIMIT_EXCEEDED', error_message: 'The daily sending limit for this account has been reached. Try again tomorrow.', folder_id: draft.folderId });
    const other = stubEmail(async () => { throw Object.assign(new Error('nope'), { code: 'E_SENDER_NOT_VERIFIED' }); });
    expect((await call(`/api/mailboxes/${state.mbA}/drafts/${draft.id}/send`, { body: {}, cookie: state.admin, env: other.e })).status).toBe(502);
    // Unknown codes and the provider's raw text never reach the client or the database.
    const weird = stubEmail(async () => { throw Object.assign(new Error('internal: upstream token=abc123'), { code: 'boom with spaces' }); });
    const wres = await call(`/api/mailboxes/${state.mbA}/drafts/${draft.id}/send`, { body: {}, cookie: state.admin, env: weird.e });
    expect(wres.status).toBe(502);
    expect(await wres.json()).toEqual({ error: { code: 'E_DELIVERY_FAILED', message: 'Delivery failed. Try again later.' } });
    const stored = await env.DB.prepare('SELECT error_message FROM messages WHERE id = ?').bind(draft.id).first<string>('error_message');
    expect(stored).not.toContain('token');
    const log = await env.DB.prepare('SELECT COUNT(*) AS n FROM send_log WHERE message_id = ? AND ok = 0').bind(draft.id).first<number>('n');
    expect(log).toBe(3);
  });

  it('schedules a send and the cron claims and delivers it once', async () => {
    const d = await (await call(`/api/mailboxes/${state.mbA}/drafts`, { body: { from: 'alex@apitest.test', to: [{ email: 'later@vendor.test' }], cc: [], bcc: [], subject: 'Later', html: '<p>later</p>' }, cookie: state.admin })).json<MessageFull>();
    const sendAt = Date.now() + 3600_000;
    const res = await call(`/api/mailboxes/${state.mbA}/drafts/${d.id}/send`, { body: { sendAt }, cookie: state.admin });
    expect((await res.json<{ status: string }>()).status).toBe('scheduled');
    const { e, calls } = stubEmail(async () => ({ messageId: '<sched@cf>' }));
    expect(await sendDueScheduled(e, Date.now())).toBe(0);
    expect(await sendDueScheduled(e, sendAt + 1)).toBe(1);
    expect(await sendDueScheduled(e, sendAt + 1)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(await env.DB.prepare('SELECT status, message_id_hdr FROM messages WHERE id = ?').bind(d.id).first()).toEqual({ status: 'sent', message_id_hdr: '<sched@cf>' });
  });

  it('forward copies attachments; actions keep aggregates; delete_forever only from Trash', async () => {
    const fwd = await (await call(`/api/mailboxes/${state.mbA}/drafts`, { body: { from: 'alex@apitest.test', to: [{ email: 'team@apitest.test' }], cc: [], bcc: [], subject: 'Fwd: Q3 roadmap draft', html: '<p>fyi</p>', parentId: state.inboundMsgA, composeMode: 'forward' }, cookie: state.admin })).json<MessageFull>();
    expect(fwd.attachments.map((a) => a.filename)).toEqual(['roadmap.pdf']);
    expect(fwd.attachments[0].id).not.toBe(state.attachmentA);
    const keyOf = (id: string) => env.DB.prepare('SELECT r2_key FROM attachments WHERE id = ?').bind(id).first<string>('r2_key');
    const fwdKey = (await keyOf(fwd.attachments[0].id))!;
    expect(fwdKey).not.toBe(await keyOf(state.attachmentA));

    const act = (action: string, extra: object = {}) => call(`/api/mailboxes/${state.mbA}/threads/actions`, { body: { threadIds: [state.threadA], action, ...extra }, cookie: state.admin });
    await act('read');
    expect(await env.DB.prepare('SELECT unread_count FROM threads WHERE id = ?').bind(state.threadA).first<number>('unread_count')).toBe(0);
    await act('star');
    const starred = await (await call(`/api/mailboxes/${state.mbA}/threads?folder=starred`, { cookie: state.admin })).json<Page<ThreadSummary>>();
    expect(starred.items.map((t) => t.id)).toContain(state.threadA);
    expect((await act('delete_forever')).status).toBe(400);
    await act('trash');
    const keys = await env.DB.prepare('SELECT raw_key, body_key FROM messages WHERE thread_id = ? AND raw_key IS NOT NULL').bind(state.threadA).first<{ raw_key: string; body_key: string }>();
    expect((await act('delete_forever')).status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?').bind(state.threadA).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT 1 FROM threads WHERE id = ?').bind(state.threadA).first()).toBeNull();
    expect(await env.BUCKET.head(keys!.raw_key)).toBeNull();
    // The forward draft was part of the thread, so it went to Trash and was purged with its own attachment copy.
    expect(await env.BUCKET.head(fwdKey)).toBeNull();
  });
});

describe('pagination and poll', () => {
  it('pages threads with an opaque cursor and reports new mail', async () => {
    const since = Date.now() - 1;
    for (let i = 0; i < 3; i++) {
      const raw = buildEml({ from: `p${i}@vendor.test`, to: 'alex@apitest.test', subject: `Paging ${i}`, body: 'x', date: new Date(Date.now() - i * 60_000) });
      await processInbound(fakeEmail(`p${i}@vendor.test`, 'alex@apitest.test', raw), env);
    }
    const p1 = await (await call(`/api/mailboxes/${state.mbA}/threads?limit=2`, { cookie: state.admin })).json<Page<ThreadSummary>>();
    expect(p1.items.map((t) => t.subject)).toEqual(['Paging 0', 'Paging 1']);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await (await call(`/api/mailboxes/${state.mbA}/threads?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`, { cookie: state.admin })).json<Page<ThreadSummary>>();
    expect(p2.items.map((t) => t.subject)).toEqual(['Paging 2']);
    expect(p2.nextCursor).toBeNull();
    const poll = await (await call(`/api/mailboxes/${state.mbA}/poll?since=${since}`, { cookie: state.admin })).json<{ newCount: number; latest: ThreadSummary[] }>();
    expect(poll.newCount).toBe(3);
    expect(poll.latest).toHaveLength(3);
  });
});

describe('signed URLs and the image proxy', () => {
  it('accepts valid, rejects expired and tampered file signatures', async () => {
    const d = await (await call(`/api/mailboxes/${state.mbA}/drafts`, { body: { from: 'alex@apitest.test', to: [], cc: [], bcc: [], subject: 'att', html: 'x' }, cookie: state.admin })).json<MessageFull>();
    const form = new FormData();
    form.append('file', new File([new TextEncoder().encode('hello file')], 'hello.txt', { type: 'text/plain' }));
    const up = await call(`/api/mailboxes/${state.mbA}/drafts/${d.id}/attachments`, { form, cookie: state.admin });
    expect(up.status).toBe(201);
    const att = await up.json<{ id: string; url: string }>();
    const path = (u: string) => { const x = new URL(u); return x.pathname + x.search; };
    const ok = await call(path(att.url));
    expect(ok.status).toBe(200);
    expect(new TextDecoder().decode(await ok.arrayBuffer())).toBe('hello file');
    expect(ok.headers.get('content-disposition')).toMatch(/^attachment/);
    const expired = await signFileUrl(env, 'http://localhost', att.id, false, Date.now() - 2 * 3600_000);
    expect((await call(path(expired))).status).toBe(403);
    const tampered = path(att.url).replace(/s=([A-Za-z0-9_-])/, (_m, ch) => `s=${ch === 'A' ? 'B' : 'A'}`);
    expect((await call(tampered)).status).toBe(403);
    const otherId = path(att.url).replace(att.id, d.id);
    expect((await call(otherId)).status).toBe(403);
  });

  it('rejects private, loopback and non-http hosts', async () => {
    for (const u of ['http://localhost/a.png', 'http://127.0.0.1/a.png', 'http://10.1.2.3/a.png', 'http://192.168.1.1/a.png', 'http://169.254.169.254/latest',
      'http://[::1]/a.png', 'http://printer.local/a.png', 'http://172.16.0.1/a.png', 'ftp://x.test/a.png', 'javascript:alert(1)', 'http://2130706433/', 'http://intranet/a.png',
      'http://[::]/', 'http://[::127.0.0.1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:a00:1]/', 'http://[64:ff9b::a00:1]/', 'http://[2002:7f00:1::]/',
      'http://[fd00::1]/', 'http://[fc12:3456::1]/', 'http://[fe80::1]/', 'http://[febf::1]/', 'http://[ff02::1]/', 'http://198.18.0.1/', 'http://198.19.255.255/',
      'http://192.0.0.8/', 'http://100.64.0.1/', 'http://100.127.255.255/', 'http://0.1.2.3/', 'http://0x7f.1/', 'http://017700000001/']) {
      expect(isSafeRemoteUrl(u), u).toBe(false);
    }
    for (const u of ['https://images.example.com/logo.png', 'http://[2606:4700:4700::1111]/x.png', 'http://100.128.0.1/', 'http://198.20.0.1/', 'http://8.8.8.8/']) {
      expect(isSafeRemoteUrl(u), u).toBe(true);
    }
    const signed = await signProxyUrl(env, 'http://127.0.0.1/secret.png');
    const res = await call(signed);
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('BLOCKED_URL');
    expect((await call('/api/proxy/image?u=https%3A%2F%2Fimages.example.com%2Fa.png&s=forged')).status).toBe(403);
  });

  it('proxy signatures expire after 24 h and cannot be swapped with file signatures', async () => {
    const url = 'https://images.example.com/a.png';
    const fresh = new URL(await signProxyUrl(env, url), 'http://localhost');
    expect(Number(fresh.searchParams.get('e')) * 1000).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(await verifyProxySig(env, url, fresh.searchParams.get('e')!, fresh.searchParams.get('s')!)).toBe(true);
    const old = await signProxyUrl(env, url, Date.now() - 25 * 3600_000);
    const res = await call(old);
    expect(res.status).toBe(403);
    expect((await call(old.replace(/&e=\d+/, ''))).status).toBe(403);
    // A file signature for "id" must not validate as a proxy signature for u="id" (and vice versa).
    const file = new URL(await signFileUrl(env, 'http://localhost', url));
    expect(await verifyProxySig(env, url, file.searchParams.get('e')!, file.searchParams.get('s')!)).toBe(false);
    expect(await verifyFileSig(env, url, fresh.searchParams.get('e')!, fresh.searchParams.get('s')!)).toBe(false);
  });

  it('POST /api/proxy/sign signs only public http(s) URLs and needs a session', async () => {
    const urls = ['https://images.example.com/a.png', 'http://10.0.0.1/x.png', 'data:image/png;base64,AAAA', 'http://localhost/x'];
    expect((await call('/api/proxy/sign', { body: { urls } })).status).toBe(401);
    expect((await call('/api/proxy/sign', { body: { urls }, cookie: state.admin, csrf: false })).status).toBe(403);
    const res = await call('/api/proxy/sign', { body: { urls }, cookie: state.admin });
    const { signed } = await res.json<{ signed: Record<string, string> }>();
    expect(Object.keys(signed)).toEqual(['https://images.example.com/a.png']);
    const signedUrl = new URL(signed['https://images.example.com/a.png'], 'http://localhost');
    expect(signedUrl.pathname).toBe('/api/proxy/image');
    expect(await verifyProxySig(env, signedUrl.searchParams.get('u')!, signedUrl.searchParams.get('e')!, signedUrl.searchParams.get('s')!)).toBe(true);
    expect((await call('/api/proxy/sign', { body: { urls: Array(201).fill('https://a.example/x.png') }, cookie: state.admin })).status).toBe(400);
  });
});

describe('security hardening', () => {
  const wrong = (email: string, ip = '203.0.113.7') =>
    call('/api/auth/login', { body: { email, password: 'definitely-wrong' }, headers: { 'cf-connecting-ip': ip } }).then((r) => r.status);
  const count = (xs: number[], v: number) => xs.filter((x) => x === v).length;

  it('login throttle counts before hashing, so parallel guesses cannot exceed the cap', async () => {
    const statuses = await Promise.all(Array.from({ length: 15 }, () => wrong('ghost1@apitest.test')));
    expect(count(statuses, 401)).toBe(10);
    expect(count(statuses, 429)).toBe(5);
  });

  it('has a per-email cap across IPs, and a throttled real account is refused before the password check', async () => {
    const statuses = await Promise.all(Array.from({ length: 33 }, (_, i) => wrong('ghost2@apitest.test', `198.51.100.${i}`)));
    expect(count(statuses, 401)).toBe(30);
    expect(count(statuses, 429)).toBe(3);

    await call('/api/admin/users', { body: { name: 'Locked Out', email: 'locked@apitest.test', role: 'member', tempPassword: 'locked-password-1' }, cookie: state.admin });
    for (let i = 0; i < 10; i++) expect(await wrong('locked@apitest.test')).toBe(401);
    const right = await call('/api/auth/login', { body: { email: 'locked@apitest.test', password: 'locked-password-1' }, headers: { 'cf-connecting-ip': '203.0.113.7' } });
    expect(right.status).toBe(429);
    const elsewhere = await call('/api/auth/login', { body: { email: 'locked@apitest.test', password: 'locked-password-1' }, headers: { 'cf-connecting-ip': '203.0.113.8' } });
    expect(elsewhere.status).toBe(200);
  });

  it('rejects TOTP replay and caps TOTP failures per user', async () => {
    await call('/api/admin/users', { body: { name: 'Two Factor', email: 'totp@apitest.test', role: 'member', tempPassword: 'totp-password-1' }, cookie: state.admin });
    const cookie = sessionCookie(await call('/api/auth/login', { body: { email: 'totp@apitest.test', password: 'totp-password-1' } }));
    const { secret } = await (await call('/api/me/totp/begin', { body: {}, cookie })).json<{ secret: string }>();
    const key = base32Decode(secret);
    const now = Date.now();
    const codeNow = await totp(key, now);
    expect((await call('/api/me/totp/enable', { body: { code: codeNow }, cookie })).status).toBe(200);
    const login = (code?: string) => call('/api/auth/login', { body: { email: 'totp@apitest.test', password: 'totp-password-1', totp: code } });
    expect((await (await login()).json<{ error: { code: string } }>()).error.code).toBe('TOTP_REQUIRED');
    expect((await login(codeNow)).status).toBe(401);            // the enrolment code's step is already used
    const codeNext = await totp(key, now + 30_000);
    expect((await login(codeNext)).status).toBe(200);
    expect((await login(codeNext)).status).toBe(401);           // replay of an accepted code
    const bad = await totp(key, now + 3600_000);
    for (let i = 0; i < 4; i++) expect((await login(bad)).status).toBe(401);
    expect((await login(await totp(key, now - 30_000))).status).toBe(429); // 6th TOTP failure window
  });

  it('cron re-validates identity and membership before sending a scheduled message', async () => {
    const alias = await (await call('/api/admin/aliases', { body: { address: 'hello@apitest.test', mailboxId: state.mbA }, cookie: state.admin })).json<{ id: string }>();
    const d = await (await call(`/api/mailboxes/${state.mbA}/drafts`, { body: { from: 'hello@apitest.test', to: [{ email: 'x@vendor.test' }], cc: [], bcc: [], subject: 'From alias', html: 'x' }, cookie: state.admin })).json<MessageFull>();
    const sendAt = Date.now() + 3600_000;
    await call(`/api/mailboxes/${state.mbA}/drafts/${d.id}/send`, { body: { sendAt }, cookie: state.admin });
    await call(`/api/admin/aliases/${alias.id}`, { method: 'DELETE', cookie: state.admin });

    const sd = await (await call(`/api/mailboxes/${state.mbB}/drafts`, { body: { from: 'sam@apitest.test', to: [{ email: 'y@vendor.test' }], cc: [], bcc: [], subject: 'From Sam', html: 'x' }, cookie: state.bob })).json<MessageFull>();
    await call(`/api/mailboxes/${state.mbB}/drafts/${sd.id}/send`, { body: { sendAt }, cookie: state.bob });
    await call(`/api/admin/mailboxes/${state.mbB}`, { method: 'PATCH', body: { members: [] }, cookie: state.admin });

    const { e, calls } = stubEmail(async () => ({ messageId: '<never@cf>' }));
    expect(await sendDueScheduled(e, sendAt + 1)).toBe(0);
    expect(calls).toHaveLength(0);
    for (const id of [d.id, sd.id]) {
      expect(await env.DB.prepare('SELECT status, error_code FROM messages WHERE id = ?').bind(id).first()).toEqual({ status: 'failed', error_code: 'IDENTITY_NOT_ALLOWED' });
    }
    await call(`/api/admin/mailboxes/${state.mbB}`, { method: 'PATCH', body: { members: [{ userId: state.bobId, role: 'owner' }] }, cookie: state.admin });
  });

  it('strips CR/LF from names and subjects on save and again before sending', async () => {
    const res = await call(`/api/mailboxes/${state.mbA}/drafts`, {
      body: { from: 'alex@apitest.test', to: [{ email: 'x@vendor.test', name: 'Evil\r\nBcc: a@evil.test' }], cc: [], bcc: [], subject: 'Hi\r\nBcc: b@evil.test\u0000', html: 'x' }, cookie: state.admin,
    });
    const d = await res.json<MessageFull>();
    expect(d.subject).toBe('Hi  Bcc: b@evil.test');
    expect(d.to[0].name).toBe('Evil  Bcc: a@evil.test');
    // Simulate a value that got into the row some other way: send-time sanitising still applies.
    await env.DB.prepare("UPDATE messages SET from_name = 'Alex\r\nBcc: c@evil.test', subject = 'S\nX: y' WHERE id = ?").bind(d.id).run();
    const { e, calls } = stubEmail(async () => ({ messageId: '<clean@cf>' }));
    expect((await call(`/api/mailboxes/${state.mbA}/drafts/${d.id}/send`, { body: {}, cookie: state.admin, env: e })).status).toBe(200);
    const sent = JSON.stringify(calls[0]);
    expect(calls[0].subject).toBe('S X: y');
    expect((calls[0].from as EmailAddress).name).toBe('Alex  Bcc: c@evil.test');
    expect(sent).not.toMatch(/\\r|\\n|\\u0000/);
    const bad = await call(`/api/mailboxes/${state.mbA}/settings`, { method: 'PUT', body: { displayName: 'A\r\nB', signatureHtml: '', autoreply: { enabled: false, subject: 'x\ny', body: '', start: null, end: null } }, cookie: state.admin });
    expect(await bad.json()).toMatchObject({ displayName: 'A  B', autoreply: { subject: 'x y' } });
  });

  it('refuses ReDoS-prone filter patterns with an explanation', async () => {
    const res = await call(`/api/mailboxes/${state.mbA}/filters`, {
      body: { name: 'bad', match: 'all', conditions: [{ field: 'subject', op: 'regex', value: '(a+)+$' }], actions: [{ type: 'star' }], enabled: true, sort: 1 }, cookie: state.admin,
    });
    expect(res.status).toBe(400);
    const { error } = await res.json<{ error: { code: string; message: string } }>();
    expect(error.code).toBe('UNSAFE_REGEX');
    expect(error.message).toMatch(/backreferences.*\(a\+\)\+/);
  });

  it('a spoofed known contact with dmarc=fail still lands in Spam', async () => {
    const raw = buildEml({
      from: 'Jordan Lee <jordan@vendor.test>', to: 'alex@apitest.test', subject: 'Wire transfer today', body: 'please',
      headers: { 'Authentication-Results': 'mx.cloudflare.net; dkim=none; spf=fail; dmarc=fail header.from=vendor.test' },
    });
    const out = await processInbound(fakeEmail('attacker@elsewhere.test', 'alex@apitest.test', raw), env);
    const folders = await (await call(`/api/mailboxes/${state.mbA}/folders`, { cookie: state.admin })).json<{ id: string; role: string }[]>();
    expect(out.accepted && out.folderId).toBe(folders.find((f) => f.role === 'spam')!.id);
  });
});
