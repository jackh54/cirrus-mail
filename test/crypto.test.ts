import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hashPassword, hotp, totp, verifyPassword, verifyTotp, timingSafeEqual } from '../src/worker/lib/crypto';

describe('PBKDF2 passwords', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored).toMatch(/^pbkdf2\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', stored)).toBe(false);
  });

  it('rejects malformed hashes and over-limit iteration counts', async () => {
    expect(await verifyPassword('x', 'plain')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2$999999$AAAA$AAAA')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2$100000$!!$AAAA')).toBe(false);
  });

  it('uses a fresh salt every time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });
});

describe('TOTP (RFC 6238, SHA-1)', () => {
  const key = new TextEncoder().encode('12345678901234567890');
  const vectors: [number, string][] = [
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
  ];
  for (const [t, code] of vectors) {
    it(`T=${t} → ${code}`, async () => {
      expect(await totp(key, t * 1000, 8)).toBe(code);
    });
  }

  it('matches RFC 4226 HOTP vectors', async () => {
    expect(await hotp(key, 0)).toBe('755224');
    expect(await hotp(key, 9)).toBe('520489');
  });

  it('verifies 6-digit codes with a ±1 step window', async () => {
    const secret = base32Encode(key);
    const now = 1_700_000_000_000;
    const current = await totp(key, now);
    const prev = await totp(key, now - 30_000);
    const far = await totp(key, now - 90_000);
    expect(await verifyTotp(secret, current, now)).toBe(true);
    expect(await verifyTotp(secret, prev, now)).toBe(true);
    expect(await verifyTotp(secret, far, now)).toBe(far === current || far === prev);
    expect(await verifyTotp(secret, 'abcdef', now)).toBe(false);
  });
});

describe('helpers', () => {
  it('base32 round-trips', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 7, 99]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Encode(new TextEncoder().encode('foobar'))).toBe('MZXW6YTBOI');
  });
  it('constant-time compare', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});
