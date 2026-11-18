import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ulid } from '../src/shared/ulid';
import { randomBytes, sha256Hex, toBase64Url } from '../src/worker/lib/crypto';
import { buildFtsQuery, buildSearchSql, ftsQuote, parseSearch, SEARCH_MAX_PER_MINUTE, SEARCH_WINDOW_MS, searchRateKey } from '../src/worker/search';
import { call, createMailbox, randomLocal } from './helpers';

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

  it('only prefix-matches the last bare word when it is at least 3 characters', () => {
    expect(buildFtsQuery(parseSearch('a').text)).toBe('"a"');
    expect(buildFtsQuery(parseSearch('ab').text)).toBe('"ab"');
    expect(buildFtsQuery(parseSearch('abc').text)).toBe('"abc"*');
    expect(buildFtsQuery(parseSearch('hello ab').text)).toBe('"hello" "ab"');
    expect(buildFtsQuery(parseSearch('"ab"').text)).toBe('"ab"');
    expect(buildFtsQuery(parseSearch('"abcd"').text)).toBe('"abcd"');
  });

  it('matches nothing when free text has no searchable term', () => {
    expect(buildSearchSql(parseSearch('*** ()')).where).toEqual(['0']);
    expect(buildSearchSql(parseSearch('is:unread')).where).toEqual(['m.is_read = 0']);
  });

  it('neutralises FTS5 syntax injection', () => {
    const q = buildFtsQuery(parseSearch('foo" OR body:secret NEAR( x').text)!;
    // Every token is inside quotes; OR / NEAR / column filters are literal words.
    expect(q).toBe('"foo""" "OR" "body:secret" "NEAR(" "x"');
  });

  it('builds parameterised SQL', () => {
    const s = buildSearchSql(parseSearch("from:o'brien% is:unread hi"));
    expect(s.where.join(' ')).not.toContain("o'brien");
    expect(s.params).toContain("%o'brien\\%%");
    expect(s.params[s.params.length - 1]).toBe('"hi"');
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

describe('text search rate limit', () => {
  it('returns 429 on /threads?q= after the per-user limit, but not for operator-only queries', async () => {
    const id = ulid();
    const now = Date.now();
    await env.DB.prepare('INSERT INTO users (id, email, name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, `${randomLocal('rl')}@search.test`, 'rl', 'x', 'member', now, now).run();
    const token = toBase64Url(randomBytes(32));
    await env.DB.prepare('INSERT INTO sessions (id, token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(ulid(), await sha256Hex(token), id, now, now, now + 3600_000).run();
    const cookie = `cirrus_session=${token}`;
    const mb = await createMailbox(`${randomLocal('rl')}@search.test`, [{ userId: id }]);
    const search = (q: string) => call(`/api/mailboxes/${mb.id}/threads?q=${encodeURIComponent(q)}`, { cookie });
    await env.DB.prepare('INSERT INTO rate_limits (key, count, window_end) VALUES (?, ?, ?)')
      .bind(searchRateKey(id), SEARCH_MAX_PER_MINUTE, now + SEARCH_WINDOW_MS).run();
    expect((await search('is:unread')).status).toBe(200);
    const limited = await search('hello');
    expect(limited.status).toBe(429);
    expect((await limited.json<{ error: { code: string } }>()).error.code).toBe('RATE_LIMITED');
  });
});
