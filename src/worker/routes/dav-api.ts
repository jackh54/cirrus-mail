// JSON view of the user's address books and calendars for the web app. Same store as the DAV server.
import { Hono } from 'hono';
import { z } from 'zod';
import type { ContactView, DavCollectionInfo, EventView, InvitePreview, Page } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { acceptedInvite, applyEvent, buildEvent, eventFields, IcsError, inviteFields } from '../dav/ical';
import {
  createCollection, DavError, deleteObject, ensureDefaults, getCollectionById, getObjectById, listCollections, putObject, queryObjects, updateCollection,
  type CollectionRow, type Kind, type ObjectRow,
} from '../dav/store';
import { applyContact, buildContact, contactFields, VcfError } from '../dav/vcard';
import { HttpError, notFound } from '../lib/errors';
import { jsonBody, zHeaderText } from '../lib/validate';
import { requireAuth } from '../middleware/session';
import { likeEscape } from '../search';
import type { AppEnv } from '../types';

export const davApi = new Hono<AppEnv>();
davApi.use('*', requireAuth);

/** Maps store/parser failures to the API's error shape. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DavError) {
      if (e.status === 412) throw new HttpError(412, 'PRECONDITION_FAILED', 'Changed elsewhere. Reload and try again.');
      if (e.status === 404) throw notFound();
      if (e.status === 413) throw new HttpError(413, 'TOO_LARGE', 'Too large (256 KB maximum)');
      if (e.status === 507) throw new HttpError(409, 'LIMIT_REACHED', 'This collection is full');
      throw new HttpError(400, 'INVALID_DATA', 'The data was rejected');
    }
    if (e instanceof IcsError || e instanceof VcfError) throw new HttpError(400, 'INVALID_DATA', e.message);
    throw e;
  }
}

const info = (c: CollectionRow): DavCollectionInfo => ({
  id: c.id, kind: c.kind, name: c.displayname, color: c.color, components: c.components.split(',').filter(Boolean), ctag: String(c.rev),
});

davApi.get('/collections', async (c) => {
  const uid = c.get('user').id;
  await ensureDefaults(c.env.DB, uid);
  return c.json((await listCollections(c.env.DB, uid)).map(info));
});

const zColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use #RRGGBB');
const CollectionSchema = z.object({ kind: z.enum(['addressbook', 'calendar']), name: zHeaderText(100, 1), color: zColor.nullable().default(null) });
const CollectionPatch = z.object({ name: zHeaderText(100, 1).optional(), color: zColor.nullable().optional() });

davApi.post('/collections', async (c) => {
  const uid = c.get('user').id;
  const b = await jsonBody(c, CollectionSchema);
  await ensureDefaults(c.env.DB, uid);
  const coll = await guard(() => createCollection(c.env.DB, uid, b.kind, ulid().toLowerCase(), { displayname: b.name, color: b.color ?? undefined }));
  return c.json(info(coll), 201);
});

davApi.patch('/collections/:id', async (c) => {
  const uid = c.get('user').id;
  const coll = await getCollectionById(c.env.DB, uid, c.req.param('id'));
  if (!coll) throw notFound();
  const b = await jsonBody(c, CollectionPatch);
  await updateCollection(c.env.DB, coll, { displayname: b.name, color: b.color });
  return c.json(info((await getCollectionById(c.env.DB, uid, coll.id))!));
});

/** The requested collection of `kind`, or the user's first one. */
async function pick(c: { env: Env; get(k: 'user'): { id: string } }, kind: Kind, id: string | undefined): Promise<CollectionRow> {
  const uid = c.get('user').id;
  if (id) {
    const coll = await getCollectionById(c.env.DB, uid, id);
    if (!coll || coll.kind !== kind) throw notFound();
    return coll;
  }
  await ensureDefaults(c.env.DB, uid);
  return (await listCollections(c.env.DB, uid, kind))[0];
}

// ---------- contacts ----------

