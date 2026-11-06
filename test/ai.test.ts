import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AdminAi, CategoryCounts, Page, ThreadSummary, ThreadSummaryResponse } from '../src/shared/api';
import { ulid } from '../src/shared/ulid';
import { processInbound } from '../src/worker/inbound/handler';
import { AI_CLASSIFY_MODEL, AI_SUMMARY_MODEL, heuristicCategory } from '../src/worker/lib/ai';
import { hashPassword } from '../src/worker/lib/crypto';
import { utcDay } from '../src/worker/lib/sendcount';
import { buildEml, call, createMailbox, fakeEmail, randomLocal, sessionCookie, withEnv } from './helpers';

// The real Workers AI binding is remote-only, so tests inject a fake with the same `run(model, input)` shape
// through the env (withEnv), and the vitest pool runs with remoteBindings off.

const state = { admin: '', adminId: '', member: '', memberId: '', outsider: '' };

interface Call { model: string; input: { messages: { role: string; content: string }[]; response_format: { type: string; json_schema: unknown } } }

function fakeAi(answer: unknown | ((c: Call) => unknown)) {
  const calls: Call[] = [];
  const ai = {
    async run(model: string, input: unknown) {
      const c = { model, input } as Call;
      calls.push(c);
      const out = typeof answer === 'function' ? (answer as (c: Call) => unknown)(c) : answer;
      if (out instanceof Error) throw out;
      return out;
    },
  };
  return { calls, env: withEnv({ AI: ai as unknown as Ai }) };
}

const category = (c: string) => ({ response: { category: c } });

async function mkUser(name: string, email: string, role: 'admin' | 'member'): Promise<string> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare('INSERT INTO users (id, email, name, password_hash, role, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
    .bind(id, email, name, await hashPassword('admin-password-123'), role, now, now).run();
  return id;
}
const login = async (email: string) => sessionCookie(await call('/api/auth/login', { body: { email, password: 'admin-password-123' } }));

async function setAi(enabled: boolean | null, budget?: number) {
  await env.DB.prepare("DELETE FROM settings WHERE key IN ('ai_enabled','ai_daily_budget')").run();
  if (enabled !== null) await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('ai_enabled', ?)").bind(enabled ? '1' : '0').run();
  if (budget !== undefined) await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('ai_daily_budget', ?)").bind(String(budget)).run();
}
const usage = async () => (await env.DB.prepare('SELECT calls FROM ai_usage WHERE day = ?').bind(utcDay(Date.now())).first<number>('calls')) ?? 0;

async function mailbox() {
  const address = `${randomLocal()}@aitest.test`;
  const mb = await createMailbox(address, [{ userId: state.adminId, role: 'owner' }, { userId: state.memberId, role: 'member' }]);
  return { ...mb, address };
}

/** Delivers one message and waits for the background work (classification) the handler schedules. */
async function deliver(mb: { address: string }, e: Env, o: { from?: string; subject?: string; body?: string; headers?: Record<string, string>; inReplyTo?: string; messageId?: string } = {}) {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const from = o.from ?? 'bob@acme.test';
  const msg = fakeEmail(from, mb.address, buildEml({ from, to: mb.address, subject: o.subject ?? 'Quick thing', body: o.body ?? 'Can we talk?', headers: o.headers, inReplyTo: o.inReplyTo, messageId: o.messageId }));
  const out = await processInbound(msg, e, ctx);
  await Promise.all(pending);
  if (!out.accepted) throw new Error(`rejected: ${out.reason}`);
  return { out, threadId: out.threadId!, rejected: msg.rejected };
}

const threadCategory = (id: string) => env.DB.prepare('SELECT category FROM threads WHERE id = ?').bind(id).first<string>('category');

beforeAll(async () => {
  state.adminId = await mkUser('Alex', 'alex@aitest.test', 'admin');
  state.memberId = await mkUser('Mel', 'mel@aitest.test', 'member');
  await mkUser('Out', 'out@aitest.test', 'member');
  state.admin = await login('alex@aitest.test');
  state.member = await login('mel@aitest.test');
  state.outsider = await login('out@aitest.test');
});

beforeEach(async () => {
  await setAi(null);
  await env.DB.prepare('DELETE FROM ai_usage').run();
  await env.DB.prepare('DELETE FROM rate_limits WHERE key LIKE ?').bind('ai-summary:%').run();
});

