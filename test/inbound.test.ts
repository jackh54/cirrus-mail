import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ulid } from '../src/shared/ulid';
import { AUTOREPLY_DAILY_CAP } from '../src/worker/inbound/autoreply';
import { processInbound } from '../src/worker/inbound/handler';
import { normalizeSubject, parseMessageIds } from '../src/worker/inbound/thread';
import { buildEml, createMailbox, ensureDomain, fakeEmail, randomLocal, withEnv } from './helpers';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);

async function createUser(disabled = 0): Promise<string> {
  const id = ulid();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, disabled, created_at, updated_at) VALUES (?, ?, 'U', 'x', 'member', ?, ?, ?)")
    .bind(id, `${randomLocal('user')}@users.test`, disabled, Date.now(), Date.now()).run();
  return id;
}

async function deliver(to: string, opts: Parameters<typeof buildEml>[0], e: Env = env, headers: Record<string, string> = {}) {
  const msg = fakeEmail(opts.from.replace(/.*</, '').replace(/>.*/, ''), to, buildEml(opts), headers);
  const out = await processInbound(msg, e);
  return { msg, out };
}

describe('threading helpers', () => {
  it('normalizes subjects', () => {
    expect(normalizeSubject('Re: RE: Fwd: AW:  Lunch   plans')).toBe('lunch plans');
    expect(normalizeSubject('Re[2]: Budget')).toBe('budget');
    expect(normalizeSubject('Recap of the week')).toBe('recap of the week');
  });
  it('parses message ids', () => {
    expect(parseMessageIds('<a@x> <b@y>')).toEqual(['<a@x>', '<b@y>']);
    expect(parseMessageIds('c@z')).toEqual(['<c@z>']);
  });
});

