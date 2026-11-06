import { addressParser } from 'postal-mime';
import type { Address as PMAddress } from 'postal-mime';
import type { Address } from '../../shared/api';

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().replace(/^<|>$/g, '').toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

export function domainOf(email: string): string {
  const i = email.lastIndexOf('@');
  return i < 0 ? '' : email.slice(i + 1).toLowerCase();
}

export function localPartOf(email: string): string {
  const i = email.lastIndexOf('@');
  return i < 0 ? email : email.slice(0, i);
}

/** Flattens postal-mime addresses (including groups) into our Address shape. */
export function fromParsed(list: PMAddress[] | PMAddress | undefined): Address[] {
  if (!list) return [];
  const arr = Array.isArray(list) ? list : [list];
  const out: Address[] = [];
  for (const a of arr) {
    if (a.group) out.push(...fromParsed(a.group));
    else if (a.address) out.push(a.name ? { email: normalizeEmail(a.address), name: a.name } : { email: normalizeEmail(a.address) });
  }
  return out;
}

export function parseAddressList(header: string): Address[] {
  return fromParsed(addressParser(header, { flatten: true }));
}

export function dedupeAddresses(list: Address[]): Address[] {
  const seen = new Set<string>();
  return list.filter((a) => {
    const k = a.email.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function parseJsonAddresses(json: string | null | undefined): Address[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** True when `email` matches a blocklist pattern: full address or `@domain`. */
export function matchesPattern(email: string, pattern: string): boolean {
  const e = email.toLowerCase();
  const p = pattern.toLowerCase().trim();
  if (p.startsWith('@')) return e.endsWith(p);
  return e === p;
}
