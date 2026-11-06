import { env } from 'cloudflare:workers';
import { ulid } from '../src/shared/ulid';
import worker from '../src/worker/index';
import { SYSTEM_FOLDERS } from '../src/worker/lib/db';

export const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
export const BASE = 'http://localhost';

export function withEnv(overrides: Partial<Env>): Env {
  return new Proxy(env, { get: (t, k) => (k in overrides ? (overrides as Record<string | symbol, unknown>)[k] : Reflect.get(t, k)) });
}

export interface CallOpts { method?: string; body?: unknown; cookie?: string; csrf?: boolean; env?: Env; form?: FormData; headers?: Record<string, string> }

export async function call(path: string, o: CallOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { ...o.headers };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.csrf !== false) headers['x-cirrus'] = '1';
  let body: BodyInit | undefined;
  if (o.form) body = o.form;
  else if (o.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(o.body);
  }
  const req = new Request(BASE + path, { method: o.method ?? (body ? 'POST' : 'GET'), headers, body });
  return worker.fetch(req as Request<unknown, IncomingRequestCfProperties>, o.env ?? env, ctx);
}

export function sessionCookie(res: Response): string {
  const sc = res.headers.get('set-cookie') ?? '';
  const m = sc.match(/cirrus_session=([^;]+)/);
  if (!m) throw new Error('no session cookie');
  return `cirrus_session=${m[1]}`;
}

export async function ensureDomain(name: string): Promise<string> {
  const existing = await env.DB.prepare('SELECT id FROM domains WHERE name = ?').bind(name).first<string>('id');
  if (existing) return existing;
  const id = ulid();
  await env.DB.prepare('INSERT INTO domains (id, name, created_at) VALUES (?, ?, ?)').bind(id, name, Date.now()).run();
  return id;
}

/** Creates a mailbox (and its system folders) directly in D1; optionally with members. */
export async function createMailbox(address: string, members: { userId: string; role?: 'owner' | 'member' }[] = []): Promise<{ id: string; folders: Record<string, string> }> {
  const [local, domain] = address.split('@');
  const domainId = await ensureDomain(domain);
  const id = ulid();
  const now = Date.now();
  const folders: Record<string, string> = {};
  const stmts = [env.DB.prepare('INSERT INTO mailboxes (id, domain_id, local_part, address, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, domainId, local, address, '', now)];
  SYSTEM_FOLDERS.forEach((f, i) => {
    const fid = ulid();
    folders[f.role] = fid;
    stmts.push(env.DB.prepare('INSERT INTO folders (id, mailbox_id, name, role, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(fid, id, f.name, f.role, i, now));
  });
  for (const m of members) stmts.push(env.DB.prepare('INSERT INTO mailbox_members (mailbox_id, user_id, role) VALUES (?, ?, ?)').bind(id, m.userId, m.role ?? 'owner'));
  await env.DB.batch(stmts);
  return { id, folders };
}

export interface EmlOpts {
  from: string; to: string; subject: string; body?: string; html?: string; messageId?: string; inReplyTo?: string; references?: string;
  date?: Date; headers?: Record<string, string>; attachments?: { filename: string; type: string; content: Uint8Array; cid?: string }[];
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/.{76}/g, '$&\r\n');
}

export function buildEml(o: EmlOpts): string {
  const id = o.messageId ?? `<${ulid()}@test.example>`;
  const h = [
    `From: ${o.from}`, `To: ${o.to}`, `Subject: ${o.subject}`, `Date: ${(o.date ?? new Date()).toUTCString()}`, `Message-ID: ${id}`, 'MIME-Version: 1.0',
  ];
  if (o.inReplyTo) h.push(`In-Reply-To: ${o.inReplyTo}`);
  if (o.references) h.push(`References: ${o.references}`);
  for (const [k, v] of Object.entries(o.headers ?? {})) h.push(`${k}: ${v}`);
  const textPart = o.html
    ? `Content-Type: text/html; charset=utf-8\r\n\r\n${o.html}`
    : `Content-Type: text/plain; charset=utf-8\r\n\r\n${o.body ?? ''}`;
  if (!o.attachments?.length) return `${h.join('\r\n')}\r\n${textPart}\r\n`;
  const boundary = 'b' + ulid();
  const parts = [textPart, ...o.attachments.map((a) =>
    `Content-Type: ${a.type}; name="${a.filename}"\r\nContent-Transfer-Encoding: base64\r\n` +
    (a.cid ? `Content-ID: <${a.cid}>\r\nContent-Disposition: inline; filename="${a.filename}"` : `Content-Disposition: attachment; filename="${a.filename}"`) +
    `\r\n\r\n${b64(a.content)}`)];
  return `${h.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
    parts.map((p) => `--${boundary}\r\n${p}\r\n`).join('') + `--${boundary}--\r\n`;
}

export interface FakeEmail extends ForwardableEmailMessage { rejected: string | null; forwarded: string[] }

export function fakeEmail(from: string, to: string, raw: string, extraHeaders: Record<string, string> = {}): FakeEmail {
  const bytes = new TextEncoder().encode(raw);
  const msg = {
    from, to, rawSize: bytes.byteLength, headers: new Headers(extraHeaders),
    raw: new Response(bytes).body!,
    rejected: null as string | null,
    forwarded: [] as string[],
    setReject(reason: string) { msg.rejected = reason; },
    async forward(addr: string) { msg.forwarded.push(addr); return { messageId: '<fwd@test>' }; },
    async reply() { return { messageId: '<reply@test>' }; },
  };
  return msg as unknown as FakeEmail;
}

export function randomLocal(prefix = 'u'): string {
  return `${prefix}${ulid().slice(-8).toLowerCase()}`;
}
