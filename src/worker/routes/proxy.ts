import { Hono } from 'hono';
import { z } from 'zod';
import { HttpError } from '../lib/errors';
import { isSafeRemoteUrl, signProxyUrl, verifyProxySig } from '../lib/sign';
import { jsonBody } from '../lib/validate';
import { requireAuth } from '../middleware/session';
import type { AppEnv } from '../types';

export const proxy = new Hono<AppEnv>();

export const PROXY_MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;

proxy.post('/sign', requireAuth, async (c) => {
  const body = await jsonBody(c, z.object({ urls: z.array(z.string().max(4096)).max(200) }));
  const signed: Record<string, string> = {};
  for (const url of new Set(body.urls)) {
    if (isSafeRemoteUrl(url)) signed[url] = await signProxyUrl(c.env, url);
  }
  return c.json({ signed });
});

/** Reads at most `max` bytes; returns null when the body is larger. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.byteLength;
  }
  return out;
}

proxy.get('/image', async (c) => {
  const u = c.req.query('u');
  if (!(await verifyProxySig(c.env, u, c.req.query('s')))) throw new HttpError(403, 'INVALID_SIGNATURE', 'Invalid signature');
  let url = u!;
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isSafeRemoteUrl(url)) throw new HttpError(400, 'BLOCKED_URL', 'That URL cannot be proxied');
    // A fresh request: no cookies, auth or client headers are forwarded.
    res = await fetch(url, { redirect: 'manual', headers: { accept: 'image/*', 'user-agent': 'CirrusMail-ImageProxy/0.1' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url).toString();
      res = null;
      continue;
    }
    break;
  }
  if (!res) throw new HttpError(502, 'TOO_MANY_REDIRECTS', 'Too many redirects');
  if (!res.ok) throw new HttpError(502, 'UPSTREAM_ERROR', `Upstream returned ${res.status}`);
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) throw new HttpError(415, 'NOT_AN_IMAGE', 'Upstream did not return an image');
  const len = Number(res.headers.get('content-length') ?? '0');
  if (len > PROXY_MAX_BYTES) throw new HttpError(413, 'TOO_LARGE', 'Image is larger than 5 MB');
  const data = await readCapped(res.body, PROXY_MAX_BYTES);
  if (!data) throw new HttpError(413, 'TOO_LARGE', 'Image is larger than 5 MB');
  return new Response(data, {
    headers: {
      'content-type': type,
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
});
