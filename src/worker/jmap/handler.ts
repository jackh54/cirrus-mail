// JMAP over HTTP: /.well-known/jmap, /jmap/session, /jmap/api, /jmap/download, /jmap/upload and /jmap/eventsource.
// Authentication is HTTP Basic or Bearer with an app password only (see ./auth.ts); cookies are never looked at.
import { sha256Hex } from '../lib/crypto';
import { challenge } from '../dav/auth';
import type { UserRow } from '../lib/db';
import { authenticateJmap } from './auth';
import { handleUpload, loadBlob, parseBlobId, readCapped } from './blob';
import {
  CAP_CIRRUS, CAP_CORE, CAP_MAIL, CAP_SUBMISSION, CAP_VACATION, LIMITS_JMAP, runCalls, SUPPORTED_CAPS,
  type Account, type Ctx, type J, type MethodDef,
} from './core';
import { emailMethods } from './email';
import { mailboxMethods } from './mailbox';
import { submissionMethods } from './submission';

const METHODS: Record<string, MethodDef> = {
  'Core/echo': { cap: CAP_CORE, run: async (_ctx, args) => args },
  ...mailboxMethods,
  ...emailMethods,
  ...submissionMethods,
};

const CORS_SETTING = 'jmap_cors_origins';

function problem(status: number, type: string, detail: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ type: `urn:ietf:params:jmap:error:${type}`, status, detail, ...extra }), {
    status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

async function loadAccounts(env: Env, userId: string): Promise<Map<string, Account>> {
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.address, m.display_name AS displayName, mm.role,
            (SELECT COUNT(*) FROM mailbox_members x WHERE x.mailbox_id = m.id) AS members
       FROM mailbox_members mm JOIN mailboxes m ON m.id = mm.mailbox_id WHERE mm.user_id = ? ORDER BY m.created_at, m.id`,
  ).bind(userId).all<Account>();
  return new Map(results.map((a) => [a.id, a]));
}

async function sessionObject(env: Env, user: UserRow, accounts: Map<string, Account>, origin: string): Promise<J> {
  const accountCaps = {
    [CAP_CORE]: {},
    [CAP_MAIL]: {
      maxMailboxesPerEmail: null, maxMailboxDepth: 1, maxSizeMailboxName: 255, maxSizeAttachmentsPerEmail: 25 * 1024 * 1024,
      emailQuerySortOptions: ['receivedAt', 'sentAt', 'size'], mayCreateTopLevelMailbox: true,
    },
    [CAP_SUBMISSION]: { maxDelayedSend: 0, submissionExtensions: {} },
    [CAP_VACATION]: {},
    [CAP_CIRRUS]: {},
  };
  const accountsOut: J = {};
  for (const a of accounts.values()) {
    accountsOut[a.id] = { name: a.address, isPersonal: a.members === 1, isReadOnly: false, accountCapabilities: accountCaps };
  }
  const first = accounts.keys().next().value as string | undefined;
  const primary = first ? { [CAP_MAIL]: first, [CAP_SUBMISSION]: first, [CAP_VACATION]: first, [CAP_CIRRUS]: first } : {};
  return {
    capabilities: {
      [CAP_CORE]: { ...LIMITS_JMAP, collationAlgorithms: ['i;ascii-casemap'] },
      [CAP_MAIL]: {},
      [CAP_SUBMISSION]: {},
      [CAP_VACATION]: {},
      [CAP_CIRRUS]: {},
    },
    accounts: accountsOut,
    primaryAccounts: primary,
    username: user.email,
    apiUrl: `${origin}/jmap/api`,
    downloadUrl: `${origin}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
    uploadUrl: `${origin}/jmap/upload/{accountId}/`,
    eventSourceUrl: `${origin}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`,
    state: (await sha256Hex(JSON.stringify([...accounts.values()]))).slice(0, 16),
  };
}

// ---------- CORS (explicit allowlist in settings.jmap_cors_origins; empty by default) ----------

