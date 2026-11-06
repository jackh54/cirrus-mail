import { describe, expect, it } from 'vitest';
import type { Filter } from '../src/shared/api';
import { compileRegex, evaluateFilters, MAX_FIELD_LENGTH, MAX_REGEX_INPUT, regexSafetyIssue, type FilterSubject } from '../src/worker/inbound/filters';
import { isAligned, isBlocked, parseAuthResults, scoreSpam, spfPassesFor, toAuthResults, trustedAuthResults } from '../src/worker/inbound/spam';

describe('spam scoring', () => {
  it('parses Authentication-Results', () => {
    expect(parseAuthResults('mx.cloudflare.net; dkim=pass header.d=x.test; spf=softfail smtp.mailfrom=x.test; dmarc=fail header.from=x.test'))
      .toEqual({ authservId: 'mx.cloudflare.net', dkim: 'pass', dkimPassDomains: ['x.test'], spf: 'softfail', spfMailFrom: 'x.test', dmarc: 'fail', dmarcHeaderFrom: 'x.test' });
    expect(parseAuthResults(null)).toBeNull();
  });
  it('scores dmarc/spf/dkim failures', () => {
    expect(scoreSpam({ auth: { dmarc: 'fail' }, blocked: false, inContacts: false })).toEqual({ score: 5, isSpam: true });
    expect(scoreSpam({ auth: { spf: 'fail', dkim: 'fail' }, blocked: false, inContacts: false })).toEqual({ score: 4, isSpam: false });
    expect(scoreSpam({ auth: { dmarc: 'fail', spf: 'fail', dkim: 'fail' }, blocked: false, inContacts: false })).toEqual({ score: 9, isSpam: true });
    expect(scoreSpam({ auth: { dmarc: 'pass' }, blocked: false, inContacts: false })).toEqual({ score: 0, isSpam: false });
  });
  it('contacts get a bonus and are never spam, unless DMARC failed; blocked always is', () => {
    expect(scoreSpam({ auth: { spf: 'fail', dkim: 'fail', aligned: true }, blocked: false, inContacts: true })).toEqual({ score: 1, isSpam: false });
    expect(scoreSpam({ auth: { dmarc: 'pass', spf: 'fail', aligned: true }, blocked: false, inContacts: true })).toEqual({ score: 0, isSpam: false });
    expect(scoreSpam({ auth: null, blocked: true, inContacts: true }).isSpam).toBe(true);
  });
  it('a spoofed contact (dmarc=fail) gets no bonus and stays spam', () => {
    expect(scoreSpam({ auth: { dmarc: 'fail' }, blocked: false, inContacts: true })).toEqual({ score: 5, isSpam: true });
    expect(scoreSpam({ auth: { dmarc: 'fail', spf: 'fail', dkim: 'fail' }, blocked: false, inContacts: true })).toEqual({ score: 9, isSpam: true });
  });
  it('#1 verified needs a pass aligned with the From domain, not just spf=pass dkim=pass', () => {
    const spoof = parseAuthResults('mx.cloudflare.net; dkim=pass header.d=attacker.test header.s=s1; spf=pass smtp.mailfrom=bounce@attacker.test; dmarc=none');
    expect(toAuthResults(spoof, 'bank.test')).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'none', aligned: false });
    const dmarc = parseAuthResults('mx.cloudflare.net; dkim=pass header.d=gmail.com header.s=x; dmarc=pass header.from=gmail.com policy.dmarc=none; spf=none (no record) smtp.helo=mail.gmail.com');
    expect(isAligned(dmarc, 'gmail.com')).toBe(true);
    expect(isAligned(dmarc, 'bank.test')).toBe(false);                     // dmarc passed for another header.from
    const parent = parseAuthResults('mx.cloudflare.net; dkim=pass header.d=bank.test; dmarc=none');
    expect(isAligned(parent, 'alerts.bank.test')).toBe(true);              // d= is the From domain's org parent
    expect(isAligned(parent, 'evilbank.test')).toBe(false);
    expect(isAligned(parseAuthResults('mx.cloudflare.net; dkim=pass header.d=mail.bank.test; dmarc=none'), 'bank.test')).toBe(false);
    expect(isAligned(parseAuthResults('mx.cloudflare.net; dkim=fail header.d=bank.test; dmarc=fail header.from=bank.test'), 'bank.test')).toBe(false);
  });

  it('#1 an unaligned pass earns a known contact no bonus', () => {
    expect(scoreSpam({ auth: { spf: 'fail', dkim: 'fail', dmarc: 'none', aligned: false }, blocked: false, inContacts: true })).toEqual({ score: 4, isSpam: false });
    expect(scoreSpam({ auth: { spf: 'fail', dkim: 'fail' }, blocked: false, inContacts: true })).toEqual({ score: 4, isSpam: false }); // old rows: no aligned
  });

  it('#4 SPF must pass for the envelope domain (smtp.mailfrom), not the HELO name', () => {
    expect(spfPassesFor(parseAuthResults('mx.cloudflare.net; spf=pass smtp.mailfrom=bounce@esp.test'), 'esp.test')).toBe(true);
    expect(spfPassesFor(parseAuthResults('mx.cloudflare.net; spf=pass smtp.mailfrom=bounce@esp.test'), 'victim.test')).toBe(false);
    expect(spfPassesFor(parseAuthResults('mx.cloudflare.net; spf=pass smtp.helo=victim.test'), 'victim.test')).toBe(false);
    expect(spfPassesFor(parseAuthResults('mx.cloudflare.net; spf=softfail smtp.mailfrom=victim.test'), 'victim.test')).toBe(false);
  });

  it('Authentication-Results: only the topmost mx.cloudflare.net header, tokenized per resinfo', () => {
    // A verdict-looking property value or comment is not a verdict.
    const smuggled = parseAuthResults('mx.cloudflare.net; spf=softfail smtp.mailfrom=dmarc=pass@evil.test; dkim=none (dmarc=pass header.from=bank.test); dmarc=fail header.from=bank.test');
    expect(smuggled).toMatchObject({ spf: 'softfail', dkim: 'none', dmarc: 'fail', dmarcHeaderFrom: 'bank.test' });
    expect(parseAuthResults('mx.cloudflare.net; spf=pass smtp.mailfrom="dmarc=pass; dkim=pass"@evil.test')).toMatchObject({ spf: 'pass' });
    expect(parseAuthResults('mx.cloudflare.net; spf=pass smtp.mailfrom="dmarc=pass; dkim=pass"@evil.test')?.dmarc).toBeUndefined();
    expect(parseAuthResults('mx.cloudflare.net (comment; dmarc=pass); dmarc=fail header.from=a.test')?.dmarc).toBe('fail');
    // First verdict per method wins (dkim: any pass); a result must be a plain keyword.
    expect(parseAuthResults('mx.cloudflare.net; dmarc=fail header.from=a.test; dmarc=pass header.from=a.test')?.dmarc).toBe('fail');
    expect(parseAuthResults('mx.cloudflare.net; dmarc=pass@evil header.from=a.test')?.dmarc).toBeUndefined();
    // Sender-supplied headers with another authserv-id (or a look-alike) are ignored; the topmost trusted one wins.
    const fake = 'mx.cloudflare.net.evil.test; dmarc=pass header.from=bank.test';
    const real = 'mx.cloudflare.net; dkim=none; spf=none smtp.helo=x; dmarc=fail header.from=bank.test';
    expect(trustedAuthResults([real, fake])?.dmarc).toBe('fail');
    expect(trustedAuthResults([fake, real])).toBeNull();
    expect(trustedAuthResults(['evil.test; dmarc=pass header.from=bank.test'])).toBeNull();
    expect(trustedAuthResults([real, 'mx.cloudflare.net; dmarc=pass header.from=bank.test'])?.dmarc).toBe('fail');
    // Only the very first header counts: a planted Cloudflare-looking one below a non-Cloudflare first header is ignored.
    expect(trustedAuthResults(['mx.google.com; dmarc=fail header.from=bank.test', 'mx.cloudflare.net; dmarc=pass header.from=bank.test'])).toBeNull();
    expect(trustedAuthResults([])).toBeNull();
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
    for (const p of ['(a+)+', '(a|b)*', '(?:\\w+\\s?)+$', '((ab)*)+', '(a|aa){2,}', '((a|b))+', '(x)\\1', '(?<n>a)\\k<n>', '([a-z]+)*@',
      '(ab)+', '\\(a+\\)+', '\\d+-\\d+', '[(]a+[)]+']) {
      expect(regexSafetyIssue(p), p).not.toBeNull();
      expect(compileRegex(p), p).toBeNull();
    }
    for (const p of ['^your\\s+weekly', '[a+|]+', 'invoice-\\d{4}', '(foo|bar)', '(?:re|fwd):', '\\d+-\\d{2}', '[(]a+[)]']) {
      expect(regexSafetyIssue(p), p).toBeNull();
      expect(compileRegex(p), p).not.toBeNull();
    }
  });

  it('lead: one unbounded quantifier at most, no quantified groups, lookarounds or long alternative chains', () => {
    for (const p of ['.*.*.*x', 'a+b+', '\\s*\\w+', 'a{2,}b*', '(foo)?', '(ab){2}', '(?=a)b', '(?!a)b', '(?<=a)b', '(?<!a)b',
      '(?:a|b)(?:a|b)(?:a|b)(?:a|b)(?:a|b)(?:a|b)', 'a?a?a?a?a?a?', '.{0,100}x', 'a{0,40}']) {
      expect(regexSafetyIssue(p), p).not.toBeNull();
      expect(compileRegex(p), p).toBeNull();
    }
    for (const p of ['.*x', 'a+?b', '\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}', 'colou?r', '(foo|bar|baz)@.*', 'https?://[^/]+']) {
      expect(regexSafetyIssue(p), p).toBeNull();
    }
  });

  // Guards against catastrophic (exponential) backtracking, which takes seconds. The best of
  // five runs keeps the assertion stable on a loaded CI machine.
  it('lead: the worst allowed patterns stay fast on a capped (256-char) field', () => {
    const worst = ['.*(?:aa|a)(?:aa|a)(?:aa|a)(?:aa|a)(?:aa|a)!', '.*a{0,31}!', '[\\s\\S]*a?a?a?a?a?!', '.{0,31}.*!', 'a{0,31}.*!'];
    const inputs = ['a'.repeat(MAX_FIELD_LENGTH), `${'a'.repeat(MAX_FIELD_LENGTH - 1)}?`, 'ab'.repeat(MAX_FIELD_LENGTH / 2)];
    for (const p of worst) {
      expect(regexSafetyIssue(p), p).toBeNull();
      for (const input of inputs) {
        let best = Infinity;
        for (let run = 0; run < 5; run++) {
          const t = performance.now();
          evaluateFilters([f({ conditions: [{ field: 'subject', op: 'regex', value: p }], actions: [{ type: 'star' }] })], { ...subject, subject: input });
          best = Math.min(best, performance.now() - t);
        }
        expect(best, p).toBeLessThan(50);
      }
    }
    // Regexes see only the first 256 characters; other ops keep 1 KB.
    const pad = 'x'.repeat(MAX_REGEX_INPUT);
    const out = evaluateFilters([
      f({ id: 're', conditions: [{ field: 'subject', op: 'regex', value: 'urgent' }], actions: [{ type: 'star' }] }),
      f({ id: 'has', conditions: [{ field: 'subject', op: 'contains', value: 'urgent' }], actions: [{ type: 'mark_read' }] }),
    ], { ...subject, subject: `${pad}urgent` });
    expect(out.matched).toEqual(['has']);
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