describe('AI is off by default', () => {
  it('makes zero AI calls and leaves threads uncategorised', async () => {
    const mb = await mailbox();
    const ai = fakeAi(category('promotions'));
    const a = await deliver(mb, ai.env);
    const b = await deliver(mb, ai.env, { from: 'newsletter@shop.test', subject: 'Sale', headers: { 'List-Unsubscribe': '<mailto:u@shop.test>' } });
    expect(ai.calls).toHaveLength(0);
    expect(await usage()).toBe(0);
    expect(await threadCategory(a.threadId)).toBeNull();
    expect(await threadCategory(b.threadId)).toBeNull();
    const status = await call('/api/ai/status', { cookie: state.member });
    expect(await status.json()).toEqual({ enabled: false });
  });

  it('summarise refuses while off, without a call', async () => {
    const mb = await mailbox();
    const ai = fakeAi({ response: { bullets: ['x'] } });
    const { threadId } = await deliver(mb, ai.env);
    const res = await call(`/api/mailboxes/${mb.id}/threads/${threadId}/summary`, { method: 'POST', cookie: state.member, env: ai.env });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('AI_DISABLED');
    expect(ai.calls).toHaveLength(0);
  });

  it('the admin can turn it on and sees the default budget', async () => {
    const before = await call('/api/admin/ai', { cookie: state.admin });
    expect(await before.json()).toMatchObject({ enabled: false, dailyBudget: 500, usedToday: 0 });
    const res = await call('/api/admin/ai', { method: 'PATCH', body: { enabled: true, dailyBudget: 20 }, cookie: state.admin });
    expect(await res.json<AdminAi>()).toMatchObject({ enabled: true, dailyBudget: 20 });
    expect(await (await call('/api/ai/status', { cookie: state.member })).json()).toEqual({ enabled: true });
    expect((await call('/api/admin/ai', { cookie: state.member })).status).toBe(403);
    expect((await call('/api/admin/ai', { method: 'PATCH', body: { enabled: true }, cookie: state.member })).status).toBe(403);
  });
});