describe('inbound handler', () => {
  it('stores a message with attachments, body, raw, FTS row and thread aggregates', async () => {
    const addr = `${randomLocal()}@inbound.test`;
    const mb = await createMailbox(addr);
    const { msg, out } = await deliver(addr, {
      from: 'Priya Natarajan <priya@partner.test>', to: addr, subject: 'Design review notes',
      html: '<p>Hi! See <b>attached</b>.</p><img src="cid:logo123">',
      attachments: [
        { filename: 'notes.pdf', type: 'application/pdf', content: new TextEncoder().encode('%PDF-1.4 test') },
        { filename: 'logo.png', type: 'image/png', content: PNG, cid: 'logo123' },
      ],
    }, env, {});
    expect(msg.rejected).toBeNull();
    expect(out.accepted).toBe(true);
    if (!out.accepted) return;
    expect(out.folderId).toBe(mb.folders.inbox);
    const row = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(out.messageId).first<Record<string, unknown>>();
    expect(row).toMatchObject({ mailbox_id: mb.id, direction: 'in', status: 'received', from_email: 'priya@partner.test', has_attachments: 1, is_read: 0 });
    expect(await env.BUCKET.head(row!.raw_key as string)).not.toBeNull();
    const body = await (await env.BUCKET.get(row!.body_key as string))!.json<{ html: string; text: string }>();
    expect(body.text).toContain('attached');
    const atts = await env.DB.prepare('SELECT filename, inline, content_id FROM attachments WHERE message_id = ? ORDER BY filename').bind(out.messageId).all();
    expect(atts.results).toEqual([
      { filename: 'logo.png', inline: 1, content_id: 'logo123' },
      { filename: 'notes.pdf', inline: 0, content_id: null },
    ]);
    const fts = await env.DB.prepare("SELECT message_id FROM messages_fts WHERE messages_fts MATCH '\"design\" \"review\"' AND mailbox_id = ?").bind(mb.id).all();
    expect(fts.results.map((r) => r.message_id)).toContain(out.messageId);
    const thread = await env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(out.threadId).first<Record<string, unknown>>();
    expect(thread).toMatchObject({ message_count: 1, unread_count: 1, has_attachments: 1, subject: 'Design review notes', subject_norm: 'design review notes' });
    expect(JSON.parse(thread!.participants as string)).toEqual([{ name: 'Priya Natarajan', email: 'priya@partner.test' }]);
    const log = await env.DB.prepare('SELECT accepted FROM receive_log WHERE mailbox_id = ?').bind(mb.id).first<number>('accepted');
    expect(log).toBe(1);
  });

  it('rejects unknown recipients and unknown domains', async () => {
    await ensureDomain('inbound.test');
    const a = await deliver('nobody@inbound.test', { from: 'x@spam.test', to: 'nobody@inbound.test', subject: 'hi', body: 'x' });
    expect(a.msg.rejected).toBe('550 5.1.1 No such user');
    expect(a.out.accepted).toBe(false);
    const b = await deliver('who@unknown-domain.test', { from: 'x@spam.test', to: 'who@unknown-domain.test', subject: 'hi', body: 'x' });
    expect(b.msg.rejected).toBe('550 5.1.1 No such user');
  });

  it('routes to the domain catch-all and to aliases', async () => {
    const mb = await createMailbox(`${randomLocal()}@catchall.test`);
    await env.DB.prepare('UPDATE domains SET catch_all_mailbox_id = ? WHERE name = ?').bind(mb.id, 'catchall.test').run();
    const a = await deliver('anything@catchall.test', { from: 'x@other.test', to: 'anything@catchall.test', subject: 'catch me', body: 'x' });
    expect(a.msg.rejected).toBeNull();
    expect(a.out.accepted && a.out.mailboxId).toBe(mb.id);

    const alias = `${randomLocal('alias')}@inbound.test`;
    const target = await createMailbox(`${randomLocal()}@inbound.test`);
    await env.DB.prepare('INSERT INTO aliases (id, address, mailbox_id, can_send, created_at) VALUES (?, ?, ?, 1, ?)').bind(ulid(), alias, target.id, Date.now()).run();
    const b = await deliver(alias, { from: 'x@other.test', to: alias, subject: 'via alias', body: 'x' });
    expect(b.out.accepted && b.out.mailboxId).toBe(target.id);
  });

  it('threads by In-Reply-To, and by subject + shared participant as a fallback', async () => {
    const addr = `${randomLocal()}@inbound.test`;
    await createMailbox(addr);
    const first = await deliver(addr, { from: 'Marco <marco@partner.test>', to: addr, subject: 'Lunch plans', body: 'Thursday?', messageId: '<lunch-1@partner.test>' });
    const reply = await deliver(addr, { from: 'Marco <marco@partner.test>', to: addr, subject: 'Re: Lunch plans', body: 'Or Friday', inReplyTo: '<lunch-1@partner.test>', messageId: '<lunch-2@partner.test>' });
    expect(first.out.accepted && reply.out.accepted).toBe(true);
    if (!first.out.accepted || !reply.out.accepted) return;
    expect(reply.out.threadId).toBe(first.out.threadId);

    const fallback = await deliver(addr, { from: 'Marco <marco@partner.test>', to: addr, subject: 'RE: lunch plans', body: 'no headers' });
    expect(fallback.out.accepted && fallback.out.threadId).toBe(first.out.threadId);

    const stranger = await deliver(addr, { from: 'Someone <someone@else.test>', to: addr, subject: 'Re: Lunch plans', body: 'different person' });
    expect(stranger.out.accepted && stranger.out.threadId).not.toBe(first.out.threadId);

    const t = await env.DB.prepare('SELECT message_count, unread_count FROM threads WHERE id = ?').bind(first.out.threadId).first();
    expect(t).toEqual({ message_count: 3, unread_count: 3 });
  });

  it('sends DMARC failures to Spam, blocked senders too, and skips duplicates', async () => {
    const addr = `${randomLocal()}@inbound.test`;
    const mb = await createMailbox(addr);
    const spam = await deliver(addr, {
      from: 'Billing <billing@lookalike.test>', to: addr, subject: 'Invoice overdue', body: 'pay now',
      headers: { 'Authentication-Results': 'mx.cloudflare.net; dkim=fail; spf=fail; dmarc=fail header.from=lookalike.test' },
      messageId: '<dup-1@lookalike.test>', date: new Date(0), // a fixed Date header: a second boundary between the two builds would change the hash
    });
    expect(spam.out.accepted && spam.out.folderId).toBe(mb.folders.spam);
    const again = await deliver(addr, {
      from: 'Billing <billing@lookalike.test>', to: addr, subject: 'Invoice overdue', body: 'pay now',
      headers: { 'Authentication-Results': 'mx.cloudflare.net; dkim=fail; spf=fail; dmarc=fail header.from=lookalike.test' },
      messageId: '<dup-1@lookalike.test>', date: new Date(0), // a fixed Date header: a second boundary between the two builds would change the hash
    });
    expect(again.out.accepted && again.out.duplicate).toBe(true);

    await env.DB.prepare('INSERT INTO blocked_senders (id, mailbox_id, pattern, created_at) VALUES (?, ?, ?, ?)').bind(ulid(), mb.id, '@blocked.test', Date.now()).run();
    const blocked = await deliver(addr, { from: 'a@blocked.test', to: addr, subject: 'hello', body: 'x' });
    expect(blocked.out.accepted && blocked.out.folderId).toBe(mb.folders.spam);
  });

  it('applies filters and survives a corrupt regex', async () => {
    const addr = `${randomLocal()}@inbound.test`;
    const owner = await createUser();
    const mb = await createMailbox(addr, [{ userId: owner }]);
    const add = (conditions: unknown, actions: unknown, sort: number) =>
      env.DB.prepare('INSERT INTO filters (id, mailbox_id, name, match, conditions, actions, enabled, sort, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)')
        .bind(ulid(), mb.id, 'f', 'all', JSON.stringify(conditions), JSON.stringify(actions), sort, Date.now(), owner).run();
    await add([{ field: 'subject', op: 'regex', value: '([unclosed' }], [{ type: 'delete' }], 1);
    await add([{ field: 'list_id', op: 'contains', value: 'digest' }], [{ type: 'move_to', folderId: mb.folders.archive }, { type: 'mark_read' }, { type: 'forward_to', email: 'me@forward.test' }], 2);
    const r = await deliver(addr, { from: 'news@digest.test', to: addr, subject: 'Weekly digest', body: 'x', headers: { 'List-Id': 'Digest <digest.example>' } });
    expect(r.out.accepted && r.out.folderId).toBe(mb.folders.archive);
    expect(r.msg.forwarded).toEqual(['me@forward.test']);
    const row = await env.DB.prepare('SELECT is_read, list_id FROM messages WHERE id = ?').bind(r.out.accepted ? r.out.messageId : '').first();
    expect(row).toEqual({ is_read: 1, list_id: 'Digest <digest.example>' });
  });

  describe('vacation auto-reply', () => {
    const PASS = { 'Authentication-Results': 'mx.cloudflare.net; dkim=pass header.d=partner.test header.s=s1; dmarc=pass header.from=partner.test policy.dmarc=none; spf=pass smtp.mailfrom=partner.test' };
    async function setup(subject = 'Out of office') {
      const addr = `${randomLocal()}@inbound.test`;
      const mb = await createMailbox(addr);
      await env.DB.prepare("UPDATE mailboxes SET autoreply_enabled = 1, autoreply_subject = ?, autoreply_body = 'Back Monday' WHERE id = ?").bind(subject, mb.id).run();
      const sent: EmailMessageBuilder[] = [];
      const e = withEnv({ EMAIL: { send: async (b: EmailMessageBuilder) => { sent.push(b); return { messageId: 'x@y' }; } } as unknown as SendEmail });
      return { addr, mb, sent, e };
    }

    it('replies once per authenticated sender and never to lists', async () => {
      const { addr, sent, e } = await setup();
      await deliver(addr, { from: 'client@partner.test', to: addr, subject: 'Question', body: 'x', headers: PASS }, e);
      await deliver(addr, { from: 'client@partner.test', to: addr, subject: 'Another question', body: 'x', headers: PASS }, e);
      await deliver(addr, { from: 'list@partner.test', to: addr, subject: 'List mail', body: 'x', headers: { ...PASS, 'List-Id': '<l.partner.test>' } }, e);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ to: 'client@partner.test', subject: 'Out of office', text: 'Back Monday' });
      expect(sent[0].headers?.['Auto-Submitted']).toBe('auto-replied');
    });

    it('never replies to unauthenticated senders (backscatter)', async () => {
      const { addr, sent, e } = await setup();
      await deliver(addr, { from: 'forged@victim.test', to: addr, subject: 'x', body: 'x' }, e);
      await deliver(addr, { from: 'forged2@victim.test', to: addr, subject: 'x', body: 'x', headers: { 'Authentication-Results': 'mx.cloudflare.net; spf=softfail; dkim=none; dmarc=none' } }, e);
      expect(sent).toHaveLength(0);
    });

    it('stops at the per-mailbox daily cap', async () => {
      const { addr, mb, sent, e } = await setup();
      const now = Date.now();
      await env.DB.batch(Array.from({ length: AUTOREPLY_DAILY_CAP }, (_, i) =>
        env.DB.prepare('INSERT INTO autoreply_log (mailbox_id, sender, sent_at) VALUES (?, ?, ?)').bind(mb.id, `s${i}@partner.test`, now - 3600_000)));
      await deliver(addr, { from: 'new@partner.test', to: addr, subject: 'x', body: 'x', headers: PASS }, e);
      expect(sent).toHaveLength(0);
      await env.DB.prepare('UPDATE autoreply_log SET sent_at = ? WHERE mailbox_id = ?').bind(now - 2 * 86_400_000, mb.id).run();
      await deliver(addr, { from: 'new2@partner.test', to: addr, subject: 'x', body: 'x', headers: PASS }, e);
      expect(sent).toHaveLength(1);
    });

    it('#4 needs an aligned pass and an envelope that belongs to the From domain (no backscatter via DMARC)', async () => {
      const { addr, sent, e } = await setup();
      // Attacker's own aligned DMARC pass, envelope forged to a third party whose SPF softfails.
      const raw = buildEml({ from: 'promo@attacker.test', to: addr, subject: 'Cheap watches', body: 'x',
        headers: { 'Authentication-Results': 'mx.cloudflare.net; dkim=pass header.d=attacker.test; dmarc=pass header.from=attacker.test; spf=softfail smtp.mailfrom=thirdparty.test' } });
      await processInbound(fakeEmail('victim@thirdparty.test', addr, raw), e);
      // SPF and DKIM pass for the attacker's domain, but the From is someone else's (unaligned).
      await deliver(addr, { from: 'payments@bank.test', to: addr, subject: 'Invoice', body: 'x',
        headers: { 'Authentication-Results': 'mx.cloudflare.net; dkim=pass header.d=bank.test.attacker.test; spf=pass smtp.mailfrom=bank.test; dmarc=none' } }, e);
      expect(sent).toHaveLength(0);
      // Aligned From, and an ESP envelope that SPF authenticates: the reply goes to that envelope.
      const esp = buildEml({ from: 'client@partner.test', to: addr, subject: 'Question', body: 'x',
        headers: { 'Authentication-Results': 'mx.cloudflare.net; dkim=pass header.d=partner.test; dmarc=pass header.from=partner.test; spf=pass smtp.mailfrom=rp-77@esp.test' } });
      await processInbound(fakeEmail('rp-77@esp.test', addr, esp), e);
      expect(sent.map((m) => m.to)).toEqual(['rp-77@esp.test']);
    });

    it('strips CR/LF smuggled through an encoded incoming subject', async () => {
      const { addr, sent, e } = await setup('');
      const evil = `=?UTF-8?B?${btoa('Hello\r\nBcc: victim@evil.test')}?=`;
      await deliver(addr, { from: 'client@partner.test', to: addr, subject: evil, body: 'x', headers: PASS }, e);
      expect(sent).toHaveLength(1);
      expect(sent[0].subject).not.toMatch(/[\r\n]/);
      expect(sent[0].subject).toMatch(/^Re: Hello +Bcc: victim@evil\.test$/);
    });
  });
  it('#1 stores the alignment verdict: spf+dkim pass for another domain is not verified', async () => {
    const addr = `${randomLocal()}@inbound.test`;
    await createMailbox(addr);
    const spoof = await deliver(addr, { from: 'Bank Payments <payments@bank.test>', to: addr, subject: 'New details', body: 'x',
      headers: { 'Authentication-Results': 'mx.cloudflare.net; dkim=pass header.d=attacker.test header.s=s1; spf=pass smtp.mailfrom=bounce@attacker.test; dmarc=none' } });
    const real = await deliver(addr, { from: 'Bank <payments@bank.test>', to: addr, subject: 'Statement', body: 'x',
      headers: { 'Authentication-Results': 'mx.cloudflare.net; dkim=pass header.d=bank.test; dmarc=pass header.from=bank.test; spf=pass smtp.mailfrom=bank.test' } });
    const auth = async (o: typeof spoof) => JSON.parse((await env.DB.prepare('SELECT auth_json FROM messages WHERE id = ?').bind(o.out.accepted ? o.out.messageId : '').first<string>('auth_json'))!);
    expect(await auth(spoof)).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'none', aligned: false });
    expect(await auth(real)).toMatchObject({ dmarc: 'pass', aligned: true });
  });

  it('lead: a sender-added Authentication-Results below or instead of Cloudflare\'s is ignored', async () => {
    const addr = `${randomLocal()}@inbound.test`;
    const mb = await createMailbox(addr);
    // Cloudflare prepends its header; the forged one sits lower in the message.
    const raw = buildEml({ from: 'ceo@bank.test', to: addr, subject: 'Wire', body: 'x', headers: { 'Authentication-Results': 'mx.cloudflare.net; dkim=pass header.d=bank.test; dmarc=pass header.from=bank.test' } });
    const out = await processInbound(fakeEmail('x@evil.test', addr, `Authentication-Results: mx.cloudflare.net; dkim=none; spf=fail smtp.mailfrom=evil.test; dmarc=fail header.from=bank.test\r\n${raw}`), env);
    expect(out.accepted && out.folderId).toBe(mb.folders.spam);
    const arc = await deliver(addr, { from: 'ceo@bank.test', to: addr, subject: 'Wire 2', body: 'x',
      headers: { 'ARC-Authentication-Results': 'i=1; mx.cloudflare.net; dmarc=pass header.from=bank.test', 'Authentication-Results': 'mx.google.com; dmarc=pass header.from=bank.test' } });
    const row = await env.DB.prepare('SELECT auth_json FROM messages WHERE id = ?').bind(arc.out.accepted ? arc.out.messageId : '').first<string>('auth_json');
    expect(row).toBeNull();
  });

  it('#6 an inbound copy of a sent Message-ID cannot capture replies to it', async () => {
    const addr = `${randomLocal()}@inbound.test`;
    const mb = await createMailbox(addr);
    const now = Date.now();
    const sentThread = ulid();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO threads (id, mailbox_id, subject, subject_norm, last_message_at, created_at) VALUES (?, ?, 'Q3 invoices', 'q3 invoices', ?, ?)").bind(sentThread, mb.id, now, now),
      env.DB.prepare(`INSERT INTO messages (id, mailbox_id, thread_id, folder_id, direction, status, message_id_hdr, from_email, to_json, subject, date, created_at, updated_at, folder_changed_at)
                      VALUES (?, ?, ?, ?, 'out', 'sent', '<sent-1@cirrus.test>', ?, ?, 'Q3 invoices', ?, ?, ?, ?)`)
        .bind(ulid(), mb.id, sentThread, mb.folders.sent, addr, JSON.stringify([{ email: 'cfo@client.test' }, { email: 'vendor@shady.test' }]), now, now, now, now),
    ]);
    const evil = await deliver(addr, { from: 'vendor@shady.test', to: addr, subject: 'Updated bank details for Q3', body: 'x', messageId: '<sent-1@cirrus.test>' });
    if (!evil.out.accepted) throw new Error('rejected');
    expect(evil.out.threadId).not.toBe(sentThread);
    expect(await env.DB.prepare('SELECT message_id_hdr FROM messages WHERE id = ?').bind(evil.out.messageId).first<string | null>('message_id_hdr')).toBeNull();
    // A redelivery of that same copy is still recognised as a duplicate, though its Message-ID was not stored.
    const evilRaw = buildEml({ from: 'vendor@shady.test', to: addr, subject: 'Updated bank details for Q3', body: 'x', messageId: '<sent-1@cirrus.test>', date: new Date(0) });
    const once = await processInbound(fakeEmail('vendor@shady.test', addr, evilRaw), env);
    const twice = await processInbound(fakeEmail('vendor@shady.test', addr, evilRaw), env);
    expect(twice.accepted && twice.duplicate).toBe(true);
    expect(twice.accepted && once.accepted && twice.messageId).toBe(once.accepted ? once.messageId : null);
    const reply = await deliver(addr, { from: 'cfo@client.test', to: addr, subject: 'Re: Q3 invoices', body: 'ok', inReplyTo: '<sent-1@cirrus.test>' });
    expect(reply.out.accepted && reply.out.threadId).toBe(sentThread);
    expect(await env.DB.prepare('SELECT subject FROM threads WHERE id = ?').bind(sentThread).first<string>('subject')).toBe('Q3 invoices');
  });

  it('replies to our sent mail thread from any address; an unrelated reference falls back to the subject rule', async () => {
    const addr = `${randomLocal()}@inbound.test`;
    const mb = await createMailbox(addr);
    const now = Date.now();
    const sentThread = ulid();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO threads (id, mailbox_id, subject, subject_norm, last_message_at, created_at) VALUES (?, ?, 'Refund', 'refund', ?, ?)").bind(sentThread, mb.id, now, now),
      env.DB.prepare(`INSERT INTO messages (id, mailbox_id, thread_id, folder_id, direction, status, message_id_hdr, from_email, to_json, subject, date, created_at, updated_at, folder_changed_at)
                      VALUES (?, ?, ?, ?, 'out', 'sent', '<sent-help@cirrus.test>', ?, '[{"email":"support@shop.test"}]', 'Refund', ?, ?, ?, ?)`)
        .bind(ulid(), mb.id, sentThread, mb.folders.sent, addr, now, now, now, now),
    ]);
    const agent = await deliver(addr, { from: 'agent.kim@shop.test', to: addr, subject: 'Re: Refund [#4411]', body: 'x', inReplyTo: '<sent-help@cirrus.test>' });
    expect(agent.out.accepted && agent.out.threadId).toBe(sentThread);

    const first = await deliver(addr, { from: 'alice@team.test', to: addr, subject: 'Budget', body: 'x', messageId: '<budget-1@team.test>' });
    const carol = await deliver(addr, { from: 'carol@team.test', to: addr, subject: 'Re: Budget', body: 'x', references: '<budget-1@team.test>', headers: { Cc: 'alice@team.test' } });
    expect(carol.out.accepted && carol.out.threadId).toBe(first.out.accepted ? first.out.threadId : '');
    // carol is now in the thread; her reply referencing only alice's message (no shared participant) still lands there by subject.
    const again = await deliver(addr, { from: 'carol@team.test', to: addr, subject: 'Re: Budget', body: 'y', inReplyTo: '<budget-1@team.test>' });
    expect(again.out.accepted && again.out.threadId).toBe(first.out.accepted ? first.out.threadId : '');
  });

  it('#7 a planted Message-ID neither drops the genuine message nor captures its replies', async () => {
    const addr = `${randomLocal()}@inbound.test`;
    await createMailbox(addr);
    const id = '<advisory-123@github.test>';
    const planted = await deliver(addr, { from: 'junk@evil.test', to: addr, subject: 'win', body: 'junk', messageId: id });
    const genuine = await deliver(addr, { from: 'notifications@github.test', to: addr, subject: 'Security advisory', body: 'patch now', messageId: id,
      headers: { 'Authentication-Results': 'mx.cloudflare.net; dkim=pass header.d=github.test; dmarc=pass header.from=github.test' } });
    if (!planted.out.accepted || !genuine.out.accepted) throw new Error('rejected');
    expect(genuine.out.duplicate).toBeUndefined();
    expect(genuine.out.messageId).not.toBe(planted.out.messageId);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE message_id_hdr = ?').bind(id).first<number>('n')).toBe(2);
    // A true redelivery (same bytes) is still a duplicate.
    const raw = buildEml({ from: 'notifications@github.test', to: addr, subject: 'Security advisory', body: 'patch now', messageId: id, date: new Date(0),
      headers: { 'Authentication-Results': 'mx.cloudflare.net; dkim=pass header.d=github.test; dmarc=pass header.from=github.test' } });
    const first = await processInbound(fakeEmail('n@github.test', addr, raw), env);
    const again = await processInbound(fakeEmail('n@github.test', addr, `Received: from relay2 by mx; ${new Date().toUTCString()}\r\n${raw}`), env);
    expect(again.accepted && again.duplicate).toBe(true);
    expect(again.accepted && first.accepted && again.messageId).toBe(first.accepted ? first.messageId : null);
    // Replies join the thread whose participants they share; a stranger referencing it starts a new one.
    const reply = await deliver(addr, { from: 'notifications@github.test', to: addr, subject: 'Re: advisory', body: 'x', inReplyTo: id });
    expect(reply.out.accepted && reply.out.threadId).toBe(genuine.out.threadId);
    const stranger = await deliver(addr, { from: 'other@unrelated.test', to: addr, subject: 'Security advisory', body: 'x', inReplyTo: id });
    expect(stranger.out.accepted && stranger.out.threadId).not.toBe(genuine.out.threadId);
    expect(stranger.out.accepted && stranger.out.threadId).not.toBe(planted.out.threadId);
  });

  it('#8 a sender-chosen Date is clamped for display and never reorders or renames the thread', async () => {
    const addr = `${randomLocal()}@inbound.test`;
    await createMailbox(addr);
    const first = await deliver(addr, { from: 'ap@vendor.test', to: addr, subject: 'Invoices', body: 'x', messageId: '<inv-1@vendor.test>' });
    const old = await deliver(addr, { from: 'ap@vendor.test', to: addr, subject: 'New bank details for all invoices', body: 'evil',
      inReplyTo: '<inv-1@vendor.test>', date: new Date('1971-01-01T00:00:00Z') });
    const future = await deliver(addr, { from: 'ap@vendor.test', to: addr, subject: 'Re: Invoices', body: 'pinned?', inReplyTo: '<inv-1@vendor.test>',
      date: new Date(Date.now() + 23 * 3600_000) });
    const latest = await deliver(addr, { from: 'ap@vendor.test', to: addr, subject: 'Re: Invoices', body: 'genuinely newest', inReplyTo: '<inv-1@vendor.test>' });
    if (!first.out.accepted || !old.out.accepted || !future.out.accepted || !latest.out.accepted) throw new Error('rejected');
    expect(old.out.threadId).toBe(first.out.threadId);
    const t = await env.DB.prepare('SELECT subject, snippet FROM threads WHERE id = ?').bind(first.out.threadId).first<{ subject: string; snippet: string }>();
    expect(t).toEqual({ subject: 'Invoices', snippet: 'genuinely newest' });
    const row = (id: string) => env.DB.prepare('SELECT date, display_date, created_at FROM messages WHERE id = ?').bind(id).first<{ date: number; display_date: number; created_at: number }>();
    const o = (await row(old.out.messageId!))!;
    expect(o.date).toBe(o.created_at);
    expect(o.display_date).toBe(o.created_at - 7 * 86_400_000);
    const f = (await row(future.out.messageId!))!;
    expect(f.display_date).toBe(f.created_at + 5 * 60_000);
  });

  it('lead: forward_to only runs while its creator is an active member; other actions still run', async () => {
    const addr = `${randomLocal()}@inbound.test`;
    const owner = await createUser();
    const mb = await createMailbox(addr, [{ userId: owner }]);
    const rule = (createdBy: string | null) => env.DB.prepare('INSERT INTO filters (id, mailbox_id, name, match, conditions, actions, enabled, sort, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)')
      .bind(ulid(), mb.id, 'f', 'all', JSON.stringify([{ field: 'subject', op: 'contains', value: 'report' }]),
        JSON.stringify([{ type: 'forward_to', email: 'out@forward.test' }, { type: 'star' }]), Date.now(), createdBy).run();
    const send = () => deliver(addr, { from: 'a@partner.test', to: addr, subject: 'Monthly report', body: 'x' });
    await rule(null);                                  // legacy row: no creator
    const legacy = await send();
    expect(legacy.msg.forwarded).toEqual([]);
    expect(await env.DB.prepare('SELECT is_starred FROM messages WHERE id = ?').bind(legacy.out.accepted ? legacy.out.messageId : '').first<number>('is_starred')).toBe(1);
    await env.DB.prepare('DELETE FROM filters WHERE mailbox_id = ?').bind(mb.id).run();
    await rule(owner);
    expect((await send()).msg.forwarded).toEqual(['out@forward.test']);
    await env.DB.prepare('UPDATE users SET disabled = 1 WHERE id = ?').bind(owner).run();
    expect((await send()).msg.forwarded).toEqual([]);
    await env.DB.prepare('UPDATE users SET disabled = 0 WHERE id = ?').bind(owner).run();
    // Demoted to a plain member: no longer allowed to forward; an admin who is a plain member still is.
    await env.DB.prepare("UPDATE mailbox_members SET role = 'member' WHERE mailbox_id = ? AND user_id = ?").bind(mb.id, owner).run();
    expect((await send()).msg.forwarded).toEqual([]);
    await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(owner).run();
    expect((await send()).msg.forwarded).toEqual(['out@forward.test']);
    await env.DB.prepare("UPDATE users SET role = 'member' WHERE id = ?").bind(owner).run();
    await env.DB.prepare('DELETE FROM mailbox_members WHERE mailbox_id = ? AND user_id = ?').bind(mb.id, owner).run();
    expect((await send()).msg.forwarded).toEqual([]);
  });
});
