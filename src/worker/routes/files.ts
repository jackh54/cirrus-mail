import { Hono } from 'hono';
import type { AttachmentRow } from '../lib/db';
import { HttpError, notFound } from '../lib/errors';
import { verifyFileSig } from '../lib/sign';
import type { AppEnv } from '../types';

export const files = new Hono<AppEnv>();

// Raster image types that are safe to render inline. SVG is always downloaded.
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon']);

/** Signed download: the signature is the authorization (the sandboxed iframe sends no cookies). */
files.get('/:aid', async (c) => {
  const aid = c.req.param('aid');
  if (!(await verifyFileSig(c.env, aid, c.req.query('e'), c.req.query('s')))) {
    throw new HttpError(403, 'INVALID_SIGNATURE', 'This link is invalid or has expired');
  }
  const a = await c.env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(aid).first<AttachmentRow>();
  if (!a) throw notFound('Attachment not found');
  const obj = await c.env.BUCKET.get(a.r2_key);
  if (!obj) throw notFound('Attachment not found');
  const inline = c.req.query('inline') === '1' && INLINE_TYPES.has(a.mime_type);
  const encoded = encodeURIComponent(a.filename);
  const ascii = a.filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return new Response(obj.body, {
    headers: {
      'content-type': inline ? a.mime_type : a.mime_type.startsWith('text/') || a.mime_type.includes('html') || a.mime_type.includes('svg') ? 'application/octet-stream' : a.mime_type,
      'content-length': String(obj.size),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
    },
  });
});