describe('categories', () => {
  it('classifies obvious mail from headers and senders without AI', async () => {
    await setAi(true);
    const mb = await mailbox();
    const ai = fakeAi(category('forums'));
    const promo = await deliver(mb, ai.env, { from: 'newsletter@shop.test', subject: 'Weekend deals', headers: { 'List-Unsubscribe': '<mailto:u@shop.test>' } });
    const social = await deliver(mb, ai.env, { from: 'notification@facebookmail.com', subject: 'Sam commented' });
    const receipt = await deliver(mb, ai.env, { from: 'noreply@store.test', subject: 'Your order has shipped' });
    const list = await deliver(mb, ai.env, { from: 'dev@lists.test', subject: '[dev] patch', headers: { 'List-Id': '<dev.lists.test>', Precedence: 'list' } });
    expect(await threadCategory(promo.threadId)).toBe('promotions');
    expect(await threadCategory(social.threadId)).toBe('social');
    expect(await threadCategory(receipt.threadId)).toBe('updates');
    expect(await threadCategory(list.threadId)).toBe('forums');
    expect(ai.calls).toHaveLength(0);
    expect(await usage()).toBe(0);
  });

  it('heuristics are unsure about ordinary mail', () => {
    const none = () => null;
    expect(heuristicCategory({ fromEmail: 'bob@acme.test', subject: 'Lunch?', header: none })).toBeNull();
    expect(heuristicCategory({ fromEmail: 'bob@acme.test', subject: 'Lunch?', header: (n) => (n === 'list-unsubscribe' ? '<x>' : null) })).toBeNull();
  });

  it('asks the model when the rules are unsure, with a trimmed prompt and JSON mode', async () => {
    await setAi(true);
    const mb = await mailbox();
    const ai = fakeAi(category('social'));
    const { threadId } = await deliver(mb, ai.env, { body: 'x'.repeat(5000) });
    expect(ai.calls).toHaveLength(1);
    const c = ai.calls[0];
    expect(c.model).toBe(AI_CLASSIFY_MODEL);
    expect(c.input.response_format.type).toBe('json_schema');
    const user = c.input.messages.find((m) => m.role === 'user')!.content;
    expect(user).toContain('bob@acme.test');
    expect(user).toContain('Quick thing');
    expect(user.length).toBeLessThan(1700);
    expect(await threadCategory(threadId)).toBe('social');
    expect(await usage()).toBe(1);
  });

  it('accepts the answer as JSON text, and the thread follows the latest message', async () => {
    await setAi(true);
    const mb = await mailbox();
    const first = fakeAi({ response: '{"category":"updates"}' });
    const a = await deliver(mb, first.env, { messageId: '<t1@acme.test>' });
    expect(await threadCategory(a.threadId)).toBe('updates');
    const second = fakeAi(category('primary'));
    const b = await deliver(mb, second.env, { messageId: '<t2@acme.test>', inReplyTo: '<t1@acme.test>', subject: 'Re: Quick thing' });
    expect(b.threadId).toBe(a.threadId);
    expect(await threadCategory(a.threadId)).toBe('primary');
  });

  it('falls back to Primary on bad output or a model error, and still delivers', async () => {
    await setAi(true);
    const mb = await mailbox();
    const bad: unknown[] = [
      { response: 'sure! it is promotional' }, { response: { category: 'banana' } }, { response: null }, {},
      new Error('JSON Mode couldn\'t be met'), new Error('boom'),
    ];
    for (const answer of bad) {
      const ai = fakeAi(answer);
      const { threadId, rejected, out } = await deliver(mb, ai.env, { subject: `Hello ${ulid()}` });
      expect(rejected).toBeNull();
      expect(out.accepted).toBe(true);
      expect(ai.calls).toHaveLength(1);
      const t = await call(`/api/mailboxes/${mb.id}/threads?category=primary`, { cookie: state.admin });
      expect((await t.json<Page<ThreadSummary>>()).items.find((x) => x.id === threadId)?.category).toBe('primary');
    }
  });

  it('survives a binding that throws synchronously, or is missing', async () => {
    await setAi(true);
    const mb = await mailbox();
    const throwing = withEnv({ AI: { run() { throw new Error('sync boom'); } } as unknown as Ai });
    expect((await deliver(mb, throwing)).rejected).toBeNull();
    const missing = withEnv({ AI: undefined });
    const { threadId } = await deliver(mb, missing, { subject: 'No binding' });
    expect(await threadCategory(threadId)).toBeNull();
  });

  it('skips spam', async () => {
    await setAi(true);
    const mb = await mailbox();
    await env.DB.prepare('INSERT INTO blocked_senders (id, mailbox_id, pattern, created_at) VALUES (?, ?, ?, ?)').bind(ulid(), mb.id, 'spammer@bad.test', Date.now()).run();
    const ai = fakeAi(category('promotions'));
    const { out } = await deliver(mb, ai.env, { from: 'spammer@bad.test' });
    expect(out.folderId).toBe(mb.folders.spam);
    expect(ai.calls).toHaveLength(0);
  });

  it('enforces the daily budget: classification stops silently, delivery is unaffected', async () => {
    await setAi(true, 2);
    const mb = await mailbox();
    const ai = fakeAi(category('updates'));
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await deliver(mb, ai.env, { subject: `Budget ${i} ${ulid()}` })).threadId);
    expect(ai.calls).toHaveLength(2);
    expect(await usage()).toBe(2);
    expect(await threadCategory(ids[1])).toBe('updates');
    expect(await threadCategory(ids[2])).toBeNull();
    // Heuristic and remembered-sender results are free even over budget.
    const free = await deliver(mb, ai.env, { from: 'newsletter@shop.test', subject: 'Deals', headers: { 'List-Unsubscribe': '<x>' } });
    expect(await threadCategory(free.threadId)).toBe('promotions');
    expect(ai.calls).toHaveLength(2);
    const admin = await (await call('/api/admin/ai', { cookie: state.admin })).json<AdminAi>();
    expect(admin).toMatchObject({ dailyBudget: 2, usedToday: 2 });
  });

  it('a budget of zero never calls the model', async () => {
    await setAi(true, 0);
    const mb = await mailbox();
    const ai = fakeAi(category('updates'));
    await deliver(mb, ai.env);
    expect(ai.calls).toHaveLength(0);
  });

  it('lists threads by tab, counts unread per tab, and recategorises by hand', async () => {
    await setAi(true);
    const mb = await mailbox();
    const ai = fakeAi(category('updates'));
    const a = await deliver(mb, ai.env, { subject: 'Alpha' });
    const b = await deliver(mb, fakeAi(category('primary')).env, { subject: 'Beta' });
    const list = async (cat: string) => (await (await call(`/api/mailboxes/${mb.id}/threads?category=${cat}`, { cookie: state.member })).json<Page<ThreadSummary>>()).items.map((t) => t.id);
    expect(await list('updates')).toEqual([a.threadId]);
    expect(await list('primary')).toEqual([b.threadId]);
    expect(await list('social')).toEqual([]);
    const counts = await (await call(`/api/mailboxes/${mb.id}/categories`, { cookie: state.member })).json<CategoryCounts>();
    expect(counts.unread).toEqual({ primary: 1, updates: 1, promotions: 0, social: 0, forums: 0 });

    const move = await call(`/api/mailboxes/${mb.id}/threads/${a.threadId}/category`, { method: 'PUT', body: { category: 'social' }, cookie: state.member });
    expect(move.status).toBe(200);
    expect(await list('social')).toEqual([a.threadId]);
    expect((await call(`/api/mailboxes/${mb.id}/threads/${a.threadId}/category`, { method: 'PUT', body: { category: 'nope' }, cookie: state.member })).status).toBe(400);
  });

  it('remembers a sender override per mailbox, and it beats the model', async () => {
    await setAi(true);
    const mb = await mailbox();
    const ai = fakeAi(category('updates'));
    const a = await deliver(mb, ai.env, { from: 'carol@acme.test', subject: 'First' });
    await call(`/api/mailboxes/${mb.id}/threads/${a.threadId}/category`, { method: 'PUT', body: { category: 'forums', rememberSender: true }, cookie: state.member });
    const calls = ai.calls.length;
    const b = await deliver(mb, ai.env, { from: 'carol@acme.test', subject: 'Second' });
    expect(await threadCategory(b.threadId)).toBe('forums');
    expect(ai.calls).toHaveLength(calls);
    // Other mailboxes are unaffected.
    const other = await mailbox();
    const c = await deliver(other, fakeAi(category('social')).env, { from: 'carol@acme.test' });
    expect(await threadCategory(c.threadId)).toBe('social');
  });

  it('only a mailbox member can read counts or recategorise', async () => {
    const mb = await mailbox();
    const { threadId } = await deliver(mb, env);
    expect((await call(`/api/mailboxes/${mb.id}/categories`, { cookie: state.outsider })).status).toBe(404);
    const res = await call(`/api/mailboxes/${mb.id}/threads/${threadId}/category`, { method: 'PUT', body: { category: 'social' }, cookie: state.outsider });
    expect(res.status).toBe(404);
    expect(await threadCategory(threadId)).toBeNull();
  });

  it('stores the per-user tab preference', async () => {
    const res = await call('/api/me', { method: 'PATCH', body: { categoryTabs: false }, cookie: state.member });
    expect((await res.json<{ user: { categoryTabs: boolean } }>()).user.categoryTabs).toBe(false);
    const back = await call('/api/me', { method: 'PATCH', body: { categoryTabs: true }, cookie: state.member });
    expect((await back.json<{ user: { categoryTabs: boolean } }>()).user.categoryTabs).toBe(true);
  });
});

