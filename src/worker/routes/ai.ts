// Optional AI triage routes: status, admin settings, inbox category counts and overrides, thread summaries.
import { Hono } from 'hono';
import { z } from 'zod';
import { THREAD_CATEGORIES, type AdminAi, type AiStatus, type CategoryCounts, type ThreadCategory, type ThreadSummaryResponse } from '../../shared/api';
import { HttpError, notFound } from '../lib/errors';
import { aiBinding, aiConfig, AI_BUDGET_KEY, AI_ENABLED_KEY, claimAiCall, summarizeWithAi, type SummaryMessage } from '../lib/ai';
import { loadBody, type MessageRow } from '../lib/db';
import { htmlToText } from '../lib/html';
import { hit } from '../lib/ratelimit';
import { jsonBody } from '../lib/validate';
import { requireAdmin, requireAuth } from '../middleware/session';
import type { AppEnv } from '../types';

const zCategory = z.enum(THREAD_CATEGORIES);

// ---------- GET /api/ai/status ----------

export const aiPublic = new Hono<AppEnv>();
aiPublic.use('*', requireAuth);
aiPublic.get('/status', async (c) => {
  const status: AiStatus = { enabled: (await aiConfig(c.env.DB, Date.now())).enabled };
  return c.json(status);
});

// ---------- /api/admin/ai ----------

export const aiAdmin = new Hono<AppEnv>();
aiAdmin.use('*', requireAuth, requireAdmin);

async function adminAi(env: Env): Promise<AdminAi> {
  const cfg = await aiConfig(env.DB, Date.now());
  return { enabled: cfg.enabled, dailyBudget: cfg.budget, usedToday: cfg.used, available: !!aiBinding(env) };
}

aiAdmin.get('/', async (c) => c.json(await adminAi(c.env)));

aiAdmin.patch('/', async (c) => {
  const b = await jsonBody(c, z.object({ enabled: z.boolean().optional(), dailyBudget: z.number().int().min(0).max(100_000).optional() }));
  const put = (key: string, value: string) =>
    c.env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value);
  const stmts: D1PreparedStatement[] = [];
  if (b.enabled !== undefined) stmts.push(put(AI_ENABLED_KEY, b.enabled ? '1' : '0'));
  if (b.dailyBudget !== undefined) stmts.push(put(AI_BUDGET_KEY, String(b.dailyBudget)));
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json(await adminAi(c.env));
});

// ---------- mailbox-scoped (mounted behind requireMailbox, so membership is already checked) ----------

export const aiMailbox = new Hono<AppEnv>();

/** Threads with unread Inbox mail, per tab. */
aiMailbox.get('/categories', async (c) => {
  const mb = c.get('mailbox').id;
  const { results } = await c.env.DB.prepare(
    `SELECT COALESCE(t.category, 'primary') AS category, COUNT(DISTINCT t.id) AS n
       FROM messages m JOIN threads t ON t.id = m.thread_id AND t.mailbox_id = m.mailbox_id
      WHERE m.mailbox_id = ?1 AND m.folder_id = (SELECT id FROM folders WHERE mailbox_id = ?1 AND role = 'inbox') AND m.is_read = 0
      GROUP BY 1`,
  ).bind(mb).all<{ category: ThreadCategory; n: number }>();
  const unread = Object.fromEntries(THREAD_CATEGORIES.map((k) => [k, 0])) as Record<ThreadCategory, number>;
  for (const r of results) unread[r.category] = r.n;
  const out: CategoryCounts = { unread };
  return c.json(out);
});

/** Moves a thread to another tab by hand; optionally remembers its latest sender for this mailbox. */
aiMailbox.put('/threads/:tid/category', async (c) => {
  const b = await jsonBody(c, z.object({ category: zCategory, rememberSender: z.boolean().optional() }));
  const mb = c.get('mailbox').id;
  const tid = c.req.param('tid');
  const db = c.env.DB;
  const found = await db.prepare('SELECT id FROM threads WHERE id = ? AND mailbox_id = ?').bind(tid, mb).first();
  if (!found) throw notFound('Thread not found');
  const stmts = [db.prepare('UPDATE threads SET category = ? WHERE id = ? AND mailbox_id = ?').bind(b.category, tid, mb)];
  if (b.rememberSender) {
    const sender = await db.prepare("SELECT lower(from_email) AS e FROM messages WHERE thread_id = ? AND mailbox_id = ? AND direction = 'in' AND from_email != '' ORDER BY date DESC, id DESC LIMIT 1")
      .bind(tid, mb).first<string>('e');
    if (sender) {
      stmts.push(db.prepare('INSERT INTO sender_categories (mailbox_id, sender, category) VALUES (?, ?, ?) ON CONFLICT(mailbox_id, sender) DO UPDATE SET category = excluded.category')
        .bind(mb, sender, b.category));
    }
  }
  await db.batch(stmts);
  return c.json({ category: b.category });
});

// ---------- thread summary ----------

