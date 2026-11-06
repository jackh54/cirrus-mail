import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Filter, Label, Page, ThreadDetail, ThreadSummary } from '../src/shared/api';
import { ulid } from '../src/shared/ulid';
import { processInbound } from '../src/worker/inbound/handler';
import { evaluateFilters } from '../src/worker/inbound/filters';
import { randomBytes, sha256Hex, toBase64Url } from '../src/worker/lib/crypto';
import { mailboxAuthz } from '../src/worker/middleware/session';
import { labelListStmts } from '../src/worker/routes/labels';
import { listThreadsStmts } from '../src/worker/routes/mail';
import { buildSearchSql, parseSearch } from '../src/worker/search';
import { buildEml, call, createMailbox, fakeEmail, randomLocal } from './helpers';

const DOMAIN = 'labels.test';
const s = {
  alice: '', bob: '', mbA: '', mbB: '', foldersA: {} as Record<string, string>, addrA: '', addrB: '',
  invoice: '', lunch: '', other: '',
};

async function makeUser(name: string): Promise<{ id: string; cookie: string }> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare('INSERT INTO users (id, email, name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, `${randomLocal(name)}@${DOMAIN}`, name, 'x', 'member', now, now).run();
  const token = toBase64Url(randomBytes(32));
  await env.DB.prepare('INSERT INTO sessions (id, token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(ulid(), await sha256Hex(token), id, now, now, now + 3600_000).run();
  return { id, cookie: `cirrus_session=${token}` };
}

async function deliver(to: string, subject: string, from = 'sender@vendor.test') {
  const out = await processInbound(fakeEmail(from, to, buildEml({ from: `Sender <${from}>`, to, subject, body: 'Hello there' })), env);
  expect(out.accepted).toBe(true);
}

const api = (mb: string, path: string) => `/api/mailboxes/${mb}${path}`;
const createLabel = (cookie: string, mb: string, name: string, color = 'cobalt') => call(api(mb, '/labels'), { body: { name, color }, cookie });
const listLabels = async (cookie: string, mb: string) => (await call(api(mb, '/labels'), { cookie })).json<Label[]>();
const threads = async (cookie: string, mb: string, query = '') => (await call(api(mb, `/threads${query}`), { cookie })).json<Page<ThreadSummary>>();
const apply = (cookie: string, mb: string, body: unknown) => call(api(mb, '/threads/labels'), { body, cookie });
const subjectsOf = (p: Page<ThreadSummary>) => p.items.map((t) => t.subject).sort();

beforeAll(async () => {
  const a = await makeUser('alice');
  const b = await makeUser('bob');
  s.alice = a.cookie;
  s.bob = b.cookie;
  s.addrA = `${randomLocal('a')}@${DOMAIN}`;
  s.addrB = `${randomLocal('b')}@${DOMAIN}`;
  const mA = await createMailbox(s.addrA, [{ userId: a.id }]);
  const mB = await createMailbox(s.addrB, [{ userId: b.id }]);
  s.mbA = mA.id; s.foldersA = mA.folders; s.mbB = mB.id;
  await deliver(s.addrA, 'Invoice for March');
  await deliver(s.addrA, 'Lunch on Friday');
  await deliver(s.addrB, 'Bob only');
  const page = await threads(s.alice, s.mbA);
  s.invoice = page.items.find((t) => t.subject === 'Invoice for March')!.id;
  s.lunch = page.items.find((t) => t.subject === 'Lunch on Friday')!.id;
  s.other = (await threads(s.bob, s.mbB)).items[0].id;
});

describe('label CRUD', () => {
  it('creates, lists, renames, recolours and deletes', async () => {
    const res = await createLabel(s.alice, s.mbA, 'Receipts', 'teal');
    expect(res.status).toBe(201);
    const label = await res.json<Label>();
    expect(label).toMatchObject({ name: 'Receipts', color: 'teal', unread: 0 });
    expect((await listLabels(s.alice, s.mbA)).map((l) => l.name)).toContain('Receipts');

    const patched = await call(api(s.mbA, `/labels/${label.id}`), { method: 'PATCH', body: { name: 'Bills', color: 'amber' }, cookie: s.alice });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ id: label.id, name: 'Bills', color: 'amber' });
    expect((await listLabels(s.alice, s.mbA)).find((l) => l.id === label.id)).toMatchObject({ name: 'Bills', color: 'amber' });

    expect((await call(api(s.mbA, `/labels/${label.id}`), { method: 'DELETE', cookie: s.alice })).status).toBe(200);
    expect((await listLabels(s.alice, s.mbA)).some((l) => l.id === label.id)).toBe(false);
    expect((await call(api(s.mbA, `/labels/${label.id}`), { method: 'DELETE', cookie: s.alice })).status).toBe(404);
  });

  it('names are unique per mailbox ignoring case, and free in another mailbox', async () => {
    expect((await createLabel(s.alice, s.mbA, 'Travel')).status).toBe(201);
    const dup = await createLabel(s.alice, s.mbA, 'tRaVeL', 'red');
    expect(dup.status).toBe(409);
    expect((await dup.json<{ error: { code: string } }>()).error.code).toBe('LABEL_EXISTS');
    expect((await createLabel(s.bob, s.mbB, 'Travel')).status).toBe(201);
    // Renaming onto an existing name is refused too.
    const other = await (await createLabel(s.alice, s.mbA, 'Trips')).json<Label>();
    expect((await call(api(s.mbA, `/labels/${other.id}`), { method: 'PATCH', body: { name: 'TRAVEL' }, cookie: s.alice })).status).toBe(409);
  });

  it('rejects colours outside the palette and empty or oversized names', async () => {
    expect((await createLabel(s.alice, s.mbA, 'Neon', 'hotpink')).status).toBe(400);
    expect((await createLabel(s.alice, s.mbA, '   ')).status).toBe(400);
    expect((await createLabel(s.alice, s.mbA, 'x'.repeat(41))).status).toBe(400);
  });
});

