import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { buildFtsQuery, buildSearchSql, ftsQuote, parseSearch } from '../src/worker/search';

describe('search parser', () => {
  it('parses operators and free text', () => {
    const p = parseSearch('from:alice@x.com to:bob subject:"quarterly plan" has:attachment is:unread is:starred budget review');
    expect(p.from).toEqual(['alice@x.com']);
    expect(p.to).toEqual(['bob']);
    expect(p.subject).toEqual(['quarterly plan']);
    expect(p.hasAttachment).toBe(true);
    expect(p.isUnread).toBe(true);
    expect(p.isStarred).toBe(true);
    expect(p.text.map((t) => t.value)).toEqual(['budget', 'review']);
  });

  it('keeps quoted phrases and unknown operators as text', () => {
    const p = parseSearch('"launch day" foo:bar');
    expect(p.text).toEqual([{ value: 'launch day', phrase: true }, { value: 'foo:bar', phrase: false }]);
  });

  it('quotes every FTS term and prefixes only the last bare word', () => {
    expect(buildFtsQuery(parseSearch('hello wor').text)).toBe('"hello" "wor"*');
    expect(buildFtsQuery(parseSearch('"exact phrase"').text)).toBe('"exact phrase"');
    expect(ftsQuote('a"b')).toBe('"a""b"');
    expect(buildFtsQuery(parseSearch('*** ()').text)).toBeNull();
  });

  it('neutralises FTS5 syntax injection', () => {
    const q = buildFtsQuery(parseSearch('foo" OR body:secret NEAR( x').text)!;
    // Every token is inside quotes; OR / NEAR / column filters are literal words.
    expect(q).toBe('"foo""" "OR" "body:secret" "NEAR(" "x"*');
  });

  it('builds parameterised SQL', () => {
    const s = buildSearchSql(parseSearch("from:o'brien% is:unread hi"));
    expect(s.where.join(' ')).not.toContain("o'brien");
    expect(s.params).toContain("%o'brien\\%%");
    expect(s.params[s.params.length - 1]).toBe('"hi"*');
  });

  it('runs hostile queries against real FTS5 without errors', async () => {
    await env.DB.prepare('INSERT INTO messages_fts (message_id, mailbox_id, subject, addresses, body) VALUES (?, ?, ?, ?, ?)')
      .bind('fts-test-1', 'mb-fts', 'Quarterly planning', 'dana@x.test', 'Notes on the roadmap and hiring').run();
    for (const raw of ['roadm', 'foo" OR "1', 'NEAR(a b)', 'subject:x', '-', '"unterminated', 'planning hiring']) {
      const q = buildFtsQuery(parseSearch(raw).text);
      if (!q) continue;
      const { results } = await env.DB.prepare('SELECT message_id FROM messages_fts WHERE messages_fts MATCH ?').bind(q).all();
      expect(Array.isArray(results)).toBe(true);
    }
    const hit = await env.DB.prepare('SELECT message_id FROM messages_fts WHERE messages_fts MATCH ?').bind(buildFtsQuery(parseSearch('roadm').text)).all();
    expect(hit.results.map((r) => r.message_id)).toContain('fts-test-1');
  });
});
