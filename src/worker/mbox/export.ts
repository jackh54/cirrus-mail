// mbox export: walks a mailbox's messages in pages and streams them as mboxrd. A message with its raw .eml in R2 is
// written as stored; one without (sent mail, drafts-turned-sent) is rebuilt from the parsed parts.
import type { Address } from '../../shared/api';
import { parseJsonAddresses } from '../lib/addresses';
import { loadRowBody, type AttachmentRow } from '../lib/db';
import { cleanHeaderText } from '../lib/validate';
import { asctime, escapeMboxrd } from './format';

const PAGE = 50;
const enc = new TextEncoder();

export type ExportScope = { kind: 'mailbox' } | { kind: 'folder'; id: string } | { kind: 'label'; id: string };

interface ExportRow {
  id: string; from_email: string; from_name: string; to_json: string; cc_json: string; reply_to: string | null; subject: string;
  message_id_hdr: string | null; in_reply_to: string | null; references_hdr: string | null; body_key: string | null; body_inline: string | null;
  raw_key: string | null; date: number; display_date: number | null;
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const wrap76 = (s: string) => s.replace(/.{1,76}/g, '$&\r\n');

/** RFC 2047 encoded word for header text that is not plain ASCII. */
function headerText(s: string): string {
  const clean = cleanHeaderText(s);
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${b64(enc.encode(clean))}?=`;
}

function addressHeader(list: Address[]): string {
  return list.map((a) => {
    if (!a.name) return a.email;
    const clean = cleanHeaderText(a.name);
    return /^[\x20-\x7e]*$/.test(clean) ? `"${clean.replace(/["\\]/g, '\\$&')}" <${a.email}>` : `${headerText(clean)} <${a.email}>`;
  }).join(', ');
}