describe('membership authorization', () => {
  it("a non-member gets 404 on every label route of someone else's mailbox and changes nothing", async () => {
    const label = await (await createLabel(s.alice, s.mbA, 'Private')).json<Label>();
    const attempts: [string, string, unknown?][] = [
      ['GET', '/labels'],
      ['POST', '/labels', { name: 'Intruder', color: 'red' }],
      ['PATCH', `/labels/${label.id}`, { name: 'Hacked' }],
      ['DELETE', `/labels/${label.id}`],
      ['POST', '/threads/labels', { threadIds: [s.invoice], add: [label.id] }],
      ['GET', `/threads?label=${label.id}`],
    ];
    for (const [method, path, body] of attempts) {
      const res = await call(api(s.mbA, path), { method, body, cookie: s.bob });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect((await listLabels(s.alice, s.mbA)).find((l) => l.id === label.id)?.name).toBe('Private');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM message_labels WHERE label_id = ?').bind(label.id).first<number>('n')).toBe(0);
  });

  it('the batched label reads return no rows without access', async () => {
    const label = await (await createLabel(s.alice, s.mbA, 'Hidden')).json<Label>();
    await apply(s.alice, s.mbA, { threadIds: [s.invoice], add: [label.id] });
    const bobHash = await sha256Hex(s.bob.slice('cirrus_session='.length));
    for (const hash of ['0'.repeat(64), bobHash]) {
      const authz = mailboxAuthz(hash, s.mbA, Date.now());
      const results = await env.DB.batch([
        ...labelListStmts(env.DB, s.mbA, authz),
        ...listThreadsStmts(env.DB, s.mbA, { limit: 50, label: label.id }, authz),
      ]);
      for (const r of results) expect(r.results).toEqual([]);
    }
    await call(api(s.mbA, `/labels/${label.id}`), { method: 'DELETE', cookie: s.alice });
  });

  it('no session is a 401', async () => {
    expect((await call(api(s.mbA, '/labels'))).status).toBe(401);
    expect((await call(api(s.mbA, '/threads/labels'), { body: { threadIds: [s.invoice], add: ['x'] } })).status).toBe(401);
  });

  it("a member cannot use another mailbox's labels or threads", async () => {
    const bobLabel = await (await createLabel(s.bob, s.mbB, 'BobsOnly')).json<Label>();
    const aliceLabel = await (await createLabel(s.alice, s.mbA, 'AlicesOnly')).json<Label>();
    // A's thread with B's label: the label is unknown in A.
    expect((await apply(s.alice, s.mbA, { threadIds: [s.invoice], add: [bobLabel.id] })).status).toBe(404);
    // B's thread through A's mailbox: no such thread there.
    expect((await apply(s.alice, s.mbA, { threadIds: [s.other], add: [aliceLabel.id] })).status).toBe(404);
    // Mixed ids: the foreign thread is skipped, the owned one is labelled.
    expect((await apply(s.alice, s.mbA, { threadIds: [s.lunch, s.other], add: [aliceLabel.id] })).status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM message_labels WHERE label_id = ?').bind(aliceLabel.id).first<number>('n')).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM message_labels WHERE label_id = ?').bind(bobLabel.id).first<number>('n')).toBe(0);
    // A label from another mailbox is not a valid label view either.
    expect((await call(api(s.mbA, `/threads?label=${bobLabel.id}`), { cookie: s.alice })).status).toBe(404);
    await apply(s.alice, s.mbA, { threadIds: [s.lunch], remove: [aliceLabel.id] });
  });
});

