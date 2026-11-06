import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MboxImport } from '../src/shared/api';
import { ulid } from '../src/shared/ulid';
import worker from '../src/worker/index';
import { hashPassword } from '../src/worker/lib/crypto';
import { asctime, escapeMboxrd, mapGmailLabels, parseGmailLabels, scanMbox, unescapeMboxrd } from '../src/worker/mbox/format';
import { processMboxImports, type ProcessOpts } from '../src/worker/mbox/import';
import { processInbound } from '../src/worker/inbound/handler';
import { BASE, buildEml, call, createMailbox, ctx, fakeEmail, randomLocal, sessionCookie, withEnv } from './helpers';

const enc = new TextEncoder();
const dec = new TextDecoder();
const PW = 'mbox-password-123';

async function mkUser(prefix: string): Promise<{ id: string; cookie: string }> {
  const id = ulid();
  const email = `${randomLocal(prefix)}@mbox.test`;
  const now = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at, updated_at) VALUES (?, ?, 'U', ?, 'member', ?, ?)")
    .bind(id, email, await hashPassword(PW), now, now).run();
  const cookie = sessionCookie(await call('/api/auth/login', { body: { email, password: PW } }));
  return { id, cookie };
}

async function putPart(cookie: string, mb: string, id: string, n: number, bytes: Uint8Array): Promise<Response> {
  const req = new Request(`${BASE}/api/mailboxes/${mb}/import/${id}/parts/${n}`, { method: 'PUT', headers: { cookie, 'x-cirrus': '1' }, body: bytes });
  return worker.fetch(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
}

/** Starts an import, uploads it in 16 MB parts and completes it. Returns the import. */
async function upload(cookie: string, mb: string, content: string | Uint8Array, body: Record<string, unknown> = {}): Promise<MboxImport> {
  const bytes = typeof content === 'string' ? enc.encode(content) : content;
  const start = await call(`/api/mailboxes/${mb}/import`, { cookie, body: { filename: 'takeout.mbox', size: bytes.length, ...body } });
  expect(start.status).toBe(201);
  const imp = await start.json<MboxImport>();
  for (let n = 1; n <= Math.ceil(bytes.length / imp.partSize); n++) {
    const res = await putPart(cookie, mb, imp.id, n, bytes.subarray((n - 1) * imp.partSize, n * imp.partSize));
    expect(res.status).toBe(200);
  }
  const done = await call(`/api/mailboxes/${mb}/import/${imp.id}/complete`, { cookie, method: 'POST', body: {} });
  expect(done.status).toBe(200);
  return done.json<MboxImport>();
}

const status = async (cookie: string, mb: string) => (await (await call(`/api/mailboxes/${mb}/import`, { cookie })).json<MboxImport | null>())!;

/** Runs the cron step until the import ends (or `max` ticks). */
async function drain(cookie: string, mb: string, opts: ProcessOpts = {}, max = 60): Promise<MboxImport> {
  for (let i = 0; i < max; i++) {
    const s = await status(cookie, mb);
    if (s.status !== 'processing') return s;
    await processMboxImports(env, opts);
  }
  return status(cookie, mb);
}

function msg(o: { id?: string | null; subject: string; labels?: string; date?: string; body?: string; from?: string }): string {
  const h = [`From: ${o.from ?? 'Sam <sam@elsewhere.test>'}`, 'To: me@mbox.test', `Subject: ${o.subject}`, `Date: ${o.date ?? 'Mon, 01 Jan 2024 10:00:00 +0000'}`];
  if (o.id !== null) h.push(`Message-ID: ${o.id ?? `<${ulid()}@t.test>`}`);
  if (o.labels !== undefined) h.unshift(`X-Gmail-Labels: ${o.labels}`);
  return `${h.join('\n')}\n\n${o.body ?? 'hello'}\n`;
}
const mboxOf = (msgs: string[]) => msgs.map((m) => `From 123@xxx Mon Jan  1 10:00:00 2024\n${m}`).join('\n');

interface Stored { subject: string; role: string; is_read: number; is_starred: number; date: number; direction: string }
async function stored(mb: string): Promise<Stored[]> {
  const { results } = await env.DB.prepare(
    'SELECT m.subject, f.role, m.is_read, m.is_starred, m.date, m.direction FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.mailbox_id = ? ORDER BY m.subject',
  ).bind(mb).all<Stored>();
  return results;
}
const count = async (mb: string) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = ?').bind(mb).first<number>('n')) ?? 0;

/** Splits a whole file by walking windows the way the cron does (cursor at a message start, window grows when needed). */
function splitAll(file: Uint8Array, window: number): string[] {
  const out: string[] = [];
  let cursor = 0;
  let win = window;
  while (cursor < file.length) {
    const buf = file.subarray(cursor, Math.min(file.length, cursor + win));
    const atEnd = cursor + buf.length >= file.length;
    const sc = scanMbox(buf, atEnd);
    if (!sc.messages.length && sc.consumed === 0 && !atEnd) {
      win *= 2;
      continue;
    }
    for (const m of sc.messages) out.push(dec.decode(unescapeMboxrd(buf.subarray(m.start, m.end))));
    cursor += sc.consumed;
    win = window;
  }
  return out;
}

describe('mbox splitter', () => {
  const m1 = 'Subject: one\n\nbody one\n>From the start\n';
  const m2 = 'Subject: two\n\n>>From nested\nline\n';
  const m3 = 'Subject: three\n\nlast';
  const file = enc.encode(`From a@x Mon Jan  1 10:00:00 2024\n${m1}\nFrom b@x Mon Jan  1 10:00:00 2024\n${m2}\nFrom c@x Mon Jan  1 10:00:00 2024\n${m3}`);
  const expected = ['Subject: one\n\nbody one\nFrom the start\n', 'Subject: two\n\n>From nested\nline\n', 'Subject: three\n\nlast'];

  it('splits across any window size, unescapes >From, and keeps a last message without a trailing newline', () => {
    for (const w of [8, 13, 40, 64, 100, 1000]) expect(splitAll(file, w)).toEqual(expected);
  });

  it('handles CRLF files and does not split on a From line without a blank line above it', () => {
    const crlf = enc.encode('From a@x Mon Jan  1 10:00:00 2024\r\nSubject: a\r\n\r\nline\r\nFrom here on\r\nmore\r\n\r\nFrom b@x Mon Jan  1 10:00:00 2024\r\nSubject: b\r\n\r\nx\r\n');
    for (const w of [10, 33, 1000]) {
      expect(splitAll(crlf, w)).toEqual(['Subject: a\r\n\r\nline\r\nFrom here on\r\nmore\r\n', 'Subject: b\r\n\r\nx\r\n']);
    }
  });

  it('leaves a message cut by the window unconsumed so it is read again from its start', () => {
    const sc = scanMbox(file.subarray(0, 60), false);
    expect(sc.messages).toHaveLength(0);
    expect(sc.consumed).toBe(0);
    const wide = scanMbox(file.subarray(0, file.indexOf(10, 100) + 60), false);
    expect(wide.consumed).toBeGreaterThan(0);
  });

  it('escape and unescape are inverse (mboxrd)', () => {
    const body = enc.encode('a\nFrom x\n>From y\n>>From z\nFromage\n');
    expect(dec.decode(escapeMboxrd(body))).toBe('a\n>From x\n>>From y\n>>>From z\nFromage\n');
    expect(dec.decode(unescapeMboxrd(escapeMboxrd(body)))).toBe(dec.decode(body));
  });

  it('writes asctime separators', () => {
    expect(asctime(Date.UTC(2024, 0, 2, 3, 4, 5))).toBe('Tue Jan  2 03:04:05 2024');
  });
});

describe('Gmail label mapping', () => {
  it('maps system labels, flags and user labels', () => {
    expect(mapGmailLabels('Inbox,Unread,Starred,Important,Category Promotions,Work')).toEqual({ folder: 'inbox', starred: true, unread: true, labels: ['Work'] });
    expect(mapGmailLabels('Sent').folder).toBe('sent');
    expect(mapGmailLabels('Spam,Inbox').folder).toBe('spam');
    expect(mapGmailLabels('Trash,Inbox,Spam').folder).toBe('trash');
    expect(mapGmailLabels('Drafts').folder).toBe('drafts');
    expect(mapGmailLabels('Opened,Category Updates')).toEqual({ folder: 'archive', starred: false, unread: false, labels: [] });
    expect(mapGmailLabels('Archived,work,WORK')).toMatchObject({ folder: 'archive', labels: ['work'] });
  });
  it('parses quoted names that contain commas', () => {
    expect(parseGmailLabels('Inbox,"Taxes, 2024",Kids')).toEqual(['Inbox', 'Taxes, 2024', 'Kids']);
  });
});

describe('mbox import', () => {
  let user: { id: string; cookie: string };
  let other: { id: string; cookie: string };
  beforeAll(async () => {
    user = await mkUser('imp');
    other = await mkUser('out');
  });

  async function freshMailbox(extraMembers: { userId: string }[] = []) {
    return createMailbox(`${randomLocal('m')}@mbox.test`, [{ userId: user.id }, ...extraMembers]);
  }

  it('imports a Gmail file: folders, flags, labels, dates, dedupe, drafts skipped', async () => {
    const mb = await freshMailbox();
    const existing = await call(`/api/mailboxes/${mb.id}/labels`, { cookie: user.cookie, body: { name: 'WORK', color: 'sky' } });
    expect(existing.status).toBe(201);
    const file = mboxOf([
      msg({ subject: 'A inbox', labels: 'Inbox,Unread,Starred,Important', id: '<a@t.test>' }),
      msg({ subject: 'B sent', labels: 'Sent,Work', id: '<b@t.test>' }),
      msg({ subject: 'C spam', labels: 'Spam', id: '<c@t.test>' }),
      msg({ subject: 'D trash', labels: 'Trash,Category Promotions', id: '<d@t.test>' }),
      msg({ subject: 'E draft', labels: 'Drafts', id: '<e@t.test>' }),
      msg({ subject: 'F archive', labels: '"Taxes, 2024",Kids,Category Social', id: '<f@t.test>', date: 'Wed, 01 Jan 2200 00:00:00 +0000' }),
      msg({ subject: 'G plain', labels: '', id: '<g@t.test>' }),
      msg({ subject: 'A again', labels: 'Inbox', id: '<a@t.test>' }),
    ]);
    await upload(user.cookie, mb.id, file);
    const done = await drain(user.cookie, mb.id);
    expect(done).toMatchObject({ status: 'done', imported: 6, duplicates: 1, skipped: 1, errors: 0, bytesProcessed: file.length });
    const rows = await stored(mb.id);
    const by = Object.fromEntries(rows.map((r) => [r.subject, r]));
    expect(by['A inbox']).toMatchObject({ role: 'inbox', is_read: 0, is_starred: 1, direction: 'in' });
    expect(by['B sent']).toMatchObject({ role: 'sent', is_read: 1, direction: 'out' });
    expect(by['C spam']).toMatchObject({ role: 'spam', is_read: 1 });
    expect(by['D trash'].role).toBe('trash');
    expect(by['F archive'].role).toBe('archive');
    expect(by['G plain'].role).toBe('archive');
    expect(by['E draft']).toBeUndefined();
    expect(by['A inbox'].date).toBe(Date.UTC(2024, 0, 1, 10));
    expect(by['F archive'].date).toBeLessThan(Date.now() + 10 * 60 * 1000); // clamped, not 2200
    // Labels: the existing "WORK" was reused (any case), the others created, no category label.
    const { results: labels } = await env.DB.prepare('SELECT name FROM labels WHERE mailbox_id = ? ORDER BY name').bind(mb.id).all<{ name: string }>();
    expect(labels.map((l) => l.name)).toEqual(['Kids', 'Taxes, 2024', 'WORK']);
    const onSent = await env.DB.prepare(
      "SELECT l.name FROM message_labels ml JOIN labels l ON l.id = ml.label_id JOIN messages m ON m.id = ml.message_id WHERE m.subject = 'B sent' AND m.mailbox_id = ?",
    ).bind(mb.id).all<{ name: string }>();
    expect(onSent.results.map((r) => r.name)).toEqual(['WORK']);
    // The source object is gone and the thread aggregates exist.
    expect(await env.BUCKET.head(`import/${mb.id}/${done.id}.mbox`)).toBeNull();
    const threads = await env.DB.prepare('SELECT COUNT(*) AS n FROM threads WHERE mailbox_id = ? AND message_count = 0').bind(mb.id).first<number>('n');
    expect(threads).toBe(0);
  });

  it('re-running an import creates no duplicates, with or without Message-ID', async () => {
    const mb = await freshMailbox();
    const file = mboxOf([msg({ subject: 'With id', id: '<same@t.test>' }), msg({ subject: 'No id', id: null }), msg({ subject: 'No id 2', id: null, body: 'other' })]);
    await upload(user.cookie, mb.id, file);
    expect(await drain(user.cookie, mb.id)).toMatchObject({ status: 'done', imported: 3, duplicates: 0 });
    await upload(user.cookie, mb.id, file);
    expect(await drain(user.cookie, mb.id)).toMatchObject({ status: 'done', imported: 0, duplicates: 3 });
    expect(await count(mb.id)).toBe(3);
  });

  it('puts a non-Gmail file in the chosen folder, optionally marking it read', async () => {
    const mb = await freshMailbox();
    const file = mboxOf([msg({ subject: 'Plain 1' }), msg({ subject: 'Plain 2' })]);
    await upload(user.cookie, mb.id, file);
    await drain(user.cookie, mb.id);
    expect((await stored(mb.id)).map((r) => [r.role, r.is_read])).toEqual([['archive', 1], ['archive', 1]]);

    const mb2 = await freshMailbox();
    await upload(user.cookie, mb2.id, file, { folderId: mb2.folders.inbox, markRead: false });
    await drain(user.cookie, mb2.id);
    expect((await stored(mb2.id)).map((r) => [r.role, r.is_read])).toEqual([['inbox', 0], ['inbox', 0]]);
  });

  it('decodes encoded Gmail label names', async () => {
    const mb = await freshMailbox();
    await upload(user.cookie, mb.id, mboxOf([msg({ subject: 'Enc', labels: '=?UTF-8?Q?Caf=C3=A9?=' })]));
    await drain(user.cookie, mb.id);
    const { results } = await env.DB.prepare('SELECT name FROM labels WHERE mailbox_id = ?').bind(mb.id).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(['Café']);
  });

  it('stops at the message and time budgets and resumes from the persisted cursor', async () => {
    const mb = await freshMailbox();
    const file = mboxOf([1, 2, 3, 4, 5].map((i) => msg({ subject: `S${i}`, id: `<s${i}@t.test>`, body: 'x'.repeat(300) })));
    await upload(user.cookie, mb.id, file);
    await processMboxImports(env, { maxMessages: 2 });
    let s = await status(user.cookie, mb.id);
    expect(s).toMatchObject({ status: 'processing', imported: 2 });
    expect(s.bytesProcessed).toBeGreaterThan(0);
    expect(s.bytesProcessed).toBeLessThan(file.length);
    // A spent time budget still makes progress: exactly one message per tick.
    await processMboxImports(env, { budgetMs: -1 });
    s = await status(user.cookie, mb.id);
    expect(s).toMatchObject({ status: 'processing', imported: 3 });
    // Tiny windows: messages larger than the window are re-read from their start.
    s = await drain(user.cookie, mb.id, { windowBytes: 200 });
    expect(s).toMatchObject({ status: 'done', imported: 5, duplicates: 0 });
    expect((await stored(mb.id)).map((r) => r.subject)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5']);
  });

  it('skips a message over 25 MB and carries on after it', async () => {
    const mb = await freshMailbox();
    const big = msg({ subject: 'Huge', id: '<huge@t.test>', body: 'y'.repeat(26 * 1024 * 1024 + 1000) });
    const file = enc.encode(mboxOf([msg({ subject: 'Before' }), big, msg({ subject: 'After' })]));
    await upload(user.cookie, mb.id, file);
    const done = await drain(user.cookie, mb.id);
    expect(done).toMatchObject({ status: 'done', imported: 2, skipped: 1, errors: 0 });
    expect((await stored(mb.id)).map((r) => r.subject)).toEqual(['After', 'Before']);
  }, 60_000);

  it('rejects a file that is not an mbox', async () => {
    const mb = await freshMailbox();
    await upload(user.cookie, mb.id, 'just some text\n');
    const s = await drain(user.cookie, mb.id);
    expect(s.status).toBe('failed');
    expect(s.errorSamples).toEqual(['not_an_mbox_file']);
  });

  it('allows one active import per mailbox and caps the size', async () => {
    const mb = await freshMailbox();
    const a = await call(`/api/mailboxes/${mb.id}/import`, { cookie: user.cookie, body: { filename: 'a.mbox', size: 100 } });
    expect(a.status).toBe(201);
    const b = await call(`/api/mailboxes/${mb.id}/import`, { cookie: user.cookie, body: { filename: 'b.mbox', size: 100 } });
    expect(b.status).toBe(409);
    expect((await b.json<{ error: { code: string } }>()).error.code).toBe('IMPORT_ACTIVE');
    const mb2 = await freshMailbox();
    const big = await call(`/api/mailboxes/${mb2.id}/import`, { cookie: user.cookie, body: { filename: 'c.mbox', size: 21 * 1024 ** 3 } });
    expect(big.status).toBe(400);
  });

  it('blocks non-members on every route and other members from uploading', async () => {
    const mb = await freshMailbox([{ userId: (await mkUser('mem')).id }]);
    const imp = await (await call(`/api/mailboxes/${mb.id}/import`, { cookie: user.cookie, body: { filename: 'a.mbox', size: 10 } })).json<MboxImport>();
    for (const [path, method] of [[`/import`, 'GET'], [`/import/${imp.id}/complete`, 'POST'], [`/import/${imp.id}`, 'DELETE'], [`/export`, 'GET']] as const) {
      const res = await call(`/api/mailboxes/${mb.id}${path}`, { cookie: other.cookie, method, body: method === 'POST' ? {} : undefined });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect((await call(`/api/mailboxes/${mb.id}/import`, { cookie: other.cookie, body: { filename: 'x.mbox', size: 10 } })).status).toBe(404);
    expect((await putPart(other.cookie, mb.id, imp.id, 1, new Uint8Array(10))).status).toBe(404);
    expect((await putPart('cirrus_session=nope', mb.id, imp.id, 1, new Uint8Array(10))).status).toBe(401);
    // A second member of the mailbox did not start the import.
    const member = await mkUser('m2');
    await env.DB.prepare("INSERT INTO mailbox_members (mailbox_id, user_id, role) VALUES (?, ?, 'member')").bind(mb.id, member.id).run();
    expect((await putPart(member.cookie, mb.id, imp.id, 1, new Uint8Array(10))).status).toBe(403);
    // A wrong part size is refused.
    expect((await putPart(user.cookie, mb.id, imp.id, 1, new Uint8Array(9))).status).toBe(400);
    // The upload can be resumed: the stored part numbers are reported.
    expect((await putPart(user.cookie, mb.id, imp.id, 1, new Uint8Array(10))).status).toBe(200);
    expect((await status(user.cookie, mb.id)).uploadedParts).toEqual([1]);
  });

  it('cancel stops processing, deletes the R2 object and keeps imported mail', async () => {
    const mb = await freshMailbox();
    const file = mboxOf([1, 2, 3].map((i) => msg({ subject: `K${i}`, id: `<k${i}@t.test>` })));
    const imp = await upload(user.cookie, mb.id, file);
    const key = `import/${mb.id}/${imp.id}.mbox`;
    expect(await env.BUCKET.head(key)).not.toBeNull();
    await processMboxImports(env, { maxMessages: 1 });
    expect((await call(`/api/mailboxes/${mb.id}/import/${imp.id}`, { cookie: user.cookie, method: 'DELETE' })).status).toBe(200);
    expect(await env.BUCKET.head(key)).toBeNull();
    expect((await status(user.cookie, mb.id)).status).toBe('cancelled');
    await processMboxImports(env);
    expect(await count(mb.id)).toBe(1);
    // A cancelled upload is aborted: it cannot be completed and a new import can start.
    const up = await (await call(`/api/mailboxes/${mb.id}/import`, { cookie: user.cookie, body: { filename: 'b.mbox', size: 10 } })).json<MboxImport>();
    expect((await call(`/api/mailboxes/${mb.id}/import/${up.id}`, { cookie: user.cookie, method: 'DELETE' })).status).toBe(200);
    expect((await call(`/api/mailboxes/${mb.id}/import/${up.id}/complete`, { cookie: user.cookie, body: {} })).status).toBe(409);
  });
});

describe('mbox export', () => {
  let user: { id: string; cookie: string };
  beforeAll(async () => {
    user = await mkUser('exp');
  });

  async function deliver(to: string, subject: string, extra: Partial<Parameters<typeof buildEml>[0]> = {}) {
    const eml = buildEml({ from: 'Sam <sam@elsewhere.test>', to, subject, body: `Body of ${subject}\nFrom the top\n`, ...extra });
    const out = await processInbound(fakeEmail('sam@elsewhere.test', to, eml), env);
    expect(out.accepted).toBe(true);
  }

  it('round-trips: export a mailbox, import the file into another, subjects and counts match', async () => {
    const addr = `${randomLocal('src')}@mbox.test`;
    const src = await createMailbox(addr, [{ userId: user.id }]);
    await deliver(addr, 'First message');
    await deliver(addr, 'Second message', { attachments: [{ filename: 'a.txt', type: 'text/plain', content: enc.encode('attachment') }] });
    await deliver(addr, 'Third: ünïcode ✓');
    // A sent message has no raw .eml in R2: it is rebuilt from the parsed parts.
    const tid = ulid();
    const sid = ulid();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO threads (id, mailbox_id, subject, subject_norm, last_message_at, created_at) VALUES (?, ?, 'Sent one', 'sent one', ?, ?)").bind(tid, src.id, now, now),
      env.DB.prepare(
        `INSERT INTO messages (id, mailbox_id, thread_id, folder_id, direction, status, message_id_hdr, from_email, from_name, to_json, subject, snippet, body_inline, date, created_at, updated_at, folder_changed_at, is_read)
         VALUES (?, ?, ?, ?, 'out', 'sent', '<sent1@mbox.test>', ?, 'Me', '[{"email":"pal@elsewhere.test","name":"Pal"}]', 'Sent one', '', ?, ?, ?, ?, ?, 1)`,
      ).bind(sid, src.id, tid, src.folders.sent, addr, JSON.stringify({ html: '<p>hi</p>', text: 'hi\nFrom me' }), now, now, now, now),
    ]);

    const res = await call(`/api/mailboxes/${src.id}/export`, { cookie: user.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/mbox');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="[\w.-]+\.mbox"$/);
    const exported = new Uint8Array(await res.arrayBuffer());
    const text = dec.decode(exported);
    expect(text.match(/^From \S+ \w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/gm)).toHaveLength(4);
    expect(text).toContain('>From the top');

    const dst = await createMailbox(`${randomLocal('dst')}@mbox.test`, [{ userId: user.id }]);
    await upload(user.cookie, dst.id, exported);
    const done = await drain(user.cookie, dst.id);
    expect(done).toMatchObject({ status: 'done', imported: 4, duplicates: 0, errors: 0 });
    const a = (await stored(src.id)).map((r) => r.subject);
    const b = (await stored(dst.id)).map((r) => r.subject);
    expect(b).toEqual(a);
    const body = await env.DB.prepare("SELECT body_inline, has_attachments FROM messages WHERE mailbox_id = ? AND subject = 'Second message'").bind(dst.id).first<{ body_inline: string; has_attachments: number }>();
    expect(JSON.parse(body!.body_inline).text).toContain('From the top');
    expect(body!.has_attachments).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM attachments WHERE mailbox_id = ?").bind(dst.id).first<number>('n')).toBe(1);
    const sent = await env.DB.prepare("SELECT body_inline FROM messages WHERE mailbox_id = ? AND subject = 'Sent one'").bind(dst.id).first<{ body_inline: string }>();
    expect(JSON.parse(sent!.body_inline)).toMatchObject({ html: '<p>hi</p>' });
    // Re-importing the export into the same mailbox adds nothing.
    await upload(user.cookie, dst.id, exported);
    expect(await drain(user.cookie, dst.id)).toMatchObject({ imported: 0, duplicates: 4 });
  });

  it('exports one folder or one label, and refuses ids from another mailbox', async () => {
    const addr = `${randomLocal('sc')}@mbox.test`;
    const mb = await createMailbox(addr, [{ userId: user.id }]);
    await deliver(addr, 'In inbox');
    await deliver(addr, 'Labelled');
    const labelId = ulid();
    await env.DB.prepare("INSERT INTO labels (id, mailbox_id, name, color, created_at) VALUES (?, ?, 'L', 'sky', ?)").bind(labelId, mb.id, Date.now()).run();
    await env.DB.prepare("INSERT INTO message_labels (message_id, label_id) SELECT id, ? FROM messages WHERE subject = 'Labelled' AND mailbox_id = ?").bind(labelId, mb.id).run();
    const subjects = async (q: string) => dec.decode(await (await call(`/api/mailboxes/${mb.id}/export?${q}`, { cookie: user.cookie })).arrayBuffer()).match(/^Subject: .*$/gm);
    expect(await subjects(`scope=label&id=${labelId}`)).toEqual(['Subject: Labelled']);
    expect(await subjects(`scope=folder&id=${mb.folders.inbox}`)).toHaveLength(2);
    expect(await subjects(`scope=folder&id=${mb.folders.trash}`)).toBeNull();
    const foreign = await createMailbox(`${randomLocal('f')}@mbox.test`, [{ userId: user.id }]);
    expect((await call(`/api/mailboxes/${mb.id}/export?scope=folder&id=${foreign.folders.inbox}`, { cookie: user.cookie })).status).toBe(404);
  });

  it('exports a custom folder', async () => {
    const addr = `${randomLocal('cf')}@mbox.test`;
    const mb = await createMailbox(addr, [{ userId: user.id }]);
    await deliver(addr, 'Filed away');
    const folderId = ulid();
    await env.DB.prepare('INSERT INTO folders (id, mailbox_id, name, role, sort, created_at) VALUES (?, ?, ?, NULL, 99, ?)').bind(folderId, mb.id, 'Receipts', Date.now()).run();
    await env.DB.prepare("UPDATE messages SET folder_id = ? WHERE mailbox_id = ? AND subject = 'Filed away'").bind(folderId, mb.id).run();
    const res = await call(`/api/mailboxes/${mb.id}/export?scope=folder&id=${folderId}`, { cookie: user.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('Receipts');
    expect(dec.decode(await res.arrayBuffer()).match(/^Subject: .*$/gm)).toEqual(['Subject: Filed away']);
    // Drafts and Scheduled stay refused
    expect((await call(`/api/mailboxes/${mb.id}/export?scope=folder&id=${mb.folders.drafts}`, { cookie: user.cookie })).status).toBe(404);
  });

  it('rate-limits exports per user', async () => {
    const u = await mkUser('rl');
    const mb = await createMailbox(`${randomLocal('rl')}@mbox.test`, [{ userId: u.id }]);
    for (let i = 0; i < 5; i++) expect((await call(`/api/mailboxes/${mb.id}/export`, { cookie: u.cookie })).status).toBe(200);
    expect((await call(`/api/mailboxes/${mb.id}/export`, { cookie: u.cookie })).status).toBe(429);
  });
});

/** The test bucket with hooks: `get` can fail, and `put` runs `onPut` with the key before storing. */
function hookedEnv(hooks: { failGet?: boolean; onPut?: (key: string) => Promise<void> }): Env {
  const bucket = new Proxy(env.BUCKET, {
    get(t, k) {
      const v = Reflect.get(t, k) as unknown;
      if (k === 'get' && hooks.failGet) return async () => { throw new Error('transient'); };
      if (k === 'put' && hooks.onPut) return async (key: string, ...rest: unknown[]) => { await hooks.onPut!(key); return (t.put as (...a: unknown[]) => Promise<unknown>)(key, ...rest); };
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  return withEnv({ BUCKET: bucket });
}

describe('mbox import resilience', () => {
  let user: { id: string; cookie: string };
  beforeAll(async () => {
    user = await mkUser('res');
  });
  const freshMailbox = () => createMailbox(`${randomLocal('r')}@mbox.test`, [{ userId: user.id }]);
  const row = (mb: string) => env.DB.prepare('SELECT status, consecutive_failures AS fails, lease_until AS lease, imported, error_count AS errors FROM mbox_imports WHERE mailbox_id = ?')
    .bind(mb).first<{ status: string; fails: number; lease: number; imported: number; errors: number }>();

  it('an unexpected error only costs a tick: the lease is released, the source kept, and it fails after 10 in a row', async () => {
    const mb = await freshMailbox();
    const imp = await upload(user.cookie, mb.id, mboxOf([msg({ subject: 'Flaky' })]));
    const key = `import/${mb.id}/${imp.id}.mbox`;
    const flaky = hookedEnv({ failGet: true });
    for (let i = 1; i < 10; i++) {
      await processMboxImports(flaky);
      expect(await row(mb.id)).toMatchObject({ status: 'processing', fails: i, lease: 0 });
      expect(await env.BUCKET.head(key)).not.toBeNull();
    }
    await processMboxImports(flaky);
    expect((await row(mb.id))!.status).toBe('failed');
    expect(await env.BUCKET.head(key)).toBeNull();
  });

  it('a good tick resets the failure count and the import carries on to the end', async () => {
    const mb = await freshMailbox();
    await upload(user.cookie, mb.id, mboxOf([1, 2, 3].map((i) => msg({ subject: `F${i}`, id: `<f${i}@t.test>` }))));
    const flaky = hookedEnv({ failGet: true });
    for (let i = 0; i < 5; i++) await processMboxImports(flaky);
    expect(await row(mb.id)).toMatchObject({ status: 'processing', fails: 5 });
    await processMboxImports(env, { maxMessages: 1 });
    expect(await row(mb.id)).toMatchObject({ status: 'processing', fails: 0, imported: 1 });
    for (let i = 0; i < 9; i++) await processMboxImports(flaky);
    expect((await row(mb.id))!.status).toBe('processing');
    expect((await drain(user.cookie, mb.id)).status).toBe('done');
    expect(await count(mb.id)).toBe(3);
  });

  it('a label deleted mid-import does not fail the messages after it', async () => {
    const mb = await freshMailbox();
    await upload(user.cookie, mb.id, mboxOf([1, 2, 3].map((i) => msg({ subject: `L${i}`, id: `<l${i}@t.test>`, labels: 'Inbox,Doomed' }))));
    let raws = 0;
    const e = hookedEnv({
      onPut: async (key) => {
        if (key.startsWith('raw/') && ++raws === 2) await env.DB.prepare("DELETE FROM labels WHERE mailbox_id = ? AND name = 'Doomed'").bind(mb.id).run();
      },
    });
    for (let i = 0; i < 5 && (await row(mb.id))!.status === 'processing'; i++) await processMboxImports(e);
    expect(await row(mb.id)).toMatchObject({ status: 'done', imported: 3, errors: 0 });
    expect(await count(mb.id)).toBe(3);
    // Message 3 recreated the label through ensureLabel (the stale cache entry was dropped), message 2 went without.
    const linked = await env.DB.prepare('SELECT m.subject FROM message_labels ml JOIN messages m ON m.id = ml.message_id WHERE m.mailbox_id = ? ORDER BY m.subject').bind(mb.id).all<{ subject: string }>();
    expect(linked.results.map((r) => r.subject)).toEqual(['L3']);
  });

  it('falls back to Archive when the target folder was deleted mid-import', async () => {
    const mb = await freshMailbox();
    const folderId = ulid();
    await env.DB.prepare('INSERT INTO folders (id, mailbox_id, name, role, sort, created_at) VALUES (?, ?, ?, NULL, 99, ?)').bind(folderId, mb.id, 'Vanishing', Date.now()).run();
    await upload(user.cookie, mb.id, mboxOf([1, 2].map((i) => msg({ subject: `V${i}`, id: `<v${i}@t.test>` }))), { folderId });
    let raws = 0;
    const e = hookedEnv({
      onPut: async (key) => {
        if (key.startsWith('raw/') && ++raws === 1) await env.DB.prepare('DELETE FROM folders WHERE id = ?').bind(folderId).run();
      },
    });
    for (let i = 0; i < 5 && (await row(mb.id))!.status === 'processing'; i++) await processMboxImports(e);
    expect(await row(mb.id)).toMatchObject({ status: 'done', imported: 2, errors: 0 });
    expect((await stored(mb.id)).map((r) => r.role)).toEqual(['archive', 'archive']);
  });

  it('imported mail with a future Date never gets a created_at in the future', async () => {
    const mb = await freshMailbox();
    const future = new Date(Date.now() + 4 * 60 * 1000).toUTCString();
    await upload(user.cookie, mb.id, mboxOf([msg({ subject: 'Ahead', date: future })]));
    await drain(user.cookie, mb.id);
    const r = (await env.DB.prepare("SELECT created_at, updated_at, date FROM messages WHERE mailbox_id = ? AND subject = 'Ahead'").bind(mb.id).first<{ created_at: number; updated_at: number; date: number }>())!;
    expect(r.created_at).toBeLessThan(Date.now());
    expect(r.updated_at).toBeLessThan(Date.now());
    // The message keeps the date it carries; only the poll cursor column is held back.
    expect(r.date).toBeGreaterThan(Date.now());
  });
});
