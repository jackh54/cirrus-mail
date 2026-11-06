#!/usr/bin/env node
// Builds a simple RFC 822 message and delivers it to the local Worker's email() handler.
//
//   node scripts/send-test-email.mjs --from a@example.test --to alex@cirrus.test \
//     --subject "Hello" --body "Hi there" [--attach ./file.pdf] [--url http://localhost:5173]
//
// Local endpoint: POST {url}/cdn-cgi/local/email?from=..&to=.. with the raw message as the body
// (the older /cdn-cgi/handler/email path is rewritten to it by wrangler and the Vite plugin).
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip' };

function encodeHeader(value) {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function wrap76(b64) {
  return b64.replace(/.{76}/g, '$&\r\n');
}

/**
 * @param {{ from: string, to: string, cc?: string, subject: string, text?: string, html?: string, date?: Date,
 *   messageId?: string, inReplyTo?: string, references?: string, headers?: Record<string,string>,
 *   attachments?: { filename: string, type: string, content: Buffer | Uint8Array, cid?: string }[] }} m
 */
export function buildEml(m) {
  const domain = (m.from.match(/@([^>\s]+)/) || [, 'localhost'])[1];
  const messageId = m.messageId ?? `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${domain}>`;
  const headers = [
    `From: ${encodeHeader(m.from)}`,
    `To: ${m.to}`,
    ...(m.cc ? [`Cc: ${m.cc}`] : []),
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${(m.date ?? new Date()).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references || m.inReplyTo ? [`References: ${m.references ?? m.inReplyTo}`] : []),
    ...Object.entries(m.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
  ];
  const b = () => `=_cirrus_${Math.random().toString(36).slice(2)}`;
  const textPart = (type, body) => `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(Buffer.from(body, 'utf8').toString('base64'))}`;
  let body;
  if (m.html) {
    const alt = b();
    body = `Content-Type: multipart/alternative; boundary="${alt}"\r\n\r\n` +
      `--${alt}\r\n${textPart('text/plain', m.text ?? m.html.replace(/<[^>]+>/g, ''))}\r\n` +
      `--${alt}\r\n${textPart('text/html', m.html)}\r\n--${alt}--`;
  } else {
    body = textPart('text/plain', m.text ?? '');
  }
  if (m.attachments?.length) {
    const mixed = b();
    const parts = m.attachments.map((a) =>
      `Content-Type: ${a.type}; name="${a.filename}"\r\nContent-Transfer-Encoding: base64\r\n` +
      (a.cid ? `Content-ID: <${a.cid}>\r\nContent-Disposition: inline; filename="${a.filename}"` : `Content-Disposition: attachment; filename="${a.filename}"`) +
      `\r\n\r\n${wrap76(Buffer.from(a.content).toString('base64'))}`);
    body = `Content-Type: multipart/mixed; boundary="${mixed}"\r\n\r\n--${mixed}\r\n${body}\r\n` +
      parts.map((p) => `--${mixed}\r\n${p}\r\n`).join('') + `--${mixed}--`;
  }
  return { raw: `${headers.join('\r\n')}\r\n${body}\r\n`, messageId };
}

/** POSTs a raw message to the local email handler; returns the handler's JSON outcome (or text). */
export async function deliver(url, from, to, raw) {
  const endpoint = `${url.replace(/\/$/, '')}/cdn-cgi/local/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const res = await fetch(endpoint, { method: 'POST', body: raw, headers: { 'content-type': 'message/rfc822' } });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) throw new Error(`email handler returned ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  return parsed;
}

export function bareAddress(addr) {
  const m = addr.match(/<([^>]+)>/);
  return (m ? m[1] : addr).trim();
}

function parseArgs(argv) {
  const out = { attach: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    const v = argv[i + 1];
    i++;
    if (key === 'attach') out.attach.push(v);
    else out[key] = v;
  }
  return out;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.from || !a.to) {
    console.error('usage: send-test-email.mjs --from <addr> --to <addr> [--subject s] [--body text] [--attach path]... [--url http://localhost:5173]');
    process.exit(2);
  }
  const attachments = a.attach.map((p) => ({
    filename: basename(p),
    type: MIME[p.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream',
    content: readFileSync(p),
  }));
  const { raw, messageId } = buildEml({ from: a.from, to: a.to, subject: a.subject ?? 'Test message', text: a.body ?? 'Hello from send-test-email.mjs', attachments });
  const result = await deliver(a.url ?? 'http://localhost:5173', bareAddress(a.from), bareAddress(a.to), raw);
  console.log(`delivered ${messageId}`);
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