const zField = (max: number) => z.object({ value: z.string().trim().min(1).max(max), types: z.array(z.string().max(20)).max(5).default([]) });
const ContactSchema = z.object({
  fn: zHeaderText(200, 1),
  emails: z.array(zField(254)).max(50).default([]),
  phones: z.array(zField(64)).max(50).default([]),
  org: zHeaderText(200).default(''),
  note: z.string().max(10_000).default(''),
  addressBookId: z.string().max(64).optional(),
});

function contactView(o: ObjectRow): ContactView {
  return { id: o.id, addressBookId: o.collection_id, etag: o.etag, updatedAt: o.updated_at, ...contactFields(o.data ?? '') };
}

davApi.get('/contacts', async (c) => {
  const uid = c.get('user').id;
  await ensureDefaults(c.env.DB, uid);
  const q = (c.req.query('q') ?? '').trim().slice(0, 100);
  const book = c.req.query('book');
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 500, 1), 2000);
  const where = ["c.user_id = ?", "c.kind = 'addressbook'"];
  const params: unknown[] = [uid];
  if (book) { where.push('c.id = ?'); params.push(book); }
  if (q) { where.push("(lower(o.fn) LIKE ? ESCAPE '\\' OR o.emails LIKE ? ESCAPE '\\')"); params.push(likeEscape(q), likeEscape(q)); }
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.collection_id, o.etag, o.data, o.updated_at FROM dav_objects o JOIN dav_collections c ON c.id = o.collection_id
      WHERE ${where.join(' AND ')} ORDER BY o.fn COLLATE NOCASE, o.id LIMIT ?`,
  ).bind(...params, limit).all<ObjectRow>();
  const items: ContactView[] = [];
  for (const o of results) {
    try { items.push(contactView(o)); } catch { /* a card this parser cannot read stays reachable over DAV */ }
  }
  const page: Page<ContactView> = { items, nextCursor: null };
  return c.json(page);
});

async function loadContact(c: { env: Env; get(k: 'user'): { id: string } }, id: string) {
  const o = await getObjectById(c.env.DB, c.get('user').id, 'addressbook', id);
  if (!o) throw notFound();
  const coll = (await getCollectionById(c.env.DB, c.get('user').id, o.collection_id))!;
  return { o, coll };
}

davApi.get('/contacts/:id', async (c) => {
  const { o } = await loadContact(c, c.req.param('id'));
  return c.json(await guard(async () => contactView(o)));
});

davApi.post('/contacts', async (c) => {
  const { addressBookId, ...f } = await jsonBody(c, ContactSchema);
  const coll = await pick(c, 'addressbook', addressBookId);
  const uid = `urn:uuid:${crypto.randomUUID()}`;
  const r = await guard(() => putObject(c.env.DB, coll, `${ulid()}.vcf`, buildContact(f, uid), { ifNoneMatch: '*' }));
  const o = await getObjectById(c.env.DB, c.get('user').id, 'addressbook', r.id);
  return c.json(contactView(o!), 201);
});

davApi.put('/contacts/:id', async (c) => {
  const { o, coll } = await loadContact(c, c.req.param('id'));
  const { addressBookId: _ignored, ...f } = await jsonBody(c, ContactSchema);
  const r = await guard(() => putObject(c.env.DB, coll, o.uri, applyContact(o.data!, f), { ifMatch: c.req.header('if-match') }));
  const fresh = await getObjectById(c.env.DB, c.get('user').id, 'addressbook', r.id);
  return c.json(contactView(fresh!));
});

davApi.delete('/contacts/:id', async (c) => {
  const { o, coll } = await loadContact(c, c.req.param('id'));
  await guard(() => deleteObject(c.env.DB, coll, o.uri, { ifMatch: c.req.header('if-match') }));
  return c.json({ ok: true });
});

// ---------- events ----------

const RRULE_RE = /^FREQ=[A-Z]+(;[A-Z]+=[A-Za-z0-9,+:-]+)*$/;
const EventSchema = z.object({
  summary: zHeaderText(500),
  start: z.string().min(8).max(40),
  end: z.string().min(8).max(40).nullable().default(null),
  allDay: z.boolean(),
  location: zHeaderText(500).default(''),
  description: z.string().max(20_000).default(''),
  rrule: z.string().max(500).regex(RRULE_RE, 'Invalid RRULE').nullable().default(null),
  calendarId: z.string().max(64).optional(),
}).superRefine((v, ctx) => {
  const date = /^\d{4}-\d{2}-\d{2}$/;
  const ok = (s: string) => (v.allDay ? date.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) : Number.isFinite(Date.parse(s)));
  if (!ok(v.start)) ctx.addIssue({ code: 'custom', path: ['start'], message: v.allDay ? 'Use YYYY-MM-DD' : 'Use an ISO 8601 date and time' });
  if (v.end && !ok(v.end)) ctx.addIssue({ code: 'custom', path: ['end'], message: v.allDay ? 'Use YYYY-MM-DD' : 'Use an ISO 8601 date and time' });
});

function eventView(o: ObjectRow): EventView {
  return { id: o.id, calendarId: o.collection_id, uid: o.uid, etag: o.etag, updatedAt: o.updated_at, ...eventFields(o.data ?? '') };
}

const isoToMs = (s: string | undefined) => {
  if (!s) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid date');
  return ms;
};

davApi.get('/events', async (c) => {
  const uid = c.get('user').id;
  const start = isoToMs(c.req.query('from')), end = isoToMs(c.req.query('to'));
  await ensureDefaults(c.env.DB, uid);
  const wanted = c.req.query('calendar');
  const cals = (await listCollections(c.env.DB, uid, 'calendar')).filter((x) => !wanted || x.id === wanted);
  const items: EventView[] = [];
  for (const cal of cals) {
    for (const o of await queryObjects(c.env.DB, cal.id, { component: 'VEVENT', start, end, withData: true, limit: 2000 })) {
      try { items.push(eventView(o)); } catch { /* unreadable resource: still served over CalDAV */ }
    }
  }
  const page: Page<EventView> = { items, nextCursor: null };
  return c.json(page);
});

async function loadEvent(c: { env: Env; get(k: 'user'): { id: string } }, id: string) {
  const o = await getObjectById(c.env.DB, c.get('user').id, 'calendar', id);
  if (!o || o.component !== 'VEVENT') throw notFound();
  const coll = (await getCollectionById(c.env.DB, c.get('user').id, o.collection_id))!;
  return { o, coll };
}

davApi.get('/events/:id', async (c) => {
  const { o } = await loadEvent(c, c.req.param('id'));
  return c.json(await guard(async () => eventView(o)));
});

davApi.post('/events', async (c) => {
  const { calendarId, ...f } = await jsonBody(c, EventSchema);
  const coll = await pick(c, 'calendar', calendarId);
  const uid = `${crypto.randomUUID()}@cirrus`;
  const r = await guard(async () => putObject(c.env.DB, coll, `${ulid()}.ics`, buildEvent(f, uid), { ifNoneMatch: '*' }));
  const o = await getObjectById(c.env.DB, c.get('user').id, 'calendar', r.id);
  return c.json(eventView(o!), 201);
});

davApi.put('/events/:id', async (c) => {
  const { o, coll } = await loadEvent(c, c.req.param('id'));
  const { calendarId: _ignored, ...f } = await jsonBody(c, EventSchema);
  const r = await guard(async () => putObject(c.env.DB, coll, o.uri, applyEvent(o.data!, f), { ifMatch: c.req.header('if-match') }));
  const fresh = await getObjectById(c.env.DB, c.get('user').id, 'calendar', r.id);
  return c.json(eventView(fresh!));
});

davApi.delete('/events/:id', async (c) => {
  const { o, coll } = await loadEvent(c, c.req.param('id'));
  await guard(() => deleteObject(c.env.DB, coll, o.uri, { ifMatch: c.req.header('if-match') }));
  return c.json({ ok: true });
});

// ---------- invitations (text/calendar parts of received mail) ----------

const InviteSchema = z.object({ ics: z.string().min(20).max(256 * 1024), calendarId: z.string().max(64).optional() });

/** The invitation's master event, and the copy of it (same UID) already in one of the user's calendars. */
async function readInvite(c: { env: Env; get(k: 'user'): { id: string } }, ics: string) {
  const inv = await guard(async () => {
    try {
      return inviteFields(ics);
    } catch (e) {
      throw e instanceof IcsError ? e : new IcsError('Malformed calendar data');
    }
  });
  if (!inv.uid || inv.uid.length > 255) throw new HttpError(400, 'INVALID_DATA', 'The invitation has no usable UID');
  const row = await c.env.DB.prepare(
    `SELECT o.id, o.collection_id FROM dav_objects o JOIN dav_collections c ON c.id = o.collection_id
      WHERE c.user_id = ? AND c.kind = 'calendar' AND o.uid = ? AND o.component = 'VEVENT' ORDER BY o.created_at LIMIT 1`,
  ).bind(c.get('user').id, inv.uid).first<{ id: string; collection_id: string }>();
  return { inv, row };
}

davApi.post('/invite/parse', async (c) => {
  const { ics } = await jsonBody(c, InviteSchema);
  const { inv, row } = await readInvite(c, ics);
  const out: InvitePreview = {
    method: inv.method, uid: inv.uid, sequence: inv.sequence, event: inv.event, organizer: inv.organizer, attendees: inv.attendees,
    existing: row ? { id: row.id, calendarId: row.collection_id } : null,
  };
  return c.json(out);
});

/** Adds the invitation's event to the chosen (default) calendar, or updates the copy that already carries its UID. */
davApi.post('/invite/accept', async (c) => {
  const { ics, calendarId } = await jsonBody(c, InviteSchema);
  const { inv, row } = await readInvite(c, ics);
  if (inv.method && inv.method !== 'REQUEST' && inv.method !== 'PUBLISH') throw new HttpError(400, 'INVALID_DATA', `A ${inv.method.toLowerCase()} message cannot be added to a calendar`);
  const parsed = EventSchema.safeParse({ ...inv.event, rrule: inv.event.rrule && RRULE_RE.test(inv.event.rrule) ? inv.event.rrule : null });
  if (!parsed.success) throw new HttpError(400, 'INVALID_DATA', 'The invitation has no usable date');
  const userId = c.get('user').id;
  const { results } = await c.env.DB.prepare(
    `SELECT m.address AS a FROM mailboxes m JOIN mailbox_members mm ON mm.mailbox_id = m.id WHERE mm.user_id = ?1
     UNION SELECT a.address FROM aliases a JOIN mailbox_members mm ON mm.mailbox_id = a.mailbox_id WHERE mm.user_id = ?1`,
  ).bind(userId).all<{ a: string }>();
  const self = [c.get('user').email, ...results.map((r) => r.a)].map((e) => e.toLowerCase());
  // The original event is stored (TZID, EXDATE, overrides and VTIMEZONE intact), with our own PARTSTAT.
  const stored = await guard(async () => acceptedInvite(ics, self, (r) => RRULE_RE.test(r)));
  if (row) {
    const { o, coll } = await loadEvent(c, row.id);
    // Only the organizer may update the event, and never with an older revision.
    const cur = await guard(async () => inviteFields(o.data!));
    if ((cur.organizer?.email ?? null) !== (inv.organizer?.email ?? null)) throw new HttpError(409, 'ORGANIZER_MISMATCH', 'This invitation is from a different organizer than the event already in your calendar, so it was not applied');
    if (inv.sequence < cur.sequence) throw new HttpError(409, 'OUTDATED_INVITATION', 'This invitation is older than the event already in your calendar, so it was not applied');
    const r = await guard(async () => putObject(c.env.DB, coll, o.uri, stored));
    return c.json(eventView((await getObjectById(c.env.DB, userId, 'calendar', r.id))!));
  }
  const coll = await pick(c, 'calendar', calendarId);
  const r = await guard(async () => putObject(c.env.DB, coll, `${ulid()}.ics`, stored, { ifNoneMatch: '*' }));
  return c.json(eventView((await getObjectById(c.env.DB, userId, 'calendar', r.id))!), 201);
});
