import { Hono } from 'hono';
import { z } from 'zod';
import { MAX_TEMPLATES_PER_MAILBOX, type ReplyTemplate } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { HttpError, notFound } from '../lib/errors';
import { sanitizeTemplateHtml } from '../lib/template-html';
import { jsonBody, zHeaderText } from '../lib/validate';
import type { AppEnv } from '../types';

/** Reply templates (canned responses). Mounted behind requireMailbox: any member may read and edit them. */
export const templates = new Hono<AppEnv>();

interface Row { id: string; name: string; subject: string; body_html: string; updated_at: number }

const toApi = (r: Row): ReplyTemplate => ({ id: r.id, name: r.name, subject: r.subject, bodyHtml: r.body_html, updatedAt: r.updated_at });

const TemplateSchema = z.object({
  name: zHeaderText(80, 1),
  subject: zHeaderText(200),
  bodyHtml: z.string().max(100_000),
});

templates.get('/templates', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name, subject, body_html, updated_at FROM reply_templates WHERE mailbox_id = ? ORDER BY name COLLATE NOCASE, id')
    .bind(c.get('mailbox').id).all<Row>();
  return c.json(results.map(toApi));
});

templates.post('/templates', async (c) => {
  const b = await jsonBody(c, TemplateSchema);
  const mb = c.get('mailbox').id;
  const html = await sanitizeTemplateHtml(b.bodyHtml);
  const now = Date.now();
  const id = ulid(now);
  // The cap is part of the insert, so concurrent creates cannot overshoot it.
  const res = await c.env.DB.prepare(
    `INSERT INTO reply_templates (id, mailbox_id, name, subject, body_html, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6 WHERE (SELECT COUNT(*) FROM reply_templates WHERE mailbox_id = ?2) < ?7`,
  ).bind(id, mb, b.name, b.subject, html, now, MAX_TEMPLATES_PER_MAILBOX).run();
  if (!res.meta.changes) throw new HttpError(409, 'TOO_MANY_TEMPLATES', `At most ${MAX_TEMPLATES_PER_MAILBOX} templates per mailbox`);
  return c.json(toApi({ id, name: b.name, subject: b.subject, body_html: html, updated_at: now }), 201);
});

templates.patch('/templates/:id', async (c) => {
  const b = await jsonBody(c, TemplateSchema);
  const html = await sanitizeTemplateHtml(b.bodyHtml);
  const now = Date.now();
  const id = c.req.param('id');
  const res = await c.env.DB.prepare('UPDATE reply_templates SET name = ?, subject = ?, body_html = ?, updated_at = ? WHERE id = ? AND mailbox_id = ?')
    .bind(b.name, b.subject, html, now, id, c.get('mailbox').id).run();
  if (!res.meta.changes) throw notFound('Template not found');
  return c.json(toApi({ id, name: b.name, subject: b.subject, body_html: html, updated_at: now }));
});

templates.delete('/templates/:id', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM reply_templates WHERE id = ? AND mailbox_id = ?').bind(c.req.param('id'), c.get('mailbox').id).run();
  if (!res.meta.changes) throw notFound('Template not found');
  return c.json({ ok: true });
});
