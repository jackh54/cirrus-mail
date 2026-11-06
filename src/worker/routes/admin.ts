import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { INVITE_TTL_MS, type AdminInviteResponse, type AdminMailbox, type AdminStats, type AdminUser, type Alias, type Domain, type DomainCheck } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { domainOf } from '../lib/addresses';
import { sendInviteEmail } from '../invite-email';
import { hashPassword, randomBytes, sha256Hex, toBase64Url } from '../lib/crypto';
import { rowToUser, SYSTEM_FOLDERS, type UserRow } from '../lib/db';
import { HttpError, notFound } from '../lib/errors';
import { hit } from '../lib/ratelimit';
import { jsonBody, zDomainName, zEmail, zHeaderText, zId, zLocalPart, zName, zPassword } from '../lib/validate';
import { requireAdmin, requireAuth } from '../middleware/session';
import type { AppEnv } from '../types';

export const admin = new Hono<AppEnv>();
admin.use('*', requireAuth, requireAdmin);

const DAY = 24 * 3600 * 1000;

// ---------- users ----------

type AdminUserRow = UserRow & { mailbox_count: number; invite_sent_at: number | null; invite_expires_at: number | null; invite_user: string | null };

const ADMIN_USER_SELECT = `SELECT u.*, (SELECT COUNT(*) FROM mailbox_members mm WHERE mm.user_id = u.id) AS mailbox_count,
  i.user_id AS invite_user, i.sent_at AS invite_sent_at, i.expires_at AS invite_expires_at
  FROM users u LEFT JOIN invites i ON i.user_id = u.id`;

function toAdminUser(r: AdminUserRow): AdminUser {
  return {
    ...rowToUser(r), disabled: !!r.disabled, mailboxCount: r.mailbox_count,
    invite: r.invite_user ? { sentAt: r.invite_sent_at, expiresAt: r.invite_expires_at! } : null,
  };
}

async function adminUser(db: D1Database, id: string): Promise<AdminUser> {
  const r = await db.prepare(`${ADMIN_USER_SELECT} WHERE u.id = ?`).bind(id).first<AdminUserRow>();
  if (!r) throw notFound('User not found');
  return toAdminUser(r);
}

admin.get('/users', async (c) => {
  const { results } = await c.env.DB.prepare(`${ADMIN_USER_SELECT} ORDER BY u.name`).all<AdminUserRow>();
  return c.json(results.map(toAdminUser));
});

