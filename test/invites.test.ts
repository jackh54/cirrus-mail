import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AdminInviteResponse, InviteLookupResponse } from '../src/shared/api';
import { ulid } from '../src/shared/ulid';
import { hashPassword } from '../src/worker/lib/crypto';
import { call, createMailbox, ensureDomain, sessionCookie, withEnv } from './helpers';

const DOMAIN = 'invtest.test';
const state = { admin: '', adminId: '', member: '', domainId: '' };

type Sent = { from: { email: string; name: string }; to: string; subject: string; html: string; text: string };

function stubEmail(fail = false) {
  const calls: Sent[] = [];
  const e = withEnv({
    EMAIL: { send: async (b: Sent) => {
      if (fail) throw Object.assign(new Error('raw provider text'), { code: 'E_SENDER_NOT_VERIFIED' });
      calls.push(b);
      return { messageId: '<x@test>' };
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

async function login(email: string, password = 'admin-password-123'): Promise<string> {
  return sessionCookie(await call('/api/auth/login', { body: { email, password } }));
}

const tokenOf = (url: string) => url.split('#')[1];
const lookup = (token: string) => call('/api/invites/lookup', { body: { token } });

async function invite(body: Record<string, unknown>, e = stubEmail()) {
  const res = await call('/api/admin/users/invite', { body, cookie: state.admin, env: e.e });
  return { res, calls: e.calls };
}

beforeAll(async () => {
  state.adminId = await mkUser('Alex Rivera', 'alex@invtest.test', 'admin');
  await mkUser('Mel Member', 'mel@invtest.test', 'member');
  state.domainId = await ensureDomain(DOMAIN);
  await createMailbox('boss@invtest.test', [{ userId: state.adminId, role: 'owner' }]);
  state.admin = await login('alex@invtest.test');
  state.member = await login('mel@invtest.test');
});

describe('invites', () => {
  it('creates the user and mailbox, and emails the link from the admin mailbox', async () => {
    const { res, calls } = await invite({ name: 'Pat Lee', email: 'pat@elsewhere.test', role: 'member', mailbox: { localPart: 'pat', domainId: state.domainId } });
    expect(res.status).toBe(201);
    const body = await res.json<AdminInviteResponse>();
    expect(body.user.invite?.sentAt).toBeTypeOf('number');
    expect(body.user.mailboxCount).toBe(1);
    expect(body.inviteUrl).toMatch(/^http:\/\/localhost\/invite#[\w-]{40,}$/);
    expect(body.email).toEqual({ sent: true, from: 'boss@invtest.test' });
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe('pat@elsewhere.test');
    expect(calls[0].from.email).toBe('boss@invtest.test');
    expect(calls[0].from.name).toContain('Alex Rivera via');
    expect(calls[0].subject).toBe(`Alex Rivera invited you to ${env.APP_NAME}`);
    expect(calls[0].html).toContain(body.inviteUrl);
    expect(calls[0].text).toContain(body.inviteUrl);
    expect(calls[0].text).toContain('pat@invtest.test');
    expect(calls[0].html).toMatch(/This link expires on \d{1,2} [A-Z][a-z]+ \d{4}\./);
    // Only the hash is stored.
    const row = await env.DB.prepare('SELECT token_hash FROM invites').first<string>('token_hash');
    expect(JSON.stringify(row)).not.toContain(tokenOf(body.inviteUrl));
  });

  it('keeps an invited user from signing in, and 409s on a taken email', async () => {
    const { res } = await invite({ name: 'Quinn', email: 'quinn@elsewhere.test', role: 'member' });
    expect(res.status).toBe(201);
    const bad = await call('/api/auth/login', { body: { email: 'quinn@elsewhere.test', password: 'anything-at-all' } });
    expect(bad.status).toBe(401);
    const dup = await invite({ name: 'Quinn', email: 'quinn@elsewhere.test', role: 'member' });
    expect(dup.res.status).toBe(409);
    expect((await dup.res.json<{ error: { code: string } }>()).error.code).toBe('EMAIL_TAKEN');
  });

  it('looks up a valid token, and hides invalid vs expired', async () => {
    const { res } = await invite({ name: 'Robin', email: 'robin@elsewhere.test', role: 'member', mailbox: { localPart: 'robin', domainId: state.domainId } });
    const { inviteUrl, user } = await res.json<AdminInviteResponse>();
    const ok = await lookup(tokenOf(inviteUrl));
    expect(ok.status).toBe(200);
    const body = await ok.json<InviteLookupResponse>();
    expect(body).toMatchObject({ email: 'robin@elsewhere.test', name: 'Robin', inviterName: 'Alex Rivera', mailboxAddress: 'robin@invtest.test' });
    const unknown = await lookup('not-a-real-token');
    await env.DB.prepare('UPDATE invites SET expires_at = ? WHERE user_id = ?').bind(Date.now() - 1000, user.id).run();
    const expired = await lookup(tokenOf(inviteUrl));
    expect(unknown.status).toBe(404);
    expect(expired.status).toBe(404);
    expect(await expired.json()).toEqual(await unknown.json());
  });

  it('accepts once: sets the password, signs in, and rejects reuse', async () => {
    const { res } = await invite({ name: 'Sky', email: 'sky@elsewhere.test', role: 'member' });
    const { inviteUrl, user } = await res.json<AdminInviteResponse>();
    const token = tokenOf(inviteUrl);
    const acc = await call('/api/invites/accept', { body: { token, name: 'Sky Chen', password: 'brand-new-password' } });
    expect(acc.status).toBe(200);
    const cookie = sessionCookie(acc);
    expect((await acc.json<{ user: { name: string; mustChangePassword: boolean } }>()).user).toMatchObject({ name: 'Sky Chen', mustChangePassword: false });
    expect((await call('/api/me', { cookie })).status).toBe(200);
    expect((await call('/api/auth/login', { body: { email: 'sky@elsewhere.test', password: 'brand-new-password' } })).status).toBe(200);
    expect((await call('/api/invites/accept', { body: { token, name: 'Sky', password: 'another-password-1' } })).status).toBe(404);
    expect((await lookup(token)).status).toBe(404);
    const again = await call(`/api/admin/users/${user.id}/invite`, { body: {}, cookie: state.admin, env: stubEmail().e });
    expect(again.status).toBe(400);
    expect((await again.json<{ error: { code: string } }>()).error.code).toBe('ALREADY_ACTIVE');
  });

  it('rejects an expired token on accept, and leaves a disabled user invite alone', async () => {
    const a = await (await invite({ name: 'Exp', email: 'exp@elsewhere.test', role: 'member' })).res.json<AdminInviteResponse>();
    await env.DB.prepare('UPDATE invites SET expires_at = ? WHERE user_id = ?').bind(Date.now() - 1000, a.user.id).run();
    expect((await call('/api/invites/accept', { body: { token: tokenOf(a.inviteUrl), name: 'Exp', password: 'brand-new-password' } })).status).toBe(404);
    expect(a.user.invite).not.toBeNull();

    const d = await (await invite({ name: 'Dis', email: 'dis@elsewhere.test', role: 'member' })).res.json<AdminInviteResponse>();
    await call(`/api/admin/users/${d.user.id}`, { method: 'PATCH', body: { disabled: true }, cookie: state.admin });
    expect((await call('/api/invites/accept', { body: { token: tokenOf(d.inviteUrl), name: 'Dis', password: 'brand-new-password' } })).status).toBe(404);
    expect((await lookup(tokenOf(d.inviteUrl))).status).toBe(404);
    expect(await env.DB.prepare('SELECT 1 FROM invites WHERE user_id = ?').bind(d.user.id).first()).not.toBeNull();
    // Resending to a disabled user would email a link that can never work.
    const r = await call(`/api/admin/users/${d.user.id}/invite`, { body: {}, cookie: state.admin });
    expect(r.status).toBe(400);
    expect((await r.json<{ error: { code: string } }>()).error.code).toBe('USER_DISABLED');
  });

  it('resend invalidates the old token', async () => {
    const first = await (await invite({ name: 'Rae', email: 'rae@elsewhere.test', role: 'member' })).res.json<AdminInviteResponse>();
    const e = stubEmail();
    const res = await call(`/api/admin/users/${first.user.id}/invite`, { body: {}, cookie: state.admin, env: e.e });
    expect(res.status).toBe(200);
    const second = await res.json<AdminInviteResponse>();
    expect(e.calls).toHaveLength(1);
    expect(tokenOf(second.inviteUrl)).not.toBe(tokenOf(first.inviteUrl));
    expect((await lookup(tokenOf(first.inviteUrl))).status).toBe(404);
    expect((await lookup(tokenOf(second.inviteUrl))).status).toBe(200);
    expect((await call('/api/admin/users/nope/invite', { body: {}, cookie: state.admin })).status).toBe(404);
  });

  it('skips with HOSTED_HERE, NOT_REQUESTED and NO_SENDING_DOMAIN', async () => {
    const hosted = await invite({ name: 'Hos', email: 'hos@INVTEST.test', role: 'member' });
    expect((await hosted.res.json<AdminInviteResponse>()).email).toEqual({ sent: false, reason: 'HOSTED_HERE' });
    expect(hosted.calls).toHaveLength(0);
    const manual = await invite({ name: 'Man', email: 'man@elsewhere.test', role: 'member', send: false });
    const m = await manual.res.json<AdminInviteResponse>();
    expect(m.email).toEqual({ sent: false, reason: 'NOT_REQUESTED' });
    expect(m.user.invite?.sentAt).toBeNull();
    expect(manual.calls).toHaveLength(0);

    // No domains at all (and an admin without a mailbox): nothing to send from.
    const bareId = await mkUser('Bare Admin', 'bare@bare.test', 'admin');
    const bare = await login('bare@bare.test');
    await env.DB.batch([env.DB.prepare('DELETE FROM mailboxes'), env.DB.prepare('DELETE FROM domains')]);
    const e = stubEmail();
    const res = await call('/api/admin/users/invite', { body: { name: 'Nod', email: 'nod@elsewhere.test', role: 'member' }, cookie: bare, env: e.e });
    expect(res.status).toBe(201);
    expect((await res.json<AdminInviteResponse>()).email).toEqual({ sent: false, reason: 'NO_SENDING_DOMAIN' });
    expect(e.calls).toHaveLength(0);
    expect(bareId).toBeTruthy();
    state.domainId = await ensureDomain(DOMAIN);
  });

  it('falls back to noreply@ when the admin has no mailbox', async () => {
    await ensureDomain(DOMAIN);
    const cookie = await login('bare@bare.test');
    const e = stubEmail();
    const res = await call('/api/admin/users/invite', { body: { name: 'Nor', email: 'nor@elsewhere.test', role: 'member' }, cookie, env: e.e });
    expect((await res.json<AdminInviteResponse>()).email).toEqual({ sent: true, from: `noreply@${DOMAIN}` });
  });

  it('still returns 201 with SEND_FAILED when sending fails', async () => {
    const { res, calls } = await invite({ name: 'Fail', email: 'fail@elsewhere.test', role: 'member' }, stubEmail(true));
    expect(res.status).toBe(201);
    const body = await res.json<AdminInviteResponse>();
    expect(body.email).toEqual({ sent: false, reason: 'SEND_FAILED', error: 'This From address is not verified for Email Sending.' });
    expect(JSON.stringify(body)).not.toContain('raw provider text');
    expect(body.user.invite?.sentAt).toBeNull();
    expect(calls).toHaveLength(0);
    expect((await lookup(tokenOf(body.inviteUrl))).status).toBe(200);
  });

  it('forbids non-admins', async () => {
    const res = await call('/api/admin/users/invite', { body: { name: 'X', email: 'x@elsewhere.test', role: 'member' }, cookie: state.member });
    expect(res.status).toBe(403);
    expect((await call(`/api/admin/users/${state.adminId}/invite`, { body: {}, cookie: state.member })).status).toBe(403);
  });

  it('clears the invite when an admin resets the password', async () => {
    const u = await (await invite({ name: 'Reset', email: 'reset@elsewhere.test', role: 'member' })).res.json<AdminInviteResponse>();
    const patch = await call(`/api/admin/users/${u.user.id}`, { method: 'PATCH', body: { resetPassword: 'chosen-password-1' }, cookie: state.admin });
    expect((await patch.json<{ invite: unknown }>()).invite).toBeNull();
    expect((await lookup(tokenOf(u.inviteUrl))).status).toBe(404);
    const list = await (await call('/api/admin/users', { cookie: state.admin })).json<{ email: string; invite: unknown }[]>();
    expect(list.find((x) => x.email === 'reset@elsewhere.test')?.invite).toBeNull();
    expect(list.find((x) => x.email === 'alex@invtest.test')?.invite).toBeNull();
  });

  it('escapes HTML in interpolated values', async () => {
    const { calls } = await invite({ name: '<b>x</b>', email: 'esc@elsewhere.test', role: 'member' });
    expect(calls).toHaveLength(1);
    expect(calls[0].html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(calls[0].html).not.toContain('<b>x</b>');
    expect(calls[0].text).toContain('<b>x</b>');
  });
});
