// PGP/MIME (RFC 3156) sending. The browser produces the armored OpenPGP message; this only wraps it in the
// multipart/encrypted envelope and hands raw MIME to Email Sending. Nothing here can read the content.
import { EmailMessage } from 'cloudflare:email';
import type { Address } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { domainOf } from '../lib/addresses';
import type { MessageRow } from '../lib/db';
import { armoredToBase64 } from '../lib/pgp';
import { cleanHeaderText } from '../lib/validate';

const CRLF = '\r\n';

/** RFC 2047 encoded-words (UTF-8, base64), each at most 45 bytes of text, joined by folding whitespace. */
function encodedWords(s: string): string {
  const words: string[] = [];
  let chunk = '';
  const enc = new TextEncoder();
  const flush = () => {
    if (!chunk) return;
    let bin = '';
    for (const b of enc.encode(chunk)) bin += String.fromCharCode(b);
    words.push(`=?UTF-8?B?${btoa(bin)}?=`);
    chunk = '';
  };
  for (const ch of s) {
    if (enc.encode(chunk + ch).length > 45) flush();
    chunk += ch;
  }
  flush();
  return words.join(CRLF + ' ');
}

/** A header value that is safe on one logical line: plain when short ASCII, encoded words otherwise. */
export function encodeText(s: string): string {
  const t = cleanHeaderText(s);
  return /^[\x20-\x7e]{0,60}$/.test(t) ? t : encodedWords(t);
}

function formatAddress(a: Address): string {
  const name = a.name ? cleanHeaderText(a.name).trim() : '';
  if (!name) return a.email;
  if (/[^\x20-\x7e]/.test(name)) return `${encodedWords(name)} <${a.email}>`;
  return `"${name.replace(/(["\\])/g, '\\$1')}" <${a.email}>`;
}

const addressList = (list: Address[]) => list.map(formatAddress).join(`,${CRLF} `);

/** A space-separated list of Message-IDs as one header, folded at spaces (CRLF + space) so no line passes 78 characters. */
function foldIds(name: string, value: string): string {
  let out = `${name}:`;
  let line = out.length;
  for (const id of cleanHeaderText(value).split(/\s+/).filter(Boolean)) {
    if (line + 1 + id.length > 78 && line > name.length + 1) {
      out += CRLF + ' ' + id;
      line = 1 + id.length;
    } else {
      out += ' ' + id;
      line += 1 + id.length;
    }
  }
  return out;
}

export interface PgpMimeInput {
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  messageId: string;            // with angle brackets
  date: Date;
  inReplyTo?: string | null;
  references?: string | null;
  armored: string;              // the armored OpenPGP message, as produced by the browser
  autocryptKeydata?: string | null; // base64 of the sender's binary public key
  boundary: string;
}

/** The complete RFC 822 message, CRLF line endings. The armored payload is copied through byte for byte (line endings aside). */
export function buildPgpMime(i: PgpMimeInput): string {
  const h = [
    `From: ${formatAddress(i.from)}`,
    ...(i.to.length ? [`To: ${addressList(i.to)}`] : []),
    ...(i.cc.length ? [`Cc: ${addressList(i.cc)}`] : []),
    `Subject: ${encodeText(i.subject)}`,
    `Date: ${i.date.toUTCString()}`,
    `Message-ID: ${cleanHeaderText(i.messageId)}`,
    ...(i.inReplyTo ? [foldIds('In-Reply-To', i.inReplyTo)] : []),
    ...(i.references ? [foldIds('References', i.references)] : []),
    'MIME-Version: 1.0',
    ...(i.autocryptKeydata ? [`Autocrypt: addr=${i.from.email}; keydata=${i.autocryptKeydata.replace(/.{1,72}/g, `${CRLF} $&`)}`] : []),
    `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${i.boundary}"`,
  ];
  const payload = i.armored.trim().replace(/\r?\n/g, CRLF);
  return [
    h.join(CRLF), '',
    `--${i.boundary}`,
    'Content-Type: application/pgp-encrypted',
    'Content-Description: PGP/MIME version identification', '',
    'Version: 1', '',
    `--${i.boundary}`,
    'Content-Type: application/octet-stream; name="encrypted.asc"',
    'Content-Description: OpenPGP encrypted message',
    'Content-Disposition: inline; filename="encrypted.asc"', '',
    payload,
    `--${i.boundary}--`, '',
  ].join(CRLF);
}

/** The sender's public key for the Autocrypt header: the first of these users whose key is live and covers `from`. */
async function autocryptKeydata(db: D1Database, userIds: string[], from: string): Promise<string | null> {
  if (!userIds.length) return null;
  const ph = userIds.map(() => '?').join(',');
  const { results } = await db.prepare(`SELECT public_key, addresses FROM pgp_keys WHERE user_id IN (${ph}) AND revoked = 0 ORDER BY created_at`)
    .bind(...userIds).all<{ public_key: string; addresses: string }>();
  for (const r of results) {
    try {
      if ((JSON.parse(r.addresses) as string[]).includes(from.toLowerCase())) return armoredToBase64(r.public_key);
    } catch { /* skip a row with unreadable addresses */ }
  }
  return null;
}

/**
 * Sends the PGP/MIME message. Raw MIME goes out one envelope per recipient (Bcc recipients get the same bytes
 * without a Bcc header). Throws the first error when nothing could be sent; once one recipient succeeded, later
 * failures are logged and the send counts as done, since resending would deliver twice to the others.
 */
export async function sendPgpMime(
  env: Env, row: MessageRow, armored: string, rcpts: { to: Address[]; cc: Address[]; bcc: Address[] }, userIds: string[],
): Promise<{ messageId: string }> {
  const messageId = `<${ulid()}@${domainOf(row.from_email) || 'localhost'}>`;
  const raw = buildPgpMime({
    from: { email: row.from_email, name: row.from_name }, to: rcpts.to, cc: rcpts.cc, subject: row.subject, messageId, date: new Date(),
    inReplyTo: row.in_reply_to, references: row.references_hdr, armored,
    autocryptKeydata: await autocryptKeydata(env.DB, userIds, row.from_email), boundary: `=_cirrus_${ulid()}`,
  });
  const envelope = [...new Set([...rcpts.to, ...rcpts.cc, ...rcpts.bcc].map((a) => a.email.toLowerCase()))];
  let sent = 0;
  let firstError: unknown;
  for (const rcpt of envelope) {
    try {
      await env.EMAIL.send(new EmailMessage(row.from_email, rcpt, raw));
      sent++;
    } catch (e) {
      firstError ??= e;
      console.error('pgp/mime send failed', String((e as { code?: unknown }).code ?? (e as Error).name));
    }
  }
  if (!sent) throw firstError ?? new Error('No recipients');
  return { messageId };
}
