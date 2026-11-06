import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ulid } from '../src/shared/ulid';
import { AUTOREPLY_DAILY_CAP } from '../src/worker/inbound/autoreply';
import { processInbound } from '../src/worker/inbound/handler';
import { normalizeSubject, parseMessageIds } from '../src/worker/inbound/thread';
import { buildEml, createMailbox, ensureDomain, fakeEmail, randomLocal, withEnv } from './helpers';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);

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
      messageId: '<dup-1@lookalike.test>',
    });
    expect(spam.out.accepted && spam.out.folderId).toBe(mb.folders.spam);
    const again = await deliver(addr, { from: 'billing@lookalike.test', to: addr, subject: 'Invoice overdue', body: 'pay now', messageId: '<dup-1@lookalike.test>' });
    expect(again.out.accepted && again.out.duplicate).toBe(true);

    await env.DB.prepare('INSERT INTO blocked_senders (id, mailbox_id, pattern, created_at) VALUES (?, ?, ?, ?)').bind(ulid(), mb.id, '@blocked.test', Date.now()).run();
    const blocked = await deliver(addr, { from: 'a@blocked.test', to: addr, subject: 'hello', body: 'x' });
    expect(blocked.out.accepted && blocked.out.folderId).toBe(mb.folders.spam);
  });

  it('applies filters and survives a corrupt regex', async () => {
    const addr = `${randomLocal()}@inbound.test`;
    const mb = await createMailbox(addr);
    const add = (conditions: unknown, actions: unknown, sort: number) =>
      env.DB.prepare('INSERT INTO filters (id, mailbox_id, name, match, conditions, actions, enabled, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)')
        .bind(ulid(), mb.id, 'f', 'all', JSON.stringify(conditions), JSON.stringify(actions), sort, Date.now()).run();
    await add([{ field: 'subject', op: 'regex', value: '([unclosed' }], [{ type: 'delete' }], 1);
    await add([{ field: 'list_id', op: 'contains', value: 'digest' }], [{ type: 'move_to', folderId: mb.folders.archive }, { type: 'mark_read' }, { type: 'forward_to', email: 'me@forward.test' }], 2);
    const r = await deliver(addr, { from: 'news@digest.test', to: addr, subject: 'Weekly digest', body: 'x', headers: { 'List-Id': 'Digest <digest.example>' } });
    expect(r.out.accepted && r.out.folderId).toBe(mb.folders.archive);
    expect(r.msg.forwarded).toEqual(['me@forward.test']);
    const row = await env.DB.prepare('SELECT is_read, list_id FROM messages WHERE id = ?').bind(r.out.accepted ? r.out.messageId : '').first();
    expect(row).toEqual({ is_read: 1, list_id: 'Digest <digest.example>' });
  });

  describe('vacation auto-reply', () => {
    const PASS = { 'Authentication-Results': 'mx.cloudflare.net; dkim=pass; spf=pass smtp.mailfrom=partner.test; dmarc=pass' };
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

    it('strips CR/LF smuggled through an encoded incoming subject', async () => {
      const { addr, sent, e } = await setup('');
      const evil = `=?UTF-8?B?${btoa('Hello\r\nBcc: victim@evil.test')}?=`;
      await deliver(addr, { from: 'client@partner.test', to: addr, subject: evil, body: 'x', headers: PASS }, e);
      expect(sent).toHaveLength(1);
      expect(sent[0].subject).not.toMatch(/[\r\n]/);
      expect(sent[0].subject).toMatch(/^Re: Hello +Bcc: victim@evil\.test$/);
    });
  });
});
