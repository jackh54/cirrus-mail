// Copies existing small bodies from R2 into messages.body_inline, a bounded step per cron tick.
// Idempotent: a settings cursor (message id, ascending) only moves forward, and an update only applies while the
// row still points at the body that was read. Once the cursor passes the last row a tick is one read and one
// empty select; new messages are inlined when written.
import { INLINE_BODY_MAX, inlineBodyJson, type StoredBody } from './db';

const CURSOR_KEY = 'inline_backfill_cursor';
export const BACKFILL_BATCH = 200;

export async function backfillInlineBodies(env: Env, batch = BACKFILL_BATCH): Promise<number> {
  const db = env.DB;
  const cursor = (await db.prepare('SELECT value FROM settings WHERE key = ?').bind(CURSOR_KEY).first<string>('value')) ?? '';
  const { results } = await db.prepare(
    'SELECT id, body_key FROM messages WHERE id > ? AND body_inline IS NULL AND body_key IS NOT NULL ORDER BY id LIMIT ?',
  ).bind(cursor, batch).all<{ id: string; body_key: string }>();
  if (!results.length) return 0;
  const stmts: D1PreparedStatement[] = [];
  await Promise.all(results.map(async (r) => {
    const obj = await env.BUCKET.get(r.body_key);
    if (!obj || obj.size > INLINE_BODY_MAX * 2) return; // missing, or too big to be worth reading
    let body: StoredBody;
    try { body = await obj.json<StoredBody>(); } catch { return; }
    const json = inlineBodyJson(body.html ?? null, body.text ?? null);
    if (json) stmts.push(db.prepare('UPDATE messages SET body_inline = ? WHERE id = ? AND body_key = ? AND body_inline IS NULL').bind(json, r.id, r.body_key));
  }));
  stmts.push(db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(CURSOR_KEY, results[results.length - 1].id));
  await db.batch(stmts);
  return results.length;
}
