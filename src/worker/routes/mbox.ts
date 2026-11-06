import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { MBOX_LIMITS, type MboxImport, type MboxImportStatus } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors';
import { hit } from '../lib/ratelimit';
import { jsonBody, zHeaderText, zId } from '../lib/validate';
import { exportStream, type ExportScope } from '../mbox/export';
import type { ImportRow } from '../mbox/import';
import type { AppEnv } from '../types';

/** Mailbox-scoped (mounted behind requireMailbox): any member can import into and export from the mailbox. */
export const mbox = new Hono<AppEnv>();

const ACTIVE: MboxImportStatus[] = ['uploading', 'processing'];

function toApi(r: ImportRow): MboxImport {
  const parts = JSON.parse(r.parts_json) as [number, string][];
  return {
    id: r.id, status: r.status as MboxImportStatus, filename: r.filename, size: r.size, partSize: MBOX_LIMITS.partBytes,
    uploadedParts: r.status === 'uploading' ? parts.map((p) => p[0]) : [], folderId: r.folder_id, markRead: !!r.mark_read,
    bytesProcessed: r.status === 'done' ? r.size : r.status === 'uploading' ? 0 : r.cursor,
    imported: r.imported, duplicates: r.duplicates, skipped: r.skipped, errors: r.error_count,
    errorSamples: JSON.parse(r.errors_json) as string[], createdAt: r.created_at, finishedAt: r.finished_at,
  };
}

const partCount = (size: number) => Math.ceil(size / MBOX_LIMITS.partBytes);

async function loadImport(c: Context<AppEnv>): Promise<ImportRow> {
  const row = await c.env.DB.prepare('SELECT * FROM mbox_imports WHERE id = ? AND mailbox_id = ?').bind(c.req.param('id'), c.get('mailbox').id).first<ImportRow>();
  if (!row) throw notFound('Import not found');
  return row;
}

/** Uploading is limited to whoever started the import. */
function ownUpload(row: ImportRow, userId: string): void {
  if (row.user_id !== userId) throw forbidden('Only the person who started this import can upload it');
  if (row.status !== 'uploading' || !row.upload_id) throw new HttpError(409, 'NOT_UPLOADING', 'This import is no longer accepting data');
}

mbox.get('/import', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM mbox_imports WHERE mailbox_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').bind(c.get('mailbox').id).first<ImportRow>();
  return c.json(row ? toApi(row) : null);
});

const StartSchema = z.object({
  filename: zHeaderText(255, 1),
  size: z.number().int().min(1).max(MBOX_LIMITS.maxFileBytes),
  folderId: zId.optional(),
  markRead: z.boolean().optional(),
});