describe('apply and remove', () => {
  it('labels every message of a thread, shows in thread lists and detail, and removes again', async () => {
    const label = await (await createLabel(s.alice, s.mbA, 'Finance', 'green')).json<Label>();
    // Give the invoice thread a second message so "all messages" is visible.
    await processInbound(fakeEmail('sender@vendor.test', s.addrA, buildEml({
      from: 'Sender <sender@vendor.test>', to: s.addrA, subject: 'Re: Invoice for March', body: 'Second', inReplyTo: '<none@x>',
    })), env);
    const before = await threads(s.alice, s.mbA);
    const invoice = before.items.find((t) => t.subject === 'Invoice for March')!;
    expect(invoice.labels).toEqual([]);

    expect((await apply(s.alice, s.mbA, { threadIds: [invoice.id], add: [label.id] })).status).toBe(200);
    const msgCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?').bind(invoice.id).first<number>('n');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM message_labels WHERE label_id = ?').bind(label.id).first<number>('n')).toBe(msgCount);

    const list = await threads(s.alice, s.mbA);
    expect(list.items.find((t) => t.id === invoice.id)!.labels).toEqual([label.id]);
    expect(list.items.find((t) => t.id === s.lunch)!.labels).toEqual([]);
    const detail = await (await call(api(s.mbA, `/threads/${invoice.id}`), { cookie: s.alice })).json<ThreadDetail>();
    expect(detail.thread.labels).toEqual([label.id]);

    // Idempotent: adding twice changes nothing.
    expect((await apply(s.alice, s.mbA, { threadIds: [invoice.id], add: [label.id] })).status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM message_labels WHERE label_id = ?').bind(label.id).first<number>('n')).toBe(msgCount);

    expect((await apply(s.alice, s.mbA, { threadIds: [invoice.id], remove: [label.id] })).status).toBe(200);
    expect((await threads(s.alice, s.mbA)).items.find((t) => t.id === invoice.id)!.labels).toEqual([]);
  });

  it('adds and removes in one call, and refuses empty or contradictory requests', async () => {
    const a = await (await createLabel(s.alice, s.mbA, 'One')).json<Label>();
    const b = await (await createLabel(s.alice, s.mbA, 'Two')).json<Label>();
    await apply(s.alice, s.mbA, { threadIds: [s.lunch], add: [a.id] });
    expect((await apply(s.alice, s.mbA, { threadIds: [s.lunch], add: [b.id], remove: [a.id] })).status).toBe(200);
    const t = (await threads(s.alice, s.mbA)).items.find((x) => x.id === s.lunch)!;
    expect(t.labels).toEqual([b.id]);
    expect((await apply(s.alice, s.mbA, { threadIds: [s.lunch] })).status).toBe(400);
    expect((await apply(s.alice, s.mbA, { threadIds: [s.lunch], add: [a.id], remove: [a.id] })).status).toBe(400);
    expect((await apply(s.alice, s.mbA, { threadIds: [s.lunch], add: [ulid()] })).status).toBe(404);
    expect((await apply(s.alice, s.mbA, { threadIds: [ulid()], add: [a.id] })).status).toBe(404);
    await apply(s.alice, s.mbA, { threadIds: [s.lunch], remove: [b.id] });
  });

  it('a label with a missing sibling writes nothing', async () => {
    const real = await (await createLabel(s.alice, s.mbA, 'Half')).json<Label>();
    expect((await apply(s.alice, s.mbA, { threadIds: [s.lunch], add: [real.id, ulid()] })).status).toBe(404);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM message_labels WHERE label_id = ?').bind(real.id).first<number>('n')).toBe(0);
  });
});

