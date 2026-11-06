// Blobs: m_<messageId> raw message, t_/h_<messageId> the text and HTML parts, a_<attachmentId>, u_<uploadId> uploads.
// Every lookup is scoped by mailbox_id = accountId, and the caller has already checked membership of that account.
import { toBase64 } from '../lib/crypto';
import type { AttachmentRow, MessageRow } from '../lib/db';
import { loadRowBody } from '../lib/db';
import { parseJsonAddresses } from '../lib/addresses';
import { htmlToText } from '../lib/html';
import { ulid } from '../../shared/ulid';
import { LIMITS_JMAP } from './core';

export type BlobKind = 'm' | 't' | 'h' | 'a' | 'u';
export const blobId = (kind: BlobKind, id: string) => `${kind}_${id}`;

export function parseBlobId(b: string): { kind: BlobKind; id: string } | null {
  const m = /^([mthau])_([A-Za-z0-9]{1,64})$/.exec(b);
  return m ? { kind: m[1] as BlobKind, id: m[2] } : null;
}

export const uploadKey = (mb: string, id: string) => `jmapup/${mb}/${id}`;

export interface BlobData { bytes: Uint8Array; type: string; name: string | null }

const enc = new TextEncoder();

function encodeWord(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${toBase64(enc.encode(s))}?=`;
}

function addr(a: { email: string; name?: string }): string {
  const name = a.name?.replace(/[\r\n"\\]/g, ' ').trim();
  return name ? `${encodeWord(name)} <${a.email}>` : a.email;
}

const wrap76 = (b64: string) => b64.replace(/.{76}/g, '$&\r\n');

/** A best-effort RFC 5322 rendering of a message Cirrus stores structured (sent mail, drafts) instead of raw. */
export async function synthesizeRaw(env: Env, row: MessageRow, atts: AttachmentRow[]): Promise<Uint8Array> {
  const body = await loadRowBody(env, row);
  const text = body.text ?? (body.html ? htmlToText(body.html) : '');
  const h: string[] = [
    `From: ${addr({ email: row.from_email, name: row.from_name })}`,
    `Subject: ${encodeWord(row.subject.replace(/[\r\n]+/g, ' '))}`,
    `Date: ${new Date(row.display_date ?? row.date).toUTCString()}`,
    'MIME-Version: 1.0',
  ];
  const list = (name: string, json: string) => {
    const l = parseJsonAddresses(json);
    if (l.length) h.push(`${name}: ${l.map(addr).join(', ')}`);
  };
  list('To', row.to_json);
  list('Cc', row.cc_json);
  if (row.message_id_hdr) h.push(`Message-ID: ${row.message_id_hdr}`);
  if (row.in_reply_to) h.push(`In-Reply-To: ${row.in_reply_to.replace(/[\r\n]+/g, ' ')}`);
  if (row.references_hdr) h.push(`References: ${row.references_hdr.replace(/[\r\n]+/g, ' ')}`);
  const part = (type: string, content: string) =>
    `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(toBase64(enc.encode(content)))}`;
  const alt = body.html
    ? (() => {
        const b = `alt${ulid()}`;
        return { type: `multipart/alternative; boundary="${b}"`, body: `--${b}\r\n${part('text/plain', text)}\r\n--${b}\r\n${part('text/html', body.html)}\r\n--${b}--` };
      })()
    : { type: 'text/plain; charset=utf-8', body: wrap76(toBase64(enc.encode(text))), cte: true };
  if (!atts.length) {
    h.push(`Content-Type: ${alt.type}`);
    if ('cte' in alt) h.push('Content-Transfer-Encoding: base64');
    return enc.encode(`${h.join('\r\n')}\r\n\r\n${alt.body}\r\n`);
  }
  const b = `mix${ulid()}`;
  h.push(`Content-Type: multipart/mixed; boundary="${b}"`);
  const chunks: string[] = [`${h.join('\r\n')}\r\n\r\n--${b}\r\nContent-Type: ${alt.type}\r\n${'cte' in alt ? 'Content-Transfer-Encoding: base64\r\n' : ''}\r\n${alt.body}\r\n`];
  for (const a of atts) {
    const obj = await env.BUCKET.get(a.r2_key);
    if (!obj) continue;
    const name = a.filename.replace(/[\r\n"\\]/g, '_');
    chunks.push(
      `--${b}\r\nContent-Type: ${a.mime_type}; name="${name}"\r\nContent-Transfer-Encoding: base64\r\n` +
      `Content-Disposition: ${a.inline ? 'inline' : 'attachment'}; filename="${name}"\r\n${a.content_id ? `Content-ID: <${a.content_id}>\r\n` : ''}\r\n` +
      `${wrap76(toBase64(new Uint8Array(await obj.arrayBuffer())))}\r\n`,
    );
  }
  chunks.push(`--${b}--\r\n`);
  return enc.encode(chunks.join(''));
}

/** The bytes behind a blob id inside account `mb`, or null when it does not exist there. */
export async function loadBlob(env: Env, mb: string, id: string): Promise<BlobData | null> {
  const p = parseBlobId(id);
  if (!p) return null;
  const db = env.DB;
  if (p.kind === 'u') {
    const up = await db.prepare('SELECT type FROM jmap_uploads WHERE id = ? AND mailbox_id = ?').bind(p.id, mb).first<{ type: string }>();
    const obj = up ? await env.BUCKET.get(uploadKey(mb, p.id)) : null;
    return obj ? { bytes: new Uint8Array(await obj.arrayBuffer()), type: up!.type, name: null } : null;
  }
  if (p.kind === 'a') {
    const a = await db.prepare('SELECT * FROM attachments WHERE id = ? AND mailbox_id = ?').bind(p.id, mb).first<AttachmentRow>();
    const obj = a ? await env.BUCKET.get(a.r2_key) : null;
    return obj ? { bytes: new Uint8Array(await obj.arrayBuffer()), type: a!.mime_type, name: a!.filename } : null;
  }
  const m = await db.prepare('SELECT * FROM messages WHERE id = ? AND mailbox_id = ?').bind(p.id, mb).first<MessageRow>();
  if (!m) return null;
  if (p.kind === 't' || p.kind === 'h') {
    const body = await loadRowBody(env, m);
    const value = p.kind === 'h' ? body.html : body.text ?? (body.html ? htmlToText(body.html) : '');
    if (value === null || value === undefined) return null;
    return { bytes: enc.encode(value), type: p.kind === 'h' ? 'text/html' : 'text/plain', name: null };
  }
  if (m.raw_key) {
    const obj = await env.BUCKET.get(m.raw_key);
    if (obj) return { bytes: new Uint8Array(await obj.arrayBuffer()), type: 'message/rfc822', name: 'message.eml' };
  }
  const { results } = await db.prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at, id').bind(m.id).all<AttachmentRow>();
  return { bytes: await synthesizeRaw(env, m, results), type: 'message/rfc822', name: 'message.eml' };
}

/** Reads a request body with a hard cap, without trusting Content-Length. Null when over the cap. */
export async function readCapped(request: Request, cap: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

const MAX_PENDING_UPLOADS = 100;

/** POST /jmap/upload/{accountId}/: stores the body in R2 and records it for the TTL cleanup. */
export async function handleUpload(request: Request, env: Env, mb: string, userId: string): Promise<Response> {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const pending = await env.DB.prepare('SELECT COUNT(*) AS n FROM jmap_uploads WHERE mailbox_id = ?').bind(mb).first<number>('n');
  if ((pending ?? 0) >= MAX_PENDING_UPLOADS) {
    return json(429, { type: 'urn:ietf:params:jmap:error:limit', limit: 'maxConcurrentUpload', status: 429, detail: 'Too many pending uploads; they expire after a few hours' });
  }
  const bytes = await readCapped(request, LIMITS_JMAP.maxSizeUpload);
  if (!bytes) return json(413, { type: 'urn:ietf:params:jmap:error:limit', limit: 'maxSizeUpload', status: 413 });
  const type = (request.headers.get('content-type') ?? 'application/octet-stream').toLowerCase().split(';')[0].trim().slice(0, 200) || 'application/octet-stream';
  const id = ulid();
  await env.BUCKET.put(uploadKey(mb, id), bytes, { httpMetadata: { contentType: type } });
  await env.DB.prepare('INSERT INTO jmap_uploads (id, mailbox_id, user_id, size, type, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, mb, userId, bytes.byteLength, type, Date.now()).run();
  return json(201, { accountId: mb, blobId: blobId('u', id), type, size: bytes.byteLength });
}

export const UPLOAD_TTL_MS = 6 * 3600 * 1000;

/** Cron: removes expired uploads (R2 object and row). */
export async function pruneUploads(env: Env, now: number): Promise<void> {
  const { results } = await env.DB.prepare('SELECT id, mailbox_id FROM jmap_uploads WHERE created_at < ? LIMIT 200').bind(now - UPLOAD_TTL_MS).all<{ id: string; mailbox_id: string }>();
  if (!results.length) return;
  await env.BUCKET.delete(results.map((r) => uploadKey(r.mailbox_id, r.id)));
  await env.DB.prepare('DELETE FROM jmap_uploads WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(results.map((r) => r.id))).run();
}