/** A reasonable RFC 5322 message from the parsed parts: headers, text and/or html, and attachments from R2. */
export async function rebuildMessage(env: Env, r: ExportRow): Promise<Uint8Array> {
  const [body, { results: atts }] = await Promise.all([
    loadRowBody(env, r),
    env.DB.prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at, id').bind(r.id).all<AttachmentRow>(),
  ]);
  const from: Address = r.from_name ? { email: r.from_email, name: r.from_name } : { email: r.from_email };
  const h: string[] = [
    `From: ${addressHeader([from])}`,
    `To: ${addressHeader(parseJsonAddresses(r.to_json))}`,
  ];
  const cc = parseJsonAddresses(r.cc_json);
  if (cc.length) h.push(`Cc: ${addressHeader(cc)}`);
  if (r.reply_to) h.push(`Reply-To: ${cleanHeaderText(r.reply_to)}`);
  h.push(`Subject: ${headerText(r.subject)}`, `Date: ${new Date(r.display_date ?? r.date).toUTCString()}`,
    `Message-ID: ${r.message_id_hdr ? cleanHeaderText(r.message_id_hdr) : `<${r.id}@export.invalid>`}`);
  if (r.in_reply_to) h.push(`In-Reply-To: ${cleanHeaderText(r.in_reply_to)}`);
  if (r.references_hdr) h.push(`References: ${cleanHeaderText(r.references_hdr)}`);
  h.push('MIME-Version: 1.0');

  const part = (type: string, content: string) =>
    `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(enc.encode(content)))}`;
  const bodyParts: string[] = [];
  if (body.text != null || body.html == null) bodyParts.push(part('text/plain', body.text ?? ''));
  if (body.html != null) bodyParts.push(part('text/html', body.html));
  const tag = r.id.toLowerCase();
  let content: string;
  let contentType: string;
  if (bodyParts.length === 1) {
    [content] = bodyParts;
    contentType = '';
  } else {
    contentType = `multipart/alternative; boundary="alt-${tag}"`;
    content = bodyParts.map((p) => `--alt-${tag}\r\n${p}`).join('') + `--alt-${tag}--\r\n`;
  }
  let out: string;
  if (!atts.length) {
    out = contentType ? `${h.join('\r\n')}\r\nContent-Type: ${contentType}\r\n\r\n${content}` : `${h.join('\r\n')}\r\n${content}`;
  } else {
    const parts: string[] = [contentType ? `Content-Type: ${contentType}\r\n\r\n${content}` : content];
    for (const a of atts) {
      const obj = await env.BUCKET.get(a.r2_key);
      if (!obj) continue;
      const name = headerText(a.filename).replace(/["\\]/g, '_');
      parts.push(
        `Content-Type: ${a.mime_type}; name="${name}"\r\nContent-Transfer-Encoding: base64\r\n` +
        (a.content_id ? `Content-ID: <${a.content_id}>\r\nContent-Disposition: inline; filename="${name}"` : `Content-Disposition: attachment; filename="${name}"`) +
        `\r\n\r\n${wrap76(b64(new Uint8Array(await obj.arrayBuffer())))}`,
      );
    }
    out = `${h.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="mix-${tag}"\r\n\r\n` +
      parts.map((p) => `--mix-${tag}\r\n${p}\r\n`).join('') + `--mix-${tag}--\r\n`;
  }
  return enc.encode(out);
}

async function messageBytes(env: Env, r: ExportRow): Promise<Uint8Array> {
  if (r.raw_key) {
    const obj = await env.BUCKET.get(r.raw_key);
    if (obj) return new Uint8Array(await obj.arrayBuffer());
  }
  return rebuildMessage(env, r);
}

/** `From <addr> <asctime>` for a message; the address has no whitespace by construction. */
function separator(r: ExportRow): Uint8Array {
  const addr = /^[^\s]+$/.test(r.from_email) ? r.from_email : 'MAILER-DAEMON';
  return enc.encode(`From ${addr} ${asctime(r.display_date ?? r.date)}\n`);
}

/**
 * A streaming mboxrd body. Messages are read 50 at a time, ordered by (date, id) with a keyset cursor; the
 * writer waits for the reader, so memory stays at about one page. Only received and sent messages are exported.
 */
export function exportStream(env: Env, mailboxId: string, scope: ExportScope): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  const extra = scope.kind === 'folder' ? ' AND m.folder_id = ?'
    : scope.kind === 'label' ? ' AND EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND ml.label_id = ?)' : '';
  const sql = `SELECT m.id, m.from_email, m.from_name, m.to_json, m.cc_json, m.reply_to, m.subject, m.message_id_hdr, m.in_reply_to,
      m.references_hdr, m.body_key, m.body_inline, m.raw_key, m.date, m.display_date
    FROM messages m WHERE m.mailbox_id = ? AND m.status IN ('received','sent')${extra} AND (m.date > ? OR (m.date = ? AND m.id > ?))
    ORDER BY m.date, m.id LIMIT ${PAGE}`;
  void (async () => {
    try {
      let lastDate = -1;
      let lastId = '';
      for (;;) {
        const binds = scope.kind === 'mailbox' ? [mailboxId] : [mailboxId, scope.id];
        const { results } = await env.DB.prepare(sql).bind(...binds, lastDate, lastDate, lastId).all<ExportRow>();
        for (const r of results) {
          let bytes = escapeMboxrd(await messageBytes(env, r));
          if (bytes.length && bytes[bytes.length - 1] !== 10) {
            const padded = new Uint8Array(bytes.length + 1);
            padded.set(bytes);
            padded[bytes.length] = 10;
            bytes = padded;
          }
          await w.write(separator(r));
          await w.write(bytes);
          await w.write(enc.encode('\n'));
          lastDate = r.date;
          lastId = r.id;
        }
        if (results.length < PAGE) break;
      }
      await w.close();
    } catch (e) {
      console.error('mbox export error', (e as Error).name);
      await w.abort(e).catch(() => undefined);
    }
  })();
  return readable;
}
