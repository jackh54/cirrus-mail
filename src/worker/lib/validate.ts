import type { Context } from 'hono';
import { z } from 'zod';
import { HttpError } from './errors';

/** Parses and validates a JSON body with zod; malformed JSON is a 400, never a 500. */
export async function jsonBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be JSON');
  }
  return schema.parse(raw);
}

/** Replaces CR, LF and every other control character with a space (header-injection guard). */
export function cleanHeaderText(s: string): string {
  return s.replace(/[\r\n\x00-\x1f\x7f]/g, ' ');
}

/** Free text that may end up in a mail header (names, subjects): control characters become spaces. */
export const zHeaderText = (max: number, min = 0) => z.string().max(max * 2).transform(cleanHeaderText).pipe(z.string().trim().min(min).max(max));

export const zEmail = z.string().trim().toLowerCase().max(254).regex(/^[^\s@<>()",;:\x00-\x1f\x7f]+@[^\s@<>()",;:\x00-\x1f\x7f]+\.[^\s@<>()",;:\x00-\x1f\x7f]+$/, 'Invalid email address');
export const zPassword = z.string().min(8, 'Password must be at least 8 characters').max(256);
export const zName = zHeaderText(120, 1);
export const zId = z.string().min(1).max(64);
export const zAddress = z.object({ email: zEmail, name: zHeaderText(200).optional() });
export const zLocalPart = z.string().trim().toLowerCase().min(1).max(64).regex(/^[a-z0-9._+-]+$/, 'Invalid local part');
export const zDomainName = z.string().trim().toLowerCase().min(3).max(253).regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Invalid domain');
