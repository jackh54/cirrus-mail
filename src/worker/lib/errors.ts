import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';

/** An error that maps directly to an `{ error: { code, message } }` JSON response. */
export class HttpError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, 'NOT_FOUND', what);
export const badRequest = (message: string, code = 'BAD_REQUEST') => new HttpError(400, code, message);
export const forbidden = (message = 'Forbidden', code = 'FORBIDDEN') => new HttpError(403, code, message);

export function errorBody(code: string, message: string, details?: unknown) {
  return details === undefined ? { error: { code, message } } : { error: { code, message, details } };
}

export function onError(err: Error, c: Context) {
  if (err instanceof HttpError) {
    return c.json(errorBody(err.code, err.message, err.details), err.status);
  }
  if (err instanceof ZodError) {
    return c.json(errorBody('VALIDATION_ERROR', 'Invalid request body', err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))), 400);
  }
  // Never log request bodies, mail content or addresses: the error name only.
  console.error('unhandled', err.name);
  return c.json(errorBody('INTERNAL', 'Internal error'), 500);
}
