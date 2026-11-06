import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Filter } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { HttpError, notFound } from '../lib/errors';
import { jsonBody, zEmail, zId } from '../lib/validate';
import { compileRegex, MAX_REGEX_LENGTH, REGEX_RULE, regexSafetyIssue, rowToFilter, type FilterRow } from '../inbound/filters';
import type { AppEnv } from '../types';

export const filters = new Hono<AppEnv>();

const ConditionSchema = z.object({
  field: z.enum(['from', 'to', 'subject', 'has_attachment', 'list_id']),
  op: z.enum(['contains', 'equals', 'ends_with', 'regex', 'is_true']),
  value: z.string().max(500),
});

const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move_to'), folderId: zId }),
  z.object({ type: z.literal('mark_read') }),
  z.object({ type: z.literal('star') }),
  z.object({ type: z.literal('delete') }),
  z.object({ type: z.literal('forward_to'), email: zEmail }),
]);

const FilterSchema = z.object({
  name: z.string().trim().min(1).max(120),
  match: z.enum(['all', 'any']),
  conditions: z.array(ConditionSchema).min(1).max(20),
  actions: z.array(ActionSchema).min(1).max(10),
  enabled: z.boolean(),
  sort: z.number().int().min(0).max(100_000),
});

const forwards = (f: z.infer<typeof FilterSchema>) => f.actions.some((a) => a.type === 'forward_to');

/** forward_to sends mail out of the mailbox, so only its owners (or an admin) may set one up. */
function checkForwardAllowed(c: Context<AppEnv>, f: z.infer<typeof FilterSchema>) {
  if (forwards(f) && c.get('mailbox').role !== 'owner' && c.get('user').role !== 'admin') {
    throw new HttpError(403, 'FORBIDDEN', 'Only mailbox owners or admins can create forwarding filters');
  }
}

async function validate(db: D1Database, mb: string, f: z.infer<typeof FilterSchema>) {
  for (const c of f.conditions) {
    if (c.op === 'regex') {
      if (c.value.length > MAX_REGEX_LENGTH) throw new HttpError(400, 'INVALID_REGEX', `Regex is longer than ${MAX_REGEX_LENGTH} characters`);
      if (regexSafetyIssue(c.value)) throw new HttpError(400, 'UNSAFE_REGEX', `Regex rejected. ${REGEX_RULE}`);
      if (!compileRegex(c.value)) throw new HttpError(400, 'INVALID_REGEX', 'Regex does not compile');
    }
  }
  for (const a of f.actions) {
    if (a.type === 'move_to') {
      const ok = await db.prepare("SELECT 1 FROM folders WHERE id = ? AND mailbox_id = ? AND (role IS NULL OR role NOT IN ('drafts','scheduled','sent'))").bind(a.folderId, mb).first();
      if (!ok) throw new HttpError(400, 'INVALID_FOLDER', 'Unknown target folder');
    }
  }
}

filters.get('/filters', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM filters WHERE mailbox_id = ? ORDER BY sort, created_at').bind(c.get('mailbox').id).all<FilterRow>();
  return c.json(results.map(rowToFilter));
});

filters.post('/filters', async (c) => {
  const b = await jsonBody(c, FilterSchema);
  const mb = c.get('mailbox').id;
  checkForwardAllowed(c, b);
  await validate(c.env.DB, mb, b);
  const id = ulid();
  await c.env.DB.prepare('INSERT INTO filters (id, mailbox_id, name, match, conditions, actions, enabled, sort, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, mb, b.name, b.match, JSON.stringify(b.conditions), JSON.stringify(b.actions), b.enabled ? 1 : 0, b.sort, Date.now(), c.get('user').id).run();
  const f: Filter = { id, ...b };
  return c.json(f, 201);
});

filters.put('/filters/:id', async (c) => {
  const b = await jsonBody(c, FilterSchema);
  const mb = c.get('mailbox').id;
  checkForwardAllowed(c, b);
  await validate(c.env.DB, mb, b);
  const id = c.req.param('id');
  // Saving a forward_to makes the saver the one it runs on behalf of (see the inbound handler).
  const res = await c.env.DB.prepare(
    'UPDATE filters SET name = ?, match = ?, conditions = ?, actions = ?, enabled = ?, sort = ?, created_by = CASE WHEN ? THEN ? ELSE created_by END WHERE id = ? AND mailbox_id = ?',
  ).bind(b.name, b.match, JSON.stringify(b.conditions), JSON.stringify(b.actions), b.enabled ? 1 : 0, b.sort, forwards(b) ? 1 : 0, c.get('user').id, id, mb).run();
  if (!res.meta.changes) throw notFound('Filter not found');
  const f: Filter = { id, ...b };
  return c.json(f);
});

filters.delete('/filters/:id', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM filters WHERE id = ? AND mailbox_id = ?').bind(c.req.param('id'), c.get('mailbox').id).run();
  if (!res.meta.changes) throw notFound('Filter not found');
  return c.json({ ok: true });
});
