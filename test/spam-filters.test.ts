import { describe, expect, it } from 'vitest';
import type { Filter } from '../src/shared/api';
import { compileRegex, evaluateFilters, MAX_FIELD_LENGTH, regexSafetyIssue, type FilterSubject } from '../src/worker/inbound/filters';
import { isBlocked, parseAuthResults, scoreSpam } from '../src/worker/inbound/spam';

describe('spam scoring', () => {
  it('parses Authentication-Results', () => {
    expect(parseAuthResults('mx.cloudflare.net; dkim=pass header.d=x.test; spf=softfail smtp.mailfrom=x.test; dmarc=fail header.from=x.test'))
      .toEqual({ dkim: 'pass', spf: 'softfail', dmarc: 'fail' });
    expect(parseAuthResults(null)).toBeNull();
  });
  it('scores dmarc/spf/dkim failures', () => {
    expect(scoreSpam({ auth: { dmarc: 'fail' }, blocked: false, inContacts: false })).toEqual({ score: 5, isSpam: true });
    expect(scoreSpam({ auth: { spf: 'fail', dkim: 'fail' }, blocked: false, inContacts: false })).toEqual({ score: 4, isSpam: false });
    expect(scoreSpam({ auth: { dmarc: 'fail', spf: 'fail', dkim: 'fail' }, blocked: false, inContacts: false })).toEqual({ score: 9, isSpam: true });
    expect(scoreSpam({ auth: { dmarc: 'pass' }, blocked: false, inContacts: false })).toEqual({ score: 0, isSpam: false });
  });
  it('contacts get a bonus and are never spam, unless DMARC failed; blocked always is', () => {
    expect(scoreSpam({ auth: { spf: 'fail', dkim: 'fail' }, blocked: false, inContacts: true })).toEqual({ score: 1, isSpam: false });
    expect(scoreSpam({ auth: { dmarc: 'pass', spf: 'fail' }, blocked: false, inContacts: true })).toEqual({ score: 0, isSpam: false });
    expect(scoreSpam({ auth: null, blocked: true, inContacts: true }).isSpam).toBe(true);
  });
  it('a spoofed contact (dmarc=fail) gets no bonus and stays spam', () => {
    expect(scoreSpam({ auth: { dmarc: 'fail' }, blocked: false, inContacts: true })).toEqual({ score: 5, isSpam: true });
    expect(scoreSpam({ auth: { dmarc: 'fail', spf: 'fail', dkim: 'fail' }, blocked: false, inContacts: true })).toEqual({ score: 9, isSpam: true });
  });
  it('matches blocklist patterns', () => {
    expect(isBlocked('a@spam.test', ['@spam.test'])).toBe(true);
    expect(isBlocked('a@notspam.test', ['@spam.test'])).toBe(false);
    expect(isBlocked('Bob@X.test', ['bob@x.test'])).toBe(true);
  });
});

describe('filter evaluation', () => {
  const subject: FilterSubject = {
    from: { email: 'news@updates.example', name: 'Weekly Digest' }, to: ['me@cirrus.test'], subject: 'Your weekly digest',
    hasAttachment: true, listId: '<digest.updates.example>',
  };
  const f = (p: Partial<Filter>): Filter => ({ id: p.id ?? 'f', name: 'f', match: 'all', conditions: [], actions: [], enabled: true, sort: 0, ...p });

  it('matches contains / equals / ends_with / regex / is_true', () => {
    const out = evaluateFilters([
      f({ id: 'a', conditions: [{ field: 'from', op: 'ends_with', value: '@updates.example' }], actions: [{ type: 'move_to', folderId: 'news' }] }),
      f({ id: 'b', conditions: [{ field: 'subject', op: 'regex', value: '^your\\s+weekly' }], actions: [{ type: 'mark_read' }] }),
      f({ id: 'c', conditions: [{ field: 'has_attachment', op: 'is_true', value: '' }], actions: [{ type: 'star' }] }),
      f({ id: 'd', conditions: [{ field: 'to', op: 'equals', value: 'other@cirrus.test' }], actions: [{ type: 'delete' }] }),
      f({ id: 'e', conditions: [{ field: 'list_id', op: 'contains', value: 'digest' }], actions: [{ type: 'forward_to', email: 'x@y.test' }] }),
    ], subject);
    expect(out).toMatchObject({ folderId: 'news', markRead: true, star: true, trash: false, forwards: ['x@y.test'], matched: ['a', 'b', 'c', 'e'] });
  });

  it('supports match=any, sort order and disabled rules', () => {
    const out = evaluateFilters([
      f({ id: 'late', sort: 10, conditions: [{ field: 'subject', op: 'contains', value: 'digest' }], actions: [{ type: 'move_to', folderId: 'second' }] }),
      f({ id: 'early', sort: 1, match: 'any', conditions: [{ field: 'subject', op: 'equals', value: 'nope' }, { field: 'from', op: 'contains', value: 'weekly digest' }], actions: [{ type: 'move_to', folderId: 'first' }] }),
      f({ id: 'off', enabled: false, conditions: [{ field: 'subject', op: 'contains', value: 'digest' }], actions: [{ type: 'delete' }] }),
    ], subject);
    expect(out.matched).toEqual(['early', 'late']);
    expect(out.folderId).toBe('second');
    expect(out.trash).toBe(false);
  });

  it('a bad or oversized regex never throws and never matches', () => {
    expect(compileRegex('(unclosed')).toBeNull();
    expect(compileRegex('a'.repeat(201))).toBeNull();
    const run = () => evaluateFilters([f({ conditions: [{ field: 'subject', op: 'regex', value: '([a-z' }], actions: [{ type: 'star' }] })], subject);
    expect(run).not.toThrow();
    expect(run().star).toBe(false);
  });

  it('rejects ReDoS-prone patterns and backreferences, keeps ordinary ones', () => {
    for (const p of ['(a+)+', '(a|b)*', '(?:\\w+\\s?)+$', '((ab)*)+', '(a|aa){2,}', '((a|b))+', '(x)\\1', '(?<n>a)\\k<n>', '([a-z]+)*@']) {
      expect(regexSafetyIssue(p), p).not.toBeNull();
      expect(compileRegex(p), p).toBeNull();
    }
    for (const p of ['^your\\s+weekly', '(ab)+', '[a+|]+', '\\(a+\\)+', 'invoice-\\d{4}', '(foo|bar)', '(?:re|fwd):', '\\d+-\\d+', '[(]a+[)]+']) {
      expect(regexSafetyIssue(p), p).toBeNull();
      expect(compileRegex(p), p).not.toBeNull();
    }
  });

  it('caps every matched field at 1 KB, display names included', () => {
    const pad = 'x'.repeat(MAX_FIELD_LENGTH);
    const long: FilterSubject = { ...subject, from: { email: 'a@b.test', name: `${pad}boss` }, subject: `${pad}urgent`, to: [`${pad}@team.test`] };
    const out = evaluateFilters([
      f({ id: 'name', conditions: [{ field: 'from', op: 'contains', value: 'boss' }], actions: [{ type: 'star' }] }),
      f({ id: 'subj', conditions: [{ field: 'subject', op: 'regex', value: 'urgent' }], actions: [{ type: 'mark_read' }] }),
      f({ id: 'to', conditions: [{ field: 'to', op: 'ends_with', value: '@team.test' }], actions: [{ type: 'delete' }] }),
    ], long);
    expect(out.matched).toEqual([]);
  });
});