describe('listing by label', () => {
  it('lists only labelled threads, with unread counts per label, outside Trash and Spam', async () => {
    const label = await (await createLabel(s.alice, s.mbA, 'Pinned', 'violet')).json<Label>();
    await apply(s.alice, s.mbA, { threadIds: [s.invoice, s.lunch], add: [label.id] });
    expect(subjectsOf(await threads(s.alice, s.mbA, `?label=${label.id}`))).toEqual(['Invoice for March', 'Lunch on Friday']);
    expect((await listLabels(s.alice, s.mbA)).find((l) => l.id === label.id)!.unread).toBeGreaterThanOrEqual(2);

    await call(api(s.mbA, '/threads/actions'), { body: { threadIds: [s.lunch], action: 'read' }, cookie: s.alice });
    const unread = (await listLabels(s.alice, s.mbA)).find((l) => l.id === label.id)!.unread;
    const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM message_labels ml JOIN messages m ON m.id = ml.message_id WHERE ml.label_id = ? AND m.is_read = 0').bind(label.id).first<number>('n');
    expect(unread).toBe(total);

    await call(api(s.mbA, '/threads/actions'), { body: { threadIds: [s.lunch], action: 'trash' }, cookie: s.alice });
    expect(subjectsOf(await threads(s.alice, s.mbA, `?label=${label.id}`))).toEqual(['Invoice for March']);
    // The label stays on the trashed thread and shows if it comes back.
    await call(api(s.mbA, '/threads/actions'), { body: { threadIds: [s.lunch], action: 'move', folderId: s.foldersA.inbox }, cookie: s.alice });
    expect(subjectsOf(await threads(s.alice, s.mbA, `?label=${label.id}`))).toEqual(['Invoice for March', 'Lunch on Friday']);
  });

  it('paginates like folder lists', async () => {
    const label = await (await createLabel(s.alice, s.mbA, 'Paged')).json<Label>();
    await apply(s.alice, s.mbA, { threadIds: [s.invoice, s.lunch], add: [label.id] });
    const first = await threads(s.alice, s.mbA, `?label=${label.id}&limit=1`);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = await threads(s.alice, s.mbA, `?label=${label.id}&limit=1&cursor=${first.nextCursor}`);
    expect(second.items).toHaveLength(1);
    expect(second.items[0].id).not.toBe(first.items[0].id);
    expect(second.nextCursor).toBeNull();
  });

  it('an unknown label is a 404, and the hot reads stay one D1 round trip', async () => {
    const res = await call(api(s.mbA, `/threads?label=${ulid()}`), { cookie: s.alice });
    expect(res.status).toBe(404);
    expect((await res.json<{ error: { message: string } }>()).error.message).toBe('Label not found');
    const label = (await listLabels(s.alice, s.mbA))[0];
    const trips = (r: Response) => Number(r.headers.get('server-timing')?.match(/d1;dur=[\d.]+;desc="(\d+)"/)?.[1]);
    expect(trips(await call(api(s.mbA, '/labels'), { cookie: s.alice }))).toBe(1);
    expect(trips(await call(api(s.mbA, '/threads'), { cookie: s.alice }))).toBe(1);
    expect(trips(await call(api(s.mbA, `/threads/${s.invoice}`), { cookie: s.alice }))).toBe(1);
    // The label check rides in the same batch as the list.
    expect(trips(await call(api(s.mbA, `/threads?label=${label.id}`), { cookie: s.alice }))).toBe(1);
  });
});