async function allowedOrigin(env: Env, request: Request): Promise<string | null> {
  const origin = request.headers.get('origin');
  if (!origin || origin === new URL(request.url).origin) return null;
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(CORS_SETTING).first<{ value: string }>();
  const list = (row?.value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

function withCors(res: Response, origin: string | null): Response {
  if (!origin) return res;
  const out = new Response(res.body, res);
  out.headers.set('access-control-allow-origin', origin);
  out.headers.append('vary', 'origin');
  out.headers.set('access-control-expose-headers', 'content-disposition');
  return out;
}

// ---------- EventSource ----------

export interface StreamOpts { types: Set<string> | null; closeAfterState: boolean; pingSec: number; intervalMs: number; maxMs: number; lastEventId?: string | null }
type Snapshot = Map<string, { Email: string; Mailbox: string; Thread: string }>;

async function snapshot(env: Env, userId: string): Promise<Snapshot> {
  const { results } = await env.DB.prepare(
    'SELECT mailbox_id, email, mailbox, thread FROM jmap_state WHERE mailbox_id IN (SELECT mailbox_id FROM mailbox_members WHERE user_id = ?)',
  ).bind(userId).all<{ mailbox_id: string; email: number; mailbox: number; thread: number }>();
  return new Map(results.map((r) => [r.mailbox_id, { Email: String(r.email), Mailbox: String(r.mailbox), Thread: String(r.thread) }]));
}

const snapshotId = (s: Snapshot) => [...s].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}:${v.Email}.${v.Mailbox}.${v.Thread}`).join(',');

/** A text/event-stream body that checks state with one query every `intervalMs` and ends after `maxMs` (clients reconnect). */
export function eventStream(env: Env, userId: string, o: StreamOpts): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const started = Date.now();
  let prev: Snapshot | null = null;
  let lastOut = Date.now();
  let first = true;
  let done = false;
  const diff = (a: Snapshot, b: Snapshot, all: boolean): J => {
    const changed: J = {};
    for (const [acc, st] of b) {
      for (const t of ['Email', 'Mailbox', 'Thread'] as const) {
        if (o.types && !o.types.has(t)) continue;
        if (all || a.get(acc)?.[t] !== st[t]) (changed[acc] ??= {})[t] = st[t];
      }
    }
    return changed;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return;
      const send = (s: string) => { controller.enqueue(enc.encode(s)); lastOut = Date.now(); };
      if (first) {
        first = false;
        prev = await snapshot(env, userId);
        send(':\n\n');
        if (o.lastEventId && o.lastEventId !== snapshotId(prev)) {
          const changed = diff(new Map(), prev, true);
          if (Object.keys(changed).length) {
            send(`event: state\nid: ${snapshotId(prev)}\ndata: ${JSON.stringify({ '@type': 'StateChange', changed })}\n\n`);
            if (o.closeAfterState) { done = true; controller.close(); }
          }
        }
        return;
      }
      await sleep(o.intervalMs);
      if (Date.now() - started >= o.maxMs) { done = true; controller.close(); return; }
      const cur = await snapshot(env, userId);
      const changed = diff(prev!, cur, false);
      prev = cur;
      if (Object.keys(changed).length) {
        send(`event: state\nid: ${snapshotId(cur)}\ndata: ${JSON.stringify({ '@type': 'StateChange', changed })}\n\n`);
        if (o.closeAfterState) { done = true; controller.close(); }
        return;
      }
      if (o.pingSec > 0 && Date.now() - lastOut >= o.pingSec * 1000) send(`event: ping\ndata: ${JSON.stringify({ interval: o.pingSec })}\n\n`);
      else send(':\n\n');
    },
    cancel() { done = true; },
  });
}

// ---------- routing ----------

async function route(request: Request, env: Env, user: UserRow): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const accounts = await loadAccounts(env, user.id);

  if (path === '/jmap/session' && method === 'GET') return json(await sessionObject(env, user, accounts, url.origin));

  if (path === '/jmap/api' && method === 'POST') {
    if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return problem(400, 'notJSON', 'Content-Type must be application/json');
    const bytes = await readCapped(request, LIMITS_JMAP.maxSizeRequest);
    if (!bytes) return problem(413, 'limit', 'Request is too large', { limit: 'maxSizeRequest' });
    let body: J;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); } catch { return problem(400, 'notJSON', 'The request is not valid JSON'); }
    if (!body || typeof body !== 'object' || !Array.isArray(body.using) || !Array.isArray(body.methodCalls) || body.using.some((u: unknown) => typeof u !== 'string')) {
      return problem(400, 'notRequest', 'The request is not a valid JMAP request');
    }
    const unknown = (body.using as string[]).filter((u) => !SUPPORTED_CAPS.includes(u));
    if (unknown.length) return problem(400, 'unknownCapability', `Unsupported capability: ${unknown[0]}`);
    if (body.methodCalls.length > LIMITS_JMAP.maxCallsInRequest) return problem(400, 'limit', 'Too many method calls', { limit: 'maxCallsInRequest' });
    const calls = body.methodCalls as J[];
    if (calls.some((c) => !Array.isArray(c) || c.length !== 3 || typeof c[0] !== 'string' || typeof c[2] !== 'string')) return problem(400, 'notRequest', 'Malformed method call');
    const ctx: Ctx = {
      env, user, origin: url.origin, accounts, using: new Set(body.using), createdIds: new Map(), structures: new Map(),
    };
    const given = body.createdIds && typeof body.createdIds === 'object' ? (body.createdIds as Record<string, string>) : null;
    if (given) for (const [k, v] of Object.entries(given)) if (typeof v === 'string') ctx.createdIds.set(k, v);
    const methodResponses = await runCalls(ctx, calls as [string, J, string][], METHODS);
    const session = await sessionObject(env, user, accounts, url.origin);
    return json({ methodResponses, ...(given ? { createdIds: Object.fromEntries(ctx.createdIds) } : {}), sessionState: session.state });
  }

  let m = /^\/jmap\/download\/([^/]+)\/([^/]+)\/([^/]*)$/.exec(path);
  if (m && (method === 'GET' || method === 'HEAD')) {
    const [, accountId, bid, rawName] = m;
    // Not a member: the same 404 as a missing blob.
    if (!accounts.has(accountId) || !parseBlobId(bid)) return new Response('Not found', { status: 404 });
    const blob = await loadBlob(env, accountId, bid);
    if (!blob) return new Response('Not found', { status: 404 });
    let name = rawName;
    try { name = decodeURIComponent(rawName); } catch { /* keep as is */ }
    name = (name || blob.name || 'download').replace(/[\x00-\x1f\x7f"\\/]/g, '_').slice(0, 200);
    const accept = url.searchParams.get('accept') ?? '';
    const type = /^[A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*$/.test(accept) ? accept : blob.type;
    return new Response(method === 'HEAD' ? null : blob.bytes, {
      headers: {
        'content-type': type, 'content-length': String(blob.bytes.byteLength),
        // Always a download, never rendered in the app's origin.
        'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'", 'cache-control': 'private, max-age=3600',
      },
    });
  }

  m = /^\/jmap\/upload\/([^/]+)\/?$/.exec(path);
  if (m && method === 'POST') {
    if (!accounts.has(m[1])) return new Response('Not found', { status: 404 });
    return handleUpload(request, env, m[1], user.id);
  }

  if (/^\/jmap\/eventsource\/?$/.test(path) && method === 'GET') {
    const types = url.searchParams.get('types') ?? '*';
    const ping = Number(url.searchParams.get('ping') ?? 0);
    const body = eventStream(env, user.id, {
      types: types === '*' ? null : new Set(types.split(',').map((t) => t.trim())),
      closeAfterState: url.searchParams.get('closeafter') === 'state',
      pingSec: Number.isFinite(ping) && ping > 0 ? Math.min(Math.max(Math.floor(ping), 15), 300) : 0,
      intervalMs: 15_000, maxMs: 5 * 60_000, lastEventId: request.headers.get('last-event-id'),
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
  }

  return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
}

export async function handleJmap(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/.well-known/jmap') return new Response(null, { status: 301, headers: { location: '/jmap/session', 'cache-control': 'no-store' } });
  const method = request.method.toUpperCase();
  const origin = await allowedOrigin(env, request);
  if (method === 'OPTIONS') {
    if (!origin) return new Response(null, { status: 204 });
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, HEAD, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, last-event-id',
        'access-control-max-age': '600', vary: 'origin',
      },
    });
  }
  const user = await authenticateJmap(request, env);
  if (user instanceof Response) return withCors(user, origin);
  try {
    return withCors(await route(request, env, user), origin);
  } catch (e) {
    console.error('jmap error', (e as Error).name);
    return withCors(problem(500, 'serverFail', 'Internal error'), origin);
  }
}

export { challenge };
