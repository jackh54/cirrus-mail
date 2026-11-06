import { Hono } from 'hono';
import { errorBody, onError } from './lib/errors';
import { csrf, requireMailbox } from './middleware/session';
import { admin } from './routes/admin';
import { auth } from './routes/auth';
import { blocked } from './routes/blocked';
import { contacts } from './routes/contacts';
import { drafts } from './routes/drafts';
import { files } from './routes/files';
import { filters } from './routes/filters';
import { mail, mailReads } from './routes/mail';
import { mailboxSettings } from './routes/mailbox-settings';
import { me } from './routes/me';
import { proxy } from './routes/proxy';
import { setup } from './routes/setup';
import type { AppEnv } from './types';

const mailbox = new Hono<AppEnv>();
// Hot reads authorize themselves (authorizeMailbox): the session + membership check rides in the same D1 batch
// as their queries. They are registered before the guard and never call next(), so the guard does not repeat it.
mailbox.route('/', mailReads);
mailbox.use('*', requireMailbox);
mailbox.route('/', mail);
mailbox.route('/', drafts);
mailbox.route('/', mailboxSettings);
mailbox.route('/', filters);
mailbox.route('/', blocked);

export const app = new Hono<AppEnv>().basePath('/api');

app.use('*', async (c, next) => {
  await next();
  if (!c.res.headers.has('cache-control')) c.res.headers.set('cache-control', 'no-store');
  c.res.headers.set('x-content-type-options', 'nosniff');
  c.res.headers.set('referrer-policy', 'no-referrer');
});
app.use('*', csrf);

app.route('/setup', setup);
app.route('/auth', auth);
app.route('/me', me);
app.route('/contacts', contacts);
app.route('/files', files);
app.route('/proxy', proxy);
app.route('/admin', admin);
app.route('/mailboxes/:mb', mailbox);

app.notFound((c) => c.json(errorBody('NOT_FOUND', 'No such API route'), 404));
app.onError(onError);
