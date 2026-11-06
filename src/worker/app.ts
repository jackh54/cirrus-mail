import { Hono } from 'hono';
import { errorBody, onError } from './lib/errors';
import { meters } from './lib/timing';
import { csrf, requireMailbox } from './middleware/session';
import { admin } from './routes/admin';
import { appPasswords } from './routes/app-passwords';
import { aiAdmin, aiMailbox, aiPublic } from './routes/ai';
import { auth } from './routes/auth';
import { blocked } from './routes/blocked';
import { contacts } from './routes/contacts';
import { davApi } from './routes/dav-api';
import { drafts } from './routes/drafts';
import { files } from './routes/files';
import { filters } from './routes/filters';
import { mail, mailReads } from './routes/mail';
import { mbox } from './routes/mbox';
import { mailboxSettings } from './routes/mailbox-settings';
import { invites } from './routes/invites';
import { labels, labelReads } from './routes/labels';
import { me } from './routes/me';
import { pgp } from './routes/pgp';
import { passkeyAuth } from './routes/passkey-auth';
import { passkeys } from './routes/passkeys';
import { proxy } from './routes/proxy';
import { push } from './routes/push';
import { sending } from './routes/sending';
import { setup } from './routes/setup';
import { templates } from './routes/templates';
import { unsubscribe } from './routes/unsubscribe';
import type { AppEnv } from './types';

const mailbox = new Hono<AppEnv>();
// Hot reads authorize themselves (authorizeMailbox): the session + membership check rides in the same D1 batch
// as their queries. They are registered before the guard and never call next(), so the guard does not repeat it.
mailbox.route('/', mailReads);
mailbox.route('/', labelReads);
mailbox.use('*', requireMailbox);
mailbox.route('/', mail);
mailbox.route('/', drafts);
mailbox.route('/', mailboxSettings);
mailbox.route('/', filters);
mailbox.route('/', labels);
mailbox.route('/', blocked);
mailbox.route('/', templates);
mailbox.route('/', unsubscribe);
mailbox.route('/', aiMailbox);
mailbox.route('/', mbox);

export const app = new Hono<AppEnv>().basePath('/api');

app.use('*', async (c, next) => {
  await next();
  if (!c.res.headers.has('cache-control')) c.res.headers.set('cache-control', 'no-store');
  c.res.headers.set('x-content-type-options', 'nosniff');
  c.res.headers.set('referrer-policy', 'no-referrer');
  // Server-Timing only on successful responses to signed-in users: on a 401/404 the D1 time could hint at
  // data the caller cannot see.
  const meter = meters.get(c.req.raw);
  if (meter && c.res.ok && c.get('user')) c.res.headers.set('server-timing', meter.header());
});
app.use('*', csrf);

app.route('/setup', setup);
app.route('/auth', auth);
app.route('/auth/passkey', passkeyAuth);
app.route('/invites', invites);
app.route('/me/passkeys', passkeys);
app.route('/me', me);
app.route('/contacts', contacts);
app.route('/app-passwords', appPasswords);
app.route('/dav', davApi);
app.route('/files', files);
app.route('/pgp', pgp);
app.route('/proxy', proxy);
app.route('/push', push);
app.route('/sending', sending);
app.route('/ai', aiPublic);
app.route('/admin/ai', aiAdmin);
app.route('/admin', admin);
app.route('/mailboxes/:mb', mailbox);

app.notFound((c) => c.json(errorBody('NOT_FOUND', 'No such API route'), 404));
app.onError(onError);
