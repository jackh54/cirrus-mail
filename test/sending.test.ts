import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AdminSettings, AdminStats, MessageFull, SendingStatus } from '../src/shared/api';
import { ulid } from '../src/shared/ulid';
import { maybeAutoreply } from '../src/worker/inbound/autoreply';
import { hashPassword } from '../src/worker/lib/crypto';
import { utcDay } from '../src/worker/lib/sendcount';
import { call, createMailbox, randomLocal, sessionCookie, withEnv } from './helpers';

const DOMAIN = 'sendcount.test';
const state = { admin: '', member: '', adminId: '', mbId: '', domainId: '' };

function stubEmail(fail = false) {
  const calls: unknown[] = [];
  const e = withEnv({
    EMAIL: { send: async (b: unknown) => {
      if (fail) throw Object.assign(new Error('raw'), { code: 'E_DELIVERY_FAILED' });
      calls.push(b);
      return { messageId: 'cf-1@sendcount.test' };
    } } as unknown as SendEmail,
  });
  return { e, calls };
}

async function mkUser(name: string, email: string, role: 'admin' | 'member'): Promise<string> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare('INSERT INTO users (id, email, name, password_hash, role, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
    .bind(id, email, name, await hashPassword('admin-password-123'), role, now, now).run();
  return id;
}

const login = async (email: string) => sessionCookie(await call('/api/auth/login', { body: { email, password: 'admin-password-123' } }));
const sentToday = async () => (await env.DB.prepare('SELECT sent FROM send_counts WHERE day = ?').bind(utcDay(Date.now())).first<number>('sent')) ?? 0;
const addr = (email: string) => ({ email, name: '' });

async function sendDraft(e: Env, to: string[], cc: string[]) {
  const d = await call(`/api/mailboxes/${state.mbId}/drafts`, {
    body: { from: 'boss@sendcount.test', to: to.map(addr), cc: cc.map(addr), bcc: [], subject: 'Hi', html: '<p>hi</p>' }, cookie: state.admin,
  });
  const draft = await d.json<MessageFull>();
  return call(`/api/mailboxes/${state.mbId}/drafts/${draft.id}/send`, { body: {}, cookie: state.admin, env: e });
}

beforeAll(async () => {
  state.adminId = await mkUser('Alex', 'alex@sendcount.test', 'admin');
  await mkUser('Mel', 'mel@sendcount.test', 'member');
  const mb = await createMailbox('boss@sendcount.test', [{ userId: state.adminId, role: 'owner' }]);
  state.mbId = mb.id;
  state.admin = await login('alex@sendcount.test');
  state.member = await login('mel@sendcount.test');
});

describe('send counting', () => {
  it('counts one per recipient (2 to + 1 cc = 3) and nothing for a failed send', async () => {
    const before = await sentToday();
    const ok = await sendDraft(stubEmail().e, ['a@x.test', 'b@x.test'], ['c@x.test']);
    expect(ok.status).toBe(200);
    expect(await sentToday()).toBe(before + 3);
    const bad = await sendDraft(stubEmail(true).e, ['a@x.test'], []);
    expect(bad.status).toBe(502);
    expect(await sentToday()).toBe(before + 3);
  });

  it('counts one for an invite email, none when it fails', async () => {
    const before = await sentToday();
    const domainId = await env.DB.prepare('SELECT id FROM domains WHERE name = ?').bind(DOMAIN).first<string>('id');
    const send = (email: string, e: Env) => call('/api/admin/users/invite', { body: { name: 'Pat', email, role: 'member', mailbox: { localPart: randomLocal('pat'), domainId } }, cookie: state.admin, env: e });
    const ok = await send('pat@elsewhere.test', stubEmail().e);
    expect(ok.status).toBe(201);
    expect(await sentToday()).toBe(before + 1);
    await send('pat2@elsewhere.test', stubEmail(true).e);
    expect(await sentToday()).toBe(before + 1);
  });

  it('counts one for an auto-reply', async () => {
    const before = await sentToday();
    const mb = { id: state.mbId, address: 'boss@sendcount.test', display_name: '', autoreply_enabled: 1, autoreply_subject: 'Away', autoreply_body: 'Back soon', autoreply_start: null, autoreply_end: null };
    const { e, calls } = stubEmail();
    const input = {
      sender: 'client@partner.test', fromDomain: 'partner.test', envelopeSpfPass: true, subject: 'Q', messageId: null, headers: () => null,
      auth: { aligned: true } as never, ownAddresses: new Set<string>(), now: Date.now(),
    };
    expect(await maybeAutoreply(e, mb, input)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await sentToday()).toBe(before + 1);
  });
});

describe('sending status and settings', () => {
  it('requires sign-in and shows the admin-set limit to a member', async () => {
    expect((await call('/api/sending')).status).toBe(401);
    const none = await (await call('/api/sending', { cookie: state.member })).json<SendingStatus>();
    expect(none.dailyLimit).toBeNull();
    const patch = await call('/api/admin/settings', { method: 'PATCH', body: { dailySendLimit: 100 }, cookie: state.admin });
    expect(patch.status).toBe(200);
    expect(await patch.json<AdminSettings>()).toEqual({ dailySendLimit: 100 });
    const s = await (await call('/api/sending', { cookie: state.member })).json<SendingStatus>();
    expect(s.dailyLimit).toBe(100);
    expect(s.sentToday).toBe(await sentToday());
    expect(s.dayStartsAt).toBe(Date.parse(`${utcDay(Date.now())}T00:00:00Z`));
  });

  it('keeps settings admin-only and validates the range', async () => {
    expect((await call('/api/admin/settings', { method: 'PATCH', body: { dailySendLimit: 5 }, cookie: state.member })).status).toBe(403);
    expect((await call('/api/admin/settings', { cookie: state.member })).status).toBe(403);
    for (const v of [0, -1, 1.5, 1_000_001, '5']) {
      expect((await call('/api/admin/settings', { method: 'PATCH', body: { dailySendLimit: v }, cookie: state.admin })).status).toBe(400);
    }
    expect((await call('/api/admin/settings', { cookie: state.admin })).status).toBe(200);
  });

  it('includes dailySendLimit and sentToday in stats, and null clears the limit', async () => {
    await call('/api/admin/settings', { method: 'PATCH', body: { dailySendLimit: 250 }, cookie: state.admin });
    const stats = await (await call('/api/admin/stats', { cookie: state.admin })).json<AdminStats>();
    expect(stats.dailySendLimit).toBe(250);
    expect(stats.sentToday).toBeGreaterThanOrEqual(await sentToday());
    const cleared = await call('/api/admin/settings', { method: 'PATCH', body: { dailySendLimit: null }, cookie: state.admin });
    expect(await cleared.json<AdminSettings>()).toEqual({ dailySendLimit: null });
    expect(await env.DB.prepare("SELECT 1 FROM settings WHERE key = 'daily_send_limit'").first()).toBeNull();
    expect((await (await call('/api/admin/stats', { cookie: state.admin })).json<AdminStats>()).dailySendLimit).toBeNull();
  });
});