const VISIBLE = "status IN ('received','sent')";
const SUMMARY_WINDOW_MS = 10 * 60 * 1000;
const SUMMARY_MAX_PER_WINDOW = 10;
const MAX_SUMMARY_MESSAGES = 12;
const PER_MESSAGE_CHARS = 1500;

async function ownThread(db: D1Database, mb: string, tid: string): Promise<{ subject: string; fingerprint: string }> {
  const [thread, fp] = await db.batch([
    db.prepare('SELECT subject FROM threads WHERE id = ?1 AND mailbox_id = ?2').bind(tid, mb),
    db.prepare(`SELECT COUNT(*) AS n, (SELECT id FROM messages WHERE thread_id = ?1 AND ${VISIBLE} ORDER BY date DESC, id DESC LIMIT 1) AS last
                  FROM messages WHERE thread_id = ?1 AND ${VISIBLE}`).bind(tid),
  ]);
  const t = thread.results[0] as { subject: string } | undefined;
  if (!t) throw notFound('Thread not found');
  const f = fp.results[0] as { n: number; last: string | null };
  return { subject: t.subject, fingerprint: `${f.n}:${f.last ?? ''}` };
}

async function freshSummary(db: D1Database, tid: string, fingerprint: string): Promise<ThreadSummaryResponse['summary']> {
  const row = await db.prepare('SELECT bullets, created_at FROM thread_summaries WHERE thread_id = ? AND fingerprint = ?')
    .bind(tid, fingerprint).first<{ bullets: string; created_at: number }>();
  if (!row) return null;
  try {
    return { bullets: JSON.parse(row.bullets) as string[], generatedAt: row.created_at, cached: true };
  } catch {
    return null;
  }
}

/** The cached summary if it is still current (new mail since makes it stale). Never calls the model. */
aiMailbox.get('/threads/:tid/summary', async (c) => {
  const tid = c.req.param('tid');
  const { fingerprint } = await ownThread(c.env.DB, c.get('mailbox').id, tid);
  const out: ThreadSummaryResponse = { summary: (await aiConfig(c.env.DB, Date.now())).enabled ? await freshSummary(c.env.DB, tid, fingerprint) : null };
  return c.json(out);
});

/** Summarise on demand: the cache when current, otherwise one model call (rate-limited per user, counted in the daily budget). */
aiMailbox.post('/threads/:tid/summary', async (c) => {
  const mb = c.get('mailbox').id;
  const tid = c.req.param('tid');
  const db = c.env.DB;
  const now = Date.now();
  const { subject, fingerprint } = await ownThread(db, mb, tid);
  const cfg = await aiConfig(db, now);
  if (!cfg.enabled) throw new HttpError(409, 'AI_DISABLED', 'AI features are turned off. An admin can enable them in Admin → Overview.');
  const cached = await freshSummary(db, tid, fingerprint);
  if (cached) return c.json({ summary: cached } satisfies ThreadSummaryResponse);

  const ai = aiBinding(c.env);
  if (!ai) throw new HttpError(503, 'AI_UNAVAILABLE', 'Workers AI is not available on this deployment.');
  if ((await hit(db, `ai-summary:${c.get('user').id}`, SUMMARY_WINDOW_MS, now)) > SUMMARY_MAX_PER_WINDOW) {
    throw new HttpError(429, 'RATE_LIMITED', 'Too many summaries. Try again in a few minutes.');
  }
  if (!(await claimAiCall(db, cfg.budget, now))) {
    throw new HttpError(429, 'AI_BUDGET_EXCEEDED', 'The daily AI limit has been reached. It resets at 00:00 UTC.');
  }

  const { results } = await db.prepare(
    `SELECT * FROM (SELECT * FROM messages WHERE thread_id = ? AND mailbox_id = ? AND ${VISIBLE} ORDER BY date DESC, id DESC LIMIT ?) ORDER BY date ASC, id ASC`,
  ).bind(tid, mb, MAX_SUMMARY_MESSAGES).all<MessageRow>();
  const messages: SummaryMessage[] = await Promise.all(results.map(async (m) => {
    const body = await loadBody(c.env, m.body_key);
    const text = (body.text ?? (body.html ? htmlToText(body.html) : '')).split('\n').filter((l) => !l.startsWith('>')).join('\n').trim();
    return { from: m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email, date: m.date, text: text.slice(0, PER_MESSAGE_CHARS) };
  }));

  let bullets: string[];
  try {
    bullets = await summarizeWithAi(ai, subject, messages);
  } catch (e) {
    console.error('ai summary failed', (e as Error).name);
    throw new HttpError(502, 'AI_FAILED', 'The summary could not be generated. Try again later.');
  }
  await db.prepare('INSERT INTO thread_summaries (thread_id, fingerprint, bullets, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET fingerprint = excluded.fingerprint, bullets = excluded.bullets, created_at = excluded.created_at')
    .bind(tid, fingerprint, JSON.stringify(bullets), now).run();
  const out: ThreadSummaryResponse = { summary: { bullets, generatedAt: now, cached: false } };
  return c.json(out);
});