/** Statements that create a mailbox, its system folders and memberships. */
function createMailboxStmts(db: D1Database, m: { id: string; domainId: string; localPart: string; address: string; displayName: string; members: { userId: string; role: 'owner' | 'member' }[] }, now: number) {
  return [
    db.prepare('INSERT INTO mailboxes (id, domain_id, local_part, address, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(m.id, m.domainId, m.localPart, m.address, m.displayName, now),
    ...SYSTEM_FOLDERS.map((f, i) => db.prepare('INSERT INTO folders (id, mailbox_id, name, role, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(ulid(now), m.id, f.name, f.role, i, now)),
    ...m.members.map((mem) => db.prepare('INSERT INTO mailbox_members (mailbox_id, user_id, role) VALUES (?, ?, ?)').bind(m.id, mem.userId, mem.role)),
  ];
}

async function resolveNewAddress(db: D1Database, localPart: string, domainId: string): Promise<string> {
  const domain = await db.prepare('SELECT name FROM domains WHERE id = ?').bind(domainId).first<string>('name');
  if (!domain) throw new HttpError(400, 'INVALID_DOMAIN', 'Unknown domain');
  const address = `${localPart}@${domain}`.toLowerCase();
  const taken = await db.prepare('SELECT 1 FROM mailboxes WHERE address = ?1 UNION ALL SELECT 1 FROM aliases WHERE address = ?1').bind(address).first();
  if (taken) throw new HttpError(409, 'ADDRESS_TAKEN', 'That address is already in use');
  return address;
}

const CreateUserSchema = z.object({
  name: zName, email: zEmail, role: z.enum(['admin', 'member']), tempPassword: zPassword,
  mailbox: z.object({ localPart: zLocalPart, domainId: zId }).optional(),
});

admin.post('/users', async (c) => {
  const b = await jsonBody(c, CreateUserSchema);
  const db = c.env.DB;
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(b.email).first()) throw new HttpError(409, 'EMAIL_TAKEN', 'A user with that email already exists');
  const now = Date.now();
  const id = ulid(now);
  const stmts = [db.prepare(
    `INSERT INTO users (id, email, name, password_hash, role, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).bind(id, b.email, b.name, await hashPassword(b.tempPassword), b.role, now, now)];
  if (b.mailbox) {
    const address = await resolveNewAddress(db, b.mailbox.localPart, b.mailbox.domainId);
    stmts.push(...createMailboxStmts(db, { id: ulid(now), domainId: b.mailbox.domainId, localPart: b.mailbox.localPart, address, displayName: b.name, members: [{ userId: id, role: 'owner' }] }, now));
  }
  await db.batch(stmts);
  return c.json(await adminUser(db, id), 201);
});

// ---------- invites ----------

const INVITE_SEND_WINDOW_MS = 3600 * 1000;
const INVITE_SENDS_PER_ADMIN = 50;

const InviteSchema = z.object({
  name: zName, email: zEmail, role: z.enum(['admin', 'member']),
  mailbox: z.object({ localPart: zLocalPart, domainId: zId }).optional(),
  send: z.boolean().optional(),
});

/** Counts an invite send against the admin's hourly cap, so a stolen admin session cannot spam people. */
async function inviteSendBudget(c: Context<AppEnv>) {
  if ((await hit(c.env.DB, `invite-send:${c.get('user').id}`, INVITE_SEND_WINDOW_MS)) > INVITE_SENDS_PER_ADMIN) {
    throw new HttpError(429, 'RATE_LIMITED', 'Too many invites sent. Try again later.');
  }
}

/** Emails the invite (unless told not to) and records sent_at on success. */
async function deliverInvite(c: Context<AppEnv>, o: { userId: string; name: string; email: string; mailboxAddress: string | null; token: string; expiresAt: number; send: boolean }): Promise<AdminInviteResponse> {
  const db = c.env.DB;
  const inviteUrl = `${new URL(c.req.url).origin}/invite#${o.token}`;
  const email = await sendInviteEmail(c.env, {
    adminId: c.get('user').id, adminName: c.get('user').name, to: o.email, name: o.name,
    mailboxAddress: o.mailboxAddress, url: inviteUrl, expiresAt: o.expiresAt, send: o.send,
  });
  if (email.sent) await db.prepare('UPDATE invites SET sent_at = ? WHERE user_id = ?').bind(Date.now(), o.userId).run();
  return { user: await adminUser(db, o.userId), inviteUrl, email };
}

admin.post('/users/invite', async (c) => {
  const b = await jsonBody(c, InviteSchema);
  const db = c.env.DB;
  await inviteSendBudget(c);
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(b.email).first()) throw new HttpError(409, 'EMAIL_TAKEN', 'A user with that email already exists');
  const now = Date.now();
  const id = ulid(now);
  const token = toBase64Url(randomBytes(32));
  const expiresAt = now + INVITE_TTL_MS;
  // The password is random and never shown: the person sets their own through the invite link.
  const stmts = [db.prepare(
    `INSERT INTO users (id, email, name, password_hash, role, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  ).bind(id, b.email, b.name, await hashPassword(toBase64Url(randomBytes(32))), b.role, now, now)];
  let mailboxAddress: string | null = null;
  if (b.mailbox) {
    mailboxAddress = await resolveNewAddress(db, b.mailbox.localPart, b.mailbox.domainId);
    stmts.push(...createMailboxStmts(db, { id: ulid(now), domainId: b.mailbox.domainId, localPart: b.mailbox.localPart, address: mailboxAddress, displayName: b.name, members: [{ userId: id, role: 'owner' }] }, now));
  }
  stmts.push(db.prepare('INSERT INTO invites (user_id, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, await sha256Hex(token), c.get('user').id, now, expiresAt));
  await db.batch(stmts);
  return c.json(await deliverInvite(c, { userId: id, name: b.name, email: b.email, mailboxAddress, token, expiresAt, send: b.send !== false }), 201);
});

admin.post('/users/:id/invite', async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const b = z.object({ send: z.boolean().optional() }).parse(raw ?? {});
  const db = c.env.DB;
  const id = c.req.param('id');
  const target = await db.prepare('SELECT id, name, email, disabled FROM users WHERE id = ?').bind(id).first<{ id: string; name: string; email: string; disabled: number }>();
  if (!target) throw notFound('User not found');
  if (target.disabled) throw new HttpError(400, 'USER_DISABLED', 'Enable this user before resending their invite');
  if (!(await db.prepare('SELECT 1 FROM invites WHERE user_id = ?').bind(id).first())) throw new HttpError(400, 'ALREADY_ACTIVE', 'This user has already accepted their invite');
  await inviteSendBudget(c);
  const now = Date.now();
  const token = toBase64Url(randomBytes(32));
  const expiresAt = now + INVITE_TTL_MS;
  await db.prepare('UPDATE invites SET token_hash = ?, created_at = ?, expires_at = ?, sent_at = NULL WHERE user_id = ?')
    .bind(await sha256Hex(token), now, expiresAt, id).run();
  const mailboxAddress = await db.prepare(
    'SELECT m.address FROM mailbox_members mm JOIN mailboxes m ON m.id = mm.mailbox_id WHERE mm.user_id = ? ORDER BY m.address LIMIT 1',
  ).bind(id).first<string>('address');
  return c.json(await deliverInvite(c, { userId: id, name: target.name, email: target.email, mailboxAddress, token, expiresAt, send: b.send !== false }));
});

/** Number of enabled admins other than `exceptId`. */
async function otherAdmins(db: D1Database, exceptId: string): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?").bind(exceptId).first<number>('n')) ?? 0;
}

const UpdateUserSchema = z.object({
  name: zName.optional(), role: z.enum(['admin', 'member']).optional(), disabled: z.boolean().optional(), resetPassword: zPassword.optional(),
});

admin.patch('/users/:id', async (c) => {
  const b = await jsonBody(c, UpdateUserSchema);
  const db = c.env.DB;
  const id = c.req.param('id');
  const me = c.get('user');
  const target = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
  if (!target) throw notFound('User not found');
  if (id === me.id && b.role === 'member') throw new HttpError(400, 'CANNOT_DEMOTE_SELF', 'You cannot remove your own admin role');
  if (id === me.id && b.disabled) throw new HttpError(400, 'CANNOT_DISABLE_SELF', 'You cannot disable your own account');
  const losesAdmin = target.role === 'admin' && !target.disabled && (b.role === 'member' || b.disabled === true);
  if (losesAdmin && (await otherAdmins(db, id)) === 0) throw new HttpError(400, 'LAST_ADMIN', 'At least one active admin is required');
  const now = Date.now();
  const stmts = [db.prepare('UPDATE users SET name = ?, role = ?, disabled = ?, updated_at = ? WHERE id = ?')
    .bind(b.name ?? target.name, b.role ?? target.role, b.disabled === undefined ? target.disabled : b.disabled ? 1 : 0, now, id)];
  if (b.resetPassword) {
    stmts.push(db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').bind(await hashPassword(b.resetPassword), id));
    stmts.push(db.prepare('DELETE FROM invites WHERE user_id = ?').bind(id)); // the admin chose a password instead
  }
  if (b.resetPassword || b.disabled) stmts.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
  await db.batch(stmts);
  return c.json(await adminUser(db, id));
});

admin.delete('/users/:id', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  if (id === c.get('user').id) throw new HttpError(400, 'CANNOT_DELETE_SELF', 'You cannot delete your own account');
  const target = await db.prepare('SELECT role, disabled FROM users WHERE id = ?').bind(id).first<{ role: string; disabled: number }>();
  if (!target) throw notFound('User not found');
  if (target.role === 'admin' && !target.disabled && (await otherAdmins(db, id)) === 0) throw new HttpError(400, 'LAST_ADMIN', 'At least one active admin is required');
  await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

// ---------- domains ----------

const DOMAIN_SELECT = 'SELECT d.id, d.name, d.catch_all_mailbox_id AS catchAllMailboxId, d.created_at AS createdAt, (SELECT COUNT(*) FROM mailboxes m WHERE m.domain_id = d.id) AS mailboxCount FROM domains d';

async function getDomain(db: D1Database, id: string): Promise<Domain> {
  const d = await db.prepare(`${DOMAIN_SELECT} WHERE d.id = ?`).bind(id).first<Domain>();
  if (!d) throw notFound('Domain not found');
  return d;
}

async function checkCatchAll(db: D1Database, mailboxId: string | null | undefined) {
  if (mailboxId && !(await db.prepare('SELECT 1 FROM mailboxes WHERE id = ?').bind(mailboxId).first())) throw new HttpError(400, 'INVALID_MAILBOX', 'Unknown catch-all mailbox');
}

admin.get('/domains', async (c) => c.json((await c.env.DB.prepare(`${DOMAIN_SELECT} ORDER BY d.name`).all<Domain>()).results));

admin.post('/domains', async (c) => {
  const b = await jsonBody(c, z.object({ name: zDomainName, catchAllMailboxId: zId.nullable().optional() }));
  await checkCatchAll(c.env.DB, b.catchAllMailboxId);
  const id = ulid();
  try {
    await c.env.DB.prepare('INSERT INTO domains (id, name, catch_all_mailbox_id, created_at) VALUES (?, ?, ?, ?)').bind(id, b.name, b.catchAllMailboxId ?? null, Date.now()).run();
  } catch {
    throw new HttpError(409, 'DOMAIN_EXISTS', 'That domain already exists');
  }
  return c.json(await getDomain(c.env.DB, id), 201);
});

admin.patch('/domains/:id', async (c) => {
  const b = await jsonBody(c, z.object({ catchAllMailboxId: zId.nullable() }));
  const d = await getDomain(c.env.DB, c.req.param('id'));
  await checkCatchAll(c.env.DB, b.catchAllMailboxId);
  await c.env.DB.prepare('UPDATE domains SET catch_all_mailbox_id = ? WHERE id = ?').bind(b.catchAllMailboxId, d.id).run();
  return c.json(await getDomain(c.env.DB, d.id));
});

admin.delete('/domains/:id', async (c) => {
  const d = await getDomain(c.env.DB, c.req.param('id'));
  if (d.mailboxCount > 0) throw new HttpError(409, 'DOMAIN_IN_USE', 'Delete the mailboxes on this domain first');
  const aliases = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM aliases WHERE address LIKE ? ESCAPE '\\'").bind(`%@${d.name.replace(/[\\%_]/g, (x) => '\\' + x)}`).first<number>('n');
  if (aliases) throw new HttpError(409, 'DOMAIN_IN_USE', 'Delete the aliases on this domain first');
  await c.env.DB.prepare('DELETE FROM domains WHERE id = ?').bind(d.id).run();
  return c.json({ ok: true });
});

async function doh(name: string, type: 'MX' | 'TXT'): Promise<string[]> {
  const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' } });
  if (!res.ok) return [];
  const json = (await res.json()) as { Answer?: { type: number; data: string }[] };
  const want = type === 'MX' ? 15 : 16;
  return (json.Answer ?? []).filter((a) => a.type === want).map((a) =>
    type === 'TXT' ? a.data.replace(/^"|"$/g, '').replace(/"\s*"/g, '') : a.data.trim());
}

export function evaluateDns(domain: string, mx: string[], txt: string[], dmarcTxt: string[]): DomainCheck {
  const mxHosts = mx.map((r) => r.split(/\s+/).pop()!.replace(/\.$/, '').toLowerCase());
  const mxOk = mxHosts.length > 0 && mxHosts.every((h) => /^route[1-3]\.mx\.cloudflare\.net$/.test(h));
  const spf = txt.find((t) => /^v=spf1\b/i.test(t)) ?? null;
  const dmarc = dmarcTxt.find((t) => /^v=DMARC1\b/i.test(t)) ?? null;
  return {
    domain,
    mx: { ok: mxOk, records: mx },
    spf: { ok: !!spf && /\binclude:_spf\.mx\.cloudflare\.net\b/i.test(spf), record: spf },
    dmarc: { ok: !!dmarc, record: dmarc },
    dkim: { ok: null, note: 'Cloudflare signs outgoing mail with DKIM automatically once the domain is onboarded to Email Service; the selector is not public, so it cannot be checked here.' },
  };
}

admin.get('/domains/:id/check', async (c) => {
  const d = await getDomain(c.env.DB, c.req.param('id'));
  const [mx, txt, dmarc] = await Promise.all([doh(d.name, 'MX'), doh(d.name, 'TXT'), doh(`_dmarc.${d.name}`, 'TXT')]);
  return c.json(evaluateDns(d.name, mx, txt, dmarc));
});

// ---------- mailboxes ----------

async function adminMailboxes(db: D1Database, id?: string): Promise<AdminMailbox[]> {
  const where = id ? 'WHERE m.id = ?' : '';
  const [boxes, members] = await db.batch([
    db.prepare(`SELECT m.id, m.address, m.display_name, m.domain_id, m.created_at, (SELECT COUNT(*) FROM messages x WHERE x.mailbox_id = m.id) AS message_count
                  FROM mailboxes m ${where} ORDER BY m.address`).bind(...(id ? [id] : [])),
    db.prepare(`SELECT mm.mailbox_id, mm.user_id, mm.role, u.name, u.email FROM mailbox_members mm JOIN users u ON u.id = mm.user_id
                  ${id ? 'WHERE mm.mailbox_id = ?' : ''} ORDER BY mm.role DESC, u.name`).bind(...(id ? [id] : [])),
  ]);
  const byBox = new Map<string, AdminMailbox['members']>();
  for (const m of members.results as { mailbox_id: string; user_id: string; role: 'owner' | 'member'; name: string; email: string }[]) {
    byBox.set(m.mailbox_id, [...(byBox.get(m.mailbox_id) ?? []), { userId: m.user_id, name: m.name, email: m.email, role: m.role }]);
  }
  return (boxes.results as { id: string; address: string; display_name: string; domain_id: string; created_at: number; message_count: number }[]).map((b) => ({
    id: b.id, address: b.address, displayName: b.display_name, domainId: b.domain_id, members: byBox.get(b.id) ?? [],
    messageCount: b.message_count, createdAt: b.created_at,
  }));
}

const MembersSchema = z.array(z.object({ userId: zId, role: z.enum(['owner', 'member']) })).max(100);

async function checkMembers(db: D1Database, members: z.infer<typeof MembersSchema>) {
  const ids = [...new Set(members.map((m) => m.userId))];
  if (ids.length !== members.length) throw new HttpError(400, 'DUPLICATE_MEMBER', 'Each user can only be listed once');
  if (!ids.length) return;
  const n = await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).first<number>('n');
  if (n !== ids.length) throw new HttpError(400, 'INVALID_MEMBER', 'Unknown user in members');
}

admin.get('/mailboxes', async (c) => c.json(await adminMailboxes(c.env.DB)));

admin.post('/mailboxes', async (c) => {
  const b = await jsonBody(c, z.object({ localPart: zLocalPart, domainId: zId, displayName: zHeaderText(120), members: MembersSchema }));
  const db = c.env.DB;
  await checkMembers(db, b.members);
  const address = await resolveNewAddress(db, b.localPart, b.domainId);
  const now = Date.now();
  const id = ulid(now);
  await db.batch(createMailboxStmts(db, { id, domainId: b.domainId, localPart: b.localPart, address, displayName: b.displayName, members: b.members }, now));
  return c.json((await adminMailboxes(db, id))[0], 201);
});

admin.patch('/mailboxes/:id', async (c) => {
  const b = await jsonBody(c, z.object({ displayName: zHeaderText(120).optional(), members: MembersSchema.optional() }));
  const db = c.env.DB;
  const id = c.req.param('id');
  const [box] = await adminMailboxes(db, id);
  if (!box) throw notFound('Mailbox not found');
  const stmts = [db.prepare('UPDATE mailboxes SET display_name = ? WHERE id = ?').bind(b.displayName ?? box.displayName, id)];
  if (b.members) {
    await checkMembers(db, b.members);
    stmts.push(db.prepare('DELETE FROM mailbox_members WHERE mailbox_id = ?').bind(id));
    stmts.push(...b.members.map((m) => db.prepare('INSERT INTO mailbox_members (mailbox_id, user_id, role) VALUES (?, ?, ?)').bind(id, m.userId, m.role)));
  }
  await db.batch(stmts);
  return c.json((await adminMailboxes(db, id))[0]);
});

async function deletePrefix(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const list = await bucket.list({ prefix, cursor, limit: 1000 });
    if (list.objects.length) await bucket.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

admin.delete('/mailboxes/:id', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  if (!(await db.prepare('SELECT 1 FROM mailboxes WHERE id = ?').bind(id).first())) throw notFound('Mailbox not found');
  await db.batch([
    db.prepare('DELETE FROM messages_fts WHERE mailbox_id = ?').bind(id),
    db.prepare('UPDATE domains SET catch_all_mailbox_id = NULL WHERE catch_all_mailbox_id = ?').bind(id),
    db.prepare('DELETE FROM attachments WHERE mailbox_id = ?').bind(id),
    db.prepare('DELETE FROM messages WHERE mailbox_id = ?').bind(id),
    db.prepare('DELETE FROM mailboxes WHERE id = ?').bind(id),
  ]);
  for (const p of ['raw', 'body', 'att']) await deletePrefix(c.env.BUCKET, `${p}/${id}/`);
  return c.json({ ok: true });
});

// ---------- aliases ----------

const ALIAS_SELECT = 'SELECT a.id, a.address, a.mailbox_id AS mailboxId, m.address AS mailboxAddress, a.can_send AS canSend, a.created_at AS createdAt FROM aliases a JOIN mailboxes m ON m.id = a.mailbox_id';
const toAlias = (a: Alias) => ({ ...a, canSend: !!a.canSend });

admin.get('/aliases', async (c) => c.json((await c.env.DB.prepare(`${ALIAS_SELECT} ORDER BY a.address`).all<Alias>()).results.map(toAlias)));

admin.post('/aliases', async (c) => {
  const b = await jsonBody(c, z.object({ address: zEmail, mailboxId: zId, canSend: z.boolean().optional() }));
  const db = c.env.DB;
  if (!(await db.prepare('SELECT 1 FROM domains WHERE name = ?').bind(domainOf(b.address)).first())) throw new HttpError(400, 'INVALID_DOMAIN', 'The alias must be on one of your domains');
  if (!(await db.prepare('SELECT 1 FROM mailboxes WHERE id = ?').bind(b.mailboxId).first())) throw new HttpError(400, 'INVALID_MAILBOX', 'Unknown mailbox');
  const taken = await db.prepare('SELECT 1 FROM mailboxes WHERE address = ?1 UNION ALL SELECT 1 FROM aliases WHERE address = ?1').bind(b.address).first();
  if (taken) throw new HttpError(409, 'ADDRESS_TAKEN', 'That address is already in use');
  const id = ulid();
  await db.prepare('INSERT INTO aliases (id, address, mailbox_id, can_send, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, b.address, b.mailboxId, b.canSend === false ? 0 : 1, Date.now()).run();
  const a = await db.prepare(`${ALIAS_SELECT} WHERE a.id = ?`).bind(id).first<Alias>();
  return c.json(toAlias(a!), 201);
});

admin.delete('/aliases/:id', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM aliases WHERE id = ?').bind(c.req.param('id')).run();
  if (!res.meta.changes) throw notFound('Alias not found');
  return c.json({ ok: true });
});

// ---------- stats ----------

admin.get('/stats', async (c) => {
  const db = c.env.DB;
  const now = Date.now();
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const d30 = now - 30 * DAY;
  const d14 = today.getTime() - 13 * DAY;
  const one = (sql: string, ...p: unknown[]) => db.prepare(sql).bind(...p);
  const r = await db.batch([
    one('SELECT COUNT(*) AS n FROM users'),
    one('SELECT COUNT(*) AS n FROM mailboxes'),
    one('SELECT COUNT(*) AS n FROM domains'),
    one('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM messages'),
    one('SELECT COUNT(*) AS n FROM send_log WHERE ok = 1 AND created_at >= ?', today.getTime()),
    one('SELECT COUNT(*) AS n FROM send_log WHERE ok = 1 AND created_at >= ?', d30),
    one('SELECT COUNT(*) AS n FROM receive_log WHERE accepted = 1 AND created_at >= ?', d30),
    one('SELECT COUNT(*) AS n FROM receive_log WHERE accepted = 0 AND created_at >= ?', d30),
    one('SELECT COUNT(*) AS n FROM send_log WHERE ok = 0 AND created_at >= ?', d30),
    one("SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM send_log WHERE ok = 1 AND created_at >= ? GROUP BY day", d14),
    one("SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM receive_log WHERE accepted = 1 AND created_at >= ? GROUP BY day", d14),
  ]);
  const n = (i: number) => (r[i].results[0] as { n: number }).n;
  const sentBy = new Map((r[9].results as { day: string; n: number }[]).map((x) => [x.day, x.n]));
  const recvBy = new Map((r[10].results as { day: string; n: number }[]).map((x) => [x.day, x.n]));
  const daily = Array.from({ length: 14 }, (_, i) => {
    const day = new Date(d14 + i * DAY).toISOString().slice(0, 10);
    return { day, sent: sentBy.get(day) ?? 0, received: recvBy.get(day) ?? 0 };
  });
  const stats: AdminStats = {
    users: n(0), mailboxes: n(1), domains: n(2), messages: n(3), storageBytes: (r[3].results[0] as { bytes: number }).bytes,
    sentToday: n(4), sent30d: n(5), received30d: n(6), rejected30d: n(7), sendErrors30d: n(8), daily,
  };
  return c.json(stats);
});