describe('summarise', () => {
  const summaryUrl = (mb: string, tid: string) => `/api/mailboxes/${mb}/threads/${tid}/summary`;

  async function threadOf(mb: { address: string }, e: Env) {
    const a = await deliver(mb, e, { subject: 'Plan', messageId: '<s1@acme.test>', body: 'We should ship on Friday.' });
    await deliver(mb, e, { subject: 'Re: Plan', messageId: '<s2@acme.test>', inReplyTo: '<s1@acme.test>', body: 'Friday works.' });
    await deliver(mb, e, { subject: 'Re: Plan', messageId: '<s3@acme.test>', inReplyTo: '<s2@acme.test>', body: 'Great, booking it.' });
    return a.threadId;
  }

  it('is cached per thread and goes stale when new mail arrives', async () => {
    await setAi(true);
    const mb = await mailbox();
    const ai = fakeAi({ response: { bullets: ['Ship on Friday', 'Booking confirmed'] } });
    const tid = await threadOf(mb, ai.env);
    ai.calls.length = 0;

    expect((await (await call(summaryUrl(mb.id, tid), { cookie: state.member, env: ai.env })).json<ThreadSummaryResponse>()).summary).toBeNull();
    const first = await call(summaryUrl(mb.id, tid), { method: 'POST', cookie: state.member, env: ai.env });
    expect(first.status).toBe(200);
    expect((await first.json<ThreadSummaryResponse>()).summary).toMatchObject({ bullets: ['Ship on Friday', 'Booking confirmed'], cached: false });
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].model).toBe(AI_SUMMARY_MODEL);
    const prompt = ai.calls[0].input.messages.find((m) => m.role === 'user')!.content;
    expect(prompt).toContain('Friday works.');
    expect(prompt).toContain('Great, booking it.');

    const second = await call(summaryUrl(mb.id, tid), { method: 'POST', cookie: state.admin, env: ai.env });
    expect((await second.json<ThreadSummaryResponse>()).summary).toMatchObject({ cached: true });
    expect(ai.calls).toHaveLength(1);
    expect((await (await call(summaryUrl(mb.id, tid), { cookie: state.member, env: ai.env })).json<ThreadSummaryResponse>()).summary).toMatchObject({ cached: true });

    // New mail in the thread invalidates the cache.
    await deliver(mb, fakeAi(category('primary')).env, { subject: 'Re: Plan', messageId: '<s4@acme.test>', inReplyTo: '<s3@acme.test>', body: 'One more thing.' });
    expect((await (await call(summaryUrl(mb.id, tid), { cookie: state.member, env: ai.env })).json<ThreadSummaryResponse>()).summary).toBeNull();
    const third = await call(summaryUrl(mb.id, tid), { method: 'POST', cookie: state.member, env: ai.env });
    expect((await third.json<ThreadSummaryResponse>()).summary).toMatchObject({ cached: false });
    expect(ai.calls).toHaveLength(2);
  });

  it('accepts plain-text bullets from the model', async () => {
    await setAi(true);
    const mb = await mailbox();
    const ai = fakeAi({ response: '- First point\n- Second point' });
    const tid = await threadOf(mb, ai.env);
    const res = await call(summaryUrl(mb.id, tid), { method: 'POST', cookie: state.member, env: ai.env });
    expect((await res.json<ThreadSummaryResponse>()).summary?.bullets).toEqual(['First point', 'Second point']);
  });

  it('is authorised by mailbox membership', async () => {
    await setAi(true);
    const mb = await mailbox();
    const other = await mailbox();
    const ai = fakeAi({ response: { bullets: ['x'] } });
    const tid = await threadOf(mb, ai.env);
    ai.calls.length = 0;
    const outsider = await call(summaryUrl(mb.id, tid), { method: 'POST', cookie: state.outsider, env: ai.env });
    expect(outsider.status).toBe(404);
    expect((await call(summaryUrl(mb.id, tid), { cookie: state.outsider, env: ai.env })).status).toBe(404);
    expect((await call(summaryUrl(mb.id, tid), { method: 'POST', env: ai.env })).status).toBe(401);
    // A member of another mailbox cannot reach this thread through their own mailbox id either.
    const cross = await call(summaryUrl(other.id, tid), { method: 'POST', cookie: state.member, env: ai.env });
    expect(cross.status).toBe(404);
    expect(ai.calls).toHaveLength(0);
  });

  it('returns a clear error over budget, when AI is unavailable or fails, and rate limits per user', async () => {
    await setAi(true, 1);
    const mb = await mailbox();
    const ai = fakeAi(category('primary'));
    const tid = await threadOf(mb, ai.env); // spends the one call of budget on classification
    await env.DB.prepare('INSERT INTO ai_usage (day, calls) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET calls = 1').bind(utcDay(Date.now())).run();
    ai.calls.length = 0;
    const over = await call(summaryUrl(mb.id, tid), { method: 'POST', cookie: state.member, env: ai.env });
    expect(over.status).toBe(429);
    expect((await over.json<{ error: { code: string } }>()).error.code).toBe('AI_BUDGET_EXCEEDED');
    expect(ai.calls).toHaveLength(0);

    await setAi(true, 100);
    const none = await call(summaryUrl(mb.id, tid), { method: 'POST', cookie: state.member, env: withEnv({ AI: undefined }) });
    expect(none.status).toBe(503);
    const broken = await call(summaryUrl(mb.id, tid), { method: 'POST', cookie: state.member, env: fakeAi(new Error('boom')).env });
    expect(broken.status).toBe(502);
    expect((await broken.json<{ error: { code: string } }>()).error.code).toBe('AI_FAILED');
    const junk = await call(summaryUrl(mb.id, tid), { method: 'POST', cookie: state.member, env: fakeAi({ response: { bullets: [] } }).env });
    expect(junk.status).toBe(502);

    await env.DB.prepare('INSERT OR REPLACE INTO rate_limits (key, count, window_end) VALUES (?, 10, ?)').bind(`ai-summary:${state.memberId}`, Date.now() + 600_000).run();
    const limited = await call(summaryUrl(mb.id, tid), { method: 'POST', cookie: state.member, env: fakeAi({ response: { bullets: ['x'] } }).env });
    expect(limited.status).toBe(429);
    expect((await limited.json<{ error: { code: string } }>()).error.code).toBe('RATE_LIMITED');
  });
});
