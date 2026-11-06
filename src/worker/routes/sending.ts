// GET /api/sending: today's outbound count against the admin-set daily limit (any signed-in user).
import { Hono } from 'hono';
import { sendingStatus } from '../lib/sendcount';
import { requireAuth } from '../middleware/session';
import type { AppEnv } from '../types';

export const sending = new Hono<AppEnv>();
sending.use('*', requireAuth);

sending.get('/', async (c) => c.json(await sendingStatus(c.env.DB, Date.now())));
