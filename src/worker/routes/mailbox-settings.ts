import { Hono } from 'hono';
import { z } from 'zod';
import type { MailboxSettings } from '../../shared/api';
import { jsonBody, zHeaderText } from '../lib/validate';
import type { AppEnv } from '../types';

export const mailboxSettings = new Hono<AppEnv>();

interface Row {
  display_name: string; signature_html: string; autoreply_enabled: number; autoreply_subject: string;
  autoreply_body: string; autoreply_start: number | null; autoreply_end: number | null;
}

async function load(db: D1Database, mb: string): Promise<MailboxSettings> {
  const r = (await db.prepare('SELECT * FROM mailboxes WHERE id = ?').bind(mb).first<Row>())!;
  return {
    displayName: r.display_name,
    signatureHtml: r.signature_html,
    autoreply: { enabled: !!r.autoreply_enabled, subject: r.autoreply_subject, body: r.autoreply_body, start: r.autoreply_start, end: r.autoreply_end },
  };
}

const SettingsSchema = z.object({
  displayName: zHeaderText(120),
  signatureHtml: z.string().max(20_000),
  autoreply: z.object({
    enabled: z.boolean(),
    subject: zHeaderText(200),
    body: z.string().max(10_000),
    start: z.number().int().nullable(),
    end: z.number().int().nullable(),
  }),
});

mailboxSettings.get('/settings', async (c) => c.json(await load(c.env.DB, c.get('mailbox').id)));

mailboxSettings.put('/settings', async (c) => {
  const b = await jsonBody(c, SettingsSchema);
  const mb = c.get('mailbox').id;
  await c.env.DB.prepare(
    `UPDATE mailboxes SET display_name = ?, signature_html = ?, autoreply_enabled = ?, autoreply_subject = ?, autoreply_body = ?,
       autoreply_start = ?, autoreply_end = ? WHERE id = ?`,
  ).bind(b.displayName, b.signatureHtml, b.autoreply.enabled ? 1 : 0, b.autoreply.subject, b.autoreply.body, b.autoreply.start, b.autoreply.end, mb).run();
  return c.json(await load(c.env.DB, mb));
});