mbox.post('/import', async (c) => {
  const body = await jsonBody(c, StartSchema);
  const mb = c.get('mailbox').id;
  const db = c.env.DB;
  if (body.folderId) {
    const ok = await db.prepare("SELECT 1 FROM folders WHERE id = ? AND mailbox_id = ? AND (role IS NULL OR role NOT IN ('drafts','scheduled'))").bind(body.folderId, mb).first();
    if (!ok) throw badRequest('Choose a folder in this mailbox', 'INVALID_FOLDER');
  }
  const busy = () => new HttpError(409, 'IMPORT_ACTIVE', 'This mailbox already has an import in progress');
  if (await db.prepare(`SELECT 1 FROM mbox_imports WHERE mailbox_id = ? AND status IN ('uploading','processing')`).bind(mb).first()) throw busy();
  const id = ulid();
  const key = `import/${mb}/${id}.mbox`;
  const upload = await c.env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: 'application/mbox' } });
  const now = Date.now();
  try {
    // Only the newest import is kept: earlier finished ones are replaced.
    await db.batch([
      db.prepare("DELETE FROM mbox_imports WHERE mailbox_id = ? AND status NOT IN ('uploading','processing')").bind(mb),
      db.prepare(
        `INSERT INTO mbox_imports (id, mailbox_id, user_id, status, filename, r2_key, upload_id, size, folder_id, mark_read, created_at, updated_at)
         VALUES (?, ?, ?, 'uploading', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, mb, c.get('user').id, body.filename, key, upload.uploadId, body.size, body.folderId ?? null, body.markRead === false ? 0 : 1, now, now),
    ]);
  } catch {
    await upload.abort().catch(() => undefined);
    throw busy();
  }
  const row = (await db.prepare('SELECT * FROM mbox_imports WHERE id = ?').bind(id).first<ImportRow>())!;
  return c.json(toApi(row), 201);
});

mbox.put('/import/:id/parts/:n', async (c) => {
  const row = await loadImport(c);
  ownUpload(row, c.get('user').id);
  const n = Number(c.req.param('n'));
  const total = partCount(row.size);
  if (!Number.isInteger(n) || n < 1 || n > total) throw badRequest('No such part', 'BAD_PART');
  const expected = n < total ? MBOX_LIMITS.partBytes : row.size - (total - 1) * MBOX_LIMITS.partBytes;
  if (Number(c.req.header('content-length') ?? 0) > expected) throw new HttpError(413, 'PART_TOO_LARGE', 'Part is larger than expected');
  const data = await c.req.arrayBuffer();
  if (data.byteLength !== expected) throw badRequest(`Part ${n} must be ${expected} bytes`, 'BAD_PART_SIZE');
  let etag: string;
  try {
    etag = (await c.env.BUCKET.resumeMultipartUpload(row.r2_key, row.upload_id!).uploadPart(n, data)).etag;
  } catch {
    throw new HttpError(502, 'UPLOAD_FAILED', 'Storage rejected the part. Try again.');
  }
  // Re-read so parts stored by a concurrent request are kept; a missing one is caught by /complete.
  const fresh = (await c.env.DB.prepare("SELECT parts_json FROM mbox_imports WHERE id = ? AND status = 'uploading'").bind(row.id).first<string>('parts_json')) ?? '[]';
  const parts = (JSON.parse(fresh) as [number, string][]).filter((p) => p[0] !== n);
  parts.push([n, etag]);
  const res = await c.env.DB.prepare("UPDATE mbox_imports SET parts_json = ?, updated_at = ? WHERE id = ? AND status = 'uploading'")
    .bind(JSON.stringify(parts), Date.now(), row.id).run();
  if (!res.meta.changes) throw new HttpError(409, 'NOT_UPLOADING', 'This import is no longer accepting data');
  return c.json({ ok: true, part: n });
});

mbox.post('/import/:id/complete', async (c) => {
  const row = await loadImport(c);
  ownUpload(row, c.get('user').id);
  const total = partCount(row.size);
  const parts = new Map(JSON.parse(row.parts_json) as [number, string][]);
  const missing: number[] = [];
  for (let i = 1; i <= total; i++) if (!parts.has(i)) missing.push(i);
  if (missing.length) throw new HttpError(409, 'MISSING_PARTS', 'Some parts have not been uploaded', { missing: missing.slice(0, 50) });
  const upload = c.env.BUCKET.resumeMultipartUpload(row.r2_key, row.upload_id!);
  try {
    await upload.complete([...parts].sort((a, b) => a[0] - b[0]).map(([partNumber, etag]) => ({ partNumber, etag })));
  } catch {
    throw new HttpError(400, 'UPLOAD_INCOMPLETE', 'The upload could not be assembled. Start the import again.');
  }
  const head = await c.env.BUCKET.head(row.r2_key);
  if (!head || head.size !== row.size) {
    await c.env.BUCKET.delete(row.r2_key).catch(() => undefined);
    await c.env.DB.prepare("UPDATE mbox_imports SET status = 'failed', upload_id = NULL, errors_json = ?, error_count = 1, finished_at = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(['size_mismatch']), Date.now(), Date.now(), row.id).run();
    throw badRequest('The uploaded size does not match the file size', 'SIZE_MISMATCH');
  }
  const now = Date.now();
  await c.env.DB.prepare("UPDATE mbox_imports SET status = 'processing', upload_id = NULL, parts_json = '[]', updated_at = ? WHERE id = ? AND status = 'uploading'")
    .bind(now, row.id).run();
  return c.json(toApi((await loadImport(c))));
});

/** Cancels an active import (the uploaded object is deleted, mail already imported stays); a finished one is just dismissed. */
mbox.delete('/import/:id', async (c) => {
  const row = await loadImport(c);
  const db = c.env.DB;
  const now = Date.now();
  if (!ACTIVE.includes(row.status as MboxImportStatus)) {
    await db.prepare('DELETE FROM mbox_imports WHERE id = ? AND mailbox_id = ?').bind(row.id, row.mailbox_id).run();
    return c.json({ ok: true });
  }
  if (row.upload_id) await c.env.BUCKET.resumeMultipartUpload(row.r2_key, row.upload_id).abort().catch(() => undefined);
  await db.prepare("UPDATE mbox_imports SET status = 'cancelled', upload_id = NULL, lease_until = 0, finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('uploading','processing')")
    .bind(now, now, row.id).run();
  await c.env.BUCKET.delete(row.r2_key).catch(() => undefined);
  return c.json({ ok: true });
});

const ExportQuery = z.object({ scope: z.enum(['mailbox', 'folder', 'label']).default('mailbox'), id: zId.optional() });

function fileSlug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'mail';
}

mbox.get('/export', async (c) => {
  const q = ExportQuery.parse({ scope: c.req.query('scope') || undefined, id: c.req.query('id') || undefined });
  const mb = c.get('mailbox');
  const db = c.env.DB;
  let scope: ExportScope = { kind: 'mailbox' };
  let name = 'all';
  if (q.scope !== 'mailbox') {
    if (!q.id) throw badRequest('id is required', 'BAD_REQUEST');
    const row = q.scope === 'folder'
      ? await db.prepare("SELECT name FROM folders WHERE id = ? AND mailbox_id = ? AND role NOT IN ('drafts','scheduled')").bind(q.id, mb.id).first<{ name: string }>()
      : await db.prepare('SELECT name FROM labels WHERE id = ? AND mailbox_id = ?').bind(q.id, mb.id).first<{ name: string }>();
    if (!row) throw notFound(q.scope === 'folder' ? 'Folder not found' : 'Label not found');
    scope = { kind: q.scope, id: q.id };
    name = row.name;
  }
  if ((await hit(db, `mbox-export:${c.get('user').id}`, 3600_000)) > MBOX_LIMITS.exportsPerHour) {
    throw new HttpError(429, 'RATE_LIMITED', 'Too many exports. Try again in an hour.');
  }
  const day = new Date().toISOString().slice(0, 10);
  return new Response(exportStream(c.env, mb.id, scope), {
    headers: {
      'content-type': 'application/mbox',
      'content-disposition': `attachment; filename="${fileSlug(mb.address)}-${fileSlug(name)}-${day}.mbox"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});