describe('label: search', () => {
  it('parses label: terms, quoted names included', () => {
    expect(parseSearch('label:Receipts budget').labels).toEqual(['Receipts']);
    expect(parseSearch('label:"Big Clients" label:x').labels).toEqual(['Big Clients', 'x']);
    expect(parseSearch('label:').labels).toEqual([]);
    expect(buildSearchSql(parseSearch('label:a')).params).toEqual(['a']);
  });

  it('finds threads by label name, ignoring case, scoped to the mailbox', async () => {
    const label = await (await createLabel(s.alice, s.mbA, 'Big Clients', 'orange')).json<Label>();
    await apply(s.alice, s.mbA, { threadIds: [s.invoice], add: [label.id] });
    expect(subjectsOf(await threads(s.alice, s.mbA, '?q=label:"big clients"'))).toEqual(['Invoice for March']);
    expect(subjectsOf(await threads(s.alice, s.mbA, '?q=label:"BIG CLIENTS" invoice'))).toEqual(['Invoice for March']);
    expect((await threads(s.alice, s.mbA, '?q=label:"big clients" lunch')).items).toEqual([]);
    expect((await threads(s.alice, s.mbA, '?q=label:nosuchlabel')).items).toEqual([]);
    // Bob has a label with the same name in his mailbox, but it labels nothing of Alice's.
    const bobs = await (await createLabel(s.bob, s.mbB, 'Big Clients')).json<Label>();
    await apply(s.bob, s.mbB, { threadIds: [s.other], add: [bobs.id] });
    expect(subjectsOf(await threads(s.alice, s.mbA, '?q=label:"big clients"'))).toEqual(['Invoice for March']);
    expect(subjectsOf(await threads(s.bob, s.mbB, '?q=label:"big clients"'))).toEqual(['Bob only']);
  });
});

describe('filter action: apply label', () => {
  const filterBody = (labelId: string, subject: string) => ({
    name: 'Label invoices', match: 'all', enabled: true, sort: 0,
    conditions: [{ field: 'subject', op: 'contains', value: subject }],
    actions: [{ type: 'apply_label', labelId }],
  });

  it('evaluates to the label ids, without duplicates', () => {
    const f = (id: string, labelId: string): Filter => ({ id, name: id, match: 'all', enabled: true, sort: 0, conditions: [{ field: 'subject', op: 'contains', value: 'x' }], actions: [{ type: 'apply_label', labelId }] });
    const out = evaluateFilters([f('1', 'L1'), f('2', 'L1'), f('3', 'L2')], { from: { email: 'a@b.test' }, to: [], subject: 'x', hasAttachment: false, listId: null });
    expect(out.labelIds).toEqual(['L1', 'L2']);
  });

  it('validates the label, labels matching inbound mail, and ignores a label deleted later', async () => {
    const label = await (await createLabel(s.alice, s.mbA, 'Auto', 'sky')).json<Label>();
    expect((await call(api(s.mbA, '/filters'), { body: filterBody(ulid(), 'zzz'), cookie: s.alice })).status).toBe(400);
    const bobLabel = await (await createLabel(s.bob, s.mbB, 'NotMine')).json<Label>();
    expect((await call(api(s.mbA, '/filters'), { body: filterBody(bobLabel.id, 'zzz'), cookie: s.alice })).status).toBe(400);

    const created = await call(api(s.mbA, '/filters'), { body: filterBody(label.id, 'AutoTag'), cookie: s.alice });
    expect(created.status).toBe(201);
    await deliver(s.addrA, 'AutoTag report');
    await deliver(s.addrA, 'Unrelated news');
    const list = await threads(s.alice, s.mbA);
    expect(list.items.find((t) => t.subject === 'AutoTag report')!.labels).toEqual([label.id]);
    expect(list.items.find((t) => t.subject === 'Unrelated news')!.labels).toEqual([]);
    expect(subjectsOf(await threads(s.alice, s.mbA, `?label=${label.id}`))).toEqual(['AutoTag report']);

    // The filter keeps running after its label is deleted: the mail is delivered, just unlabelled.
    expect((await call(api(s.mbA, `/labels/${label.id}`), { method: 'DELETE', cookie: s.alice })).status).toBe(200);
    await deliver(s.addrA, 'AutoTag again');
    const after = await threads(s.alice, s.mbA);
    expect(after.items.find((t) => t.subject === 'AutoTag again')!.labels).toEqual([]);
  });
});

describe('deletion cascades', () => {
  const links = (col: 'label_id' | 'message_id', id: string) =>
    env.DB.prepare(`SELECT COUNT(*) AS n FROM message_labels WHERE ${col} = ?`).bind(id).first<number>('n');

  it('deleting a label removes it from every message but keeps the messages', async () => {
    const label = await (await createLabel(s.alice, s.mbA, 'Doomed')).json<Label>();
    await apply(s.alice, s.mbA, { threadIds: [s.invoice, s.lunch], add: [label.id] });
    expect(await links('label_id', label.id)).toBeGreaterThanOrEqual(2);
    const messages = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = ?').bind(s.mbA).first<number>('n');
    expect((await call(api(s.mbA, `/labels/${label.id}`), { method: 'DELETE', cookie: s.alice })).status).toBe(200);
    expect(await links('label_id', label.id)).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = ?').bind(s.mbA).first<number>('n')).toBe(messages);
    expect((await threads(s.alice, s.mbA)).items.every((t) => !t.labels.includes(label.id))).toBe(true);
  });

  it("a delete through another mailbox neither finds nor removes the label's rows", async () => {
    const label = await (await createLabel(s.alice, s.mbA, 'Safe')).json<Label>();
    await apply(s.alice, s.mbA, { threadIds: [s.invoice], add: [label.id] });
    const n = await links('label_id', label.id);
    expect((await call(api(s.mbB, `/labels/${label.id}`), { method: 'DELETE', cookie: s.bob })).status).toBe(404);
    expect(await links('label_id', label.id)).toBe(n);
    expect((await listLabels(s.alice, s.mbA)).some((l) => l.id === label.id)).toBe(true);
  });

  it('deleting messages forever drops their label links', async () => {
    const addr = `${randomLocal('c')}@${DOMAIN}`;
    const user = await makeUser('carol');
    const mb = await createMailbox(addr, [{ userId: user.id }]);
    await deliver(addr, 'Goodbye');
    const t = (await threads(user.cookie, mb.id)).items[0];
    const label = await (await createLabel(user.cookie, mb.id, 'Temp')).json<Label>();
    await apply(user.cookie, mb.id, { threadIds: [t.id], add: [label.id] });
    const msg = await env.DB.prepare('SELECT id FROM messages WHERE thread_id = ?').bind(t.id).first<string>('id');
    expect(await links('message_id', msg!)).toBe(1);
    await call(api(mb.id, '/threads/actions'), { body: { threadIds: [t.id], action: 'trash' }, cookie: user.cookie });
    await call(api(mb.id, '/threads/actions'), { body: { threadIds: [t.id], action: 'delete_forever' }, cookie: user.cookie });
    expect(await links('message_id', msg!)).toBe(0);
    // The label survives with nothing on it.
    expect((await listLabels(user.cookie, mb.id)).find((l) => l.id === label.id)?.unread).toBe(0);
  });

  it('deleting a mailbox removes its labels and links', async () => {
    const addr = `${randomLocal('d')}@${DOMAIN}`;
    const user = await makeUser('dave');
    const mb = await createMailbox(addr, [{ userId: user.id }]);
    await deliver(addr, 'Keep me not');
    const t = (await threads(user.cookie, mb.id)).items[0];
    const label = await (await createLabel(user.cookie, mb.id, 'Gone')).json<Label>();
    await apply(user.cookie, mb.id, { threadIds: [t.id], add: [label.id] });
    await env.DB.prepare('DELETE FROM mailboxes WHERE id = ?').bind(mb.id).run();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM labels WHERE mailbox_id = ?').bind(mb.id).first<number>('n')).toBe(0);
    expect(await links('label_id', label.id)).toBe(0);
  });
});
