// D1 access for DAV collections and objects. Shared by the DAV protocol handler and the JSON API.
import { ulid } from '../../shared/ulid';
import { sha256Hex } from '../lib/crypto';
import { APPROX_PAD_MS, analyzeIcs, IcsError } from './ical';
import { analyzeVcard, VcfError } from './vcard';

export const MAX_OBJECT_BYTES = 256 * 1024;
export const MAX_COLLECTIONS = 50;
export const MAX_OBJECTS = 10_000;
export const SLUG_RE = /^[A-Za-z0-9._~-]{1,64}$/;

/** A failed DAV request: HTTP status plus an optional RFC precondition element for the error body. */
export class DavError extends Error {
  constructor(public status: number, public precondition?: ['D' | 'C' | 'CR', string], public href?: string) {
    super(precondition?.[1] ?? String(status));
  }
}

export type Kind = 'addressbook' | 'calendar';

export interface CollectionRow {
  id: string; user_id: string; kind: Kind; slug: string; displayname: string; description: string | null; color: string | null;
  components: string; rev: number; pruned_rev: number; created_at: number; updated_at: number;
}

export interface ObjectRow {
  id: string; collection_id: string; uri: string; uid: string; etag: string; size: number; data?: string; component: string | null;
  dtstart: number | null; dtend: number | null; recurring: number; rec_until: number | null; approx: number;
  fn: string | null; emails: string | null; created_at: number; updated_at: number;
}

const OBJ_COLS = 'id, collection_id, uri, uid, etag, size, component, dtstart, dtend, recurring, rec_until, approx, fn, emails, created_at, updated_at';
const objCols = (withData: boolean) => (withData ? `${OBJ_COLS}, data` : OBJ_COLS);

const enc = new TextEncoder();

/** Creates the default address book and calendar when the user has none of that kind. */
export async function ensureDefaults(db: D1Database, userId: string): Promise<void> {
  const { results } = await db.prepare('SELECT DISTINCT kind FROM dav_collections WHERE user_id = ?').bind(userId).all<{ kind: Kind }>();
  const have = new Set(results.map((r) => r.kind));
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  const ins = 'INSERT OR IGNORE INTO dav_collections (id, user_id, kind, slug, displayname, components, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
  if (!have.has('addressbook')) stmts.push(db.prepare(ins).bind(ulid(now), userId, 'addressbook', 'contacts', 'Contacts', '', now, now));
  if (!have.has('calendar')) stmts.push(db.prepare(ins).bind(ulid(now), userId, 'calendar', 'calendar', 'Calendar', 'VEVENT,VTODO', now, now));
  if (stmts.length) await db.batch(stmts);
}

export async function listCollections(db: D1Database, userId: string, kind?: Kind): Promise<CollectionRow[]> {
  const { results } = kind
    ? await db.prepare('SELECT * FROM dav_collections WHERE user_id = ? AND kind = ? ORDER BY created_at, slug').bind(userId, kind).all<CollectionRow>()
    : await db.prepare('SELECT * FROM dav_collections WHERE user_id = ? ORDER BY kind, created_at, slug').bind(userId).all<CollectionRow>();
  return results;
}

export function getCollection(db: D1Database, userId: string, kind: Kind, slug: string): Promise<CollectionRow | null> {
  return db.prepare('SELECT * FROM dav_collections WHERE user_id = ? AND kind = ? AND slug = ?').bind(userId, kind, slug).first<CollectionRow>();
}

export function getCollectionById(db: D1Database, userId: string, id: string): Promise<CollectionRow | null> {
  return db.prepare('SELECT * FROM dav_collections WHERE user_id = ? AND id = ?').bind(userId, id).first<CollectionRow>();
}

export async function createCollection(
  db: D1Database, userId: string, kind: Kind, slug: string,
  p: { displayname?: string; description?: string; color?: string; components?: string },
): Promise<CollectionRow> {
  if (!SLUG_RE.test(slug)) throw new DavError(403);
  if (await getCollection(db, userId, kind, slug)) throw new DavError(405);
  const n = await db.prepare('SELECT COUNT(*) AS n FROM dav_collections WHERE user_id = ?').bind(userId).first<number>('n');
  if ((n ?? 0) >= MAX_COLLECTIONS) throw new DavError(403);
  const now = Date.now();
  const id = ulid(now);
  await db.prepare('INSERT INTO dav_collections (id, user_id, kind, slug, displayname, description, color, components, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, userId, kind, slug, p.displayname || slug, p.description ?? null, p.color ?? null, kind === 'calendar' ? p.components || 'VEVENT,VTODO' : '', now, now).run();
  return (await getCollectionById(db, userId, id))!;
}

export async function updateCollection(db: D1Database, coll: CollectionRow, p: { displayname?: string; description?: string | null; color?: string | null }): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (p.displayname !== undefined) { sets.push('displayname = ?'); vals.push(p.displayname || coll.slug); }
  if (p.description !== undefined) { sets.push('description = ?'); vals.push(p.description); }
  if (p.color !== undefined) { sets.push('color = ?'); vals.push(p.color); }
  if (!sets.length) return;
  await db.prepare(`UPDATE dav_collections SET ${sets.join(', ')}, rev = rev + 1, updated_at = ? WHERE id = ?`).bind(...vals, Date.now(), coll.id).run();
}

export async function deleteCollection(db: D1Database, coll: CollectionRow): Promise<void> {
  await db.prepare('DELETE FROM dav_collections WHERE id = ?').bind(coll.id).run();
}

export function getObject(db: D1Database, collId: string, uri: string, withData = true): Promise<ObjectRow | null> {
  return db.prepare(`SELECT ${objCols(withData)} FROM dav_objects WHERE collection_id = ? AND uri = ?`).bind(collId, uri).first<ObjectRow>();
}

/** An object by its id, only if it lives in one of the user's collections of `kind`. */
export function getObjectById(db: D1Database, userId: string, kind: Kind, id: string): Promise<(ObjectRow & { slug: string }) | null> {
  return db.prepare(
    `SELECT o.*, c.slug FROM dav_objects o JOIN dav_collections c ON c.id = o.collection_id WHERE o.id = ? AND c.user_id = ? AND c.kind = ?`,
  ).bind(id, userId, kind).first<ObjectRow & { slug: string }>();
}

export interface Query { component?: string | null; start?: number | null; end?: number | null; withData?: boolean; uris?: string[]; limit?: number }

/** Objects of a collection, optionally filtered by component and time range. Recurring and undated objects err on the side of inclusion. */
export async function queryObjects(db: D1Database, collId: string, q: Query = {}): Promise<ObjectRow[]> {
  const where = ['collection_id = ?'];
  const params: unknown[] = [collId];
  const pad = `approx * ${APPROX_PAD_MS}`;
  if (q.component) { where.push('component = ?'); params.push(q.component); }
  if (q.end != null) { where.push(`(dtstart IS NULL OR dtstart - ${pad} < ?)`); params.push(q.end); }
  if (q.start != null) {
    where.push(
      `(dtstart IS NULL OR (recurring = 0 AND (dtend + ${pad} > ? OR (dtstart = dtend AND dtstart + ${pad} >= ?)))` +
      ` OR (recurring = 1 AND (rec_until IS NULL OR rec_until + ${pad} > ?)))`,
    );
    params.push(q.start, q.start, q.start);
  }
  if (q.uris) {
    where.push(`uri IN (${q.uris.map(() => '?').join(',')})`);
    params.push(...q.uris);
  }
  const { results } = await db.prepare(`SELECT ${objCols(!!q.withData)} FROM dav_objects WHERE ${where.join(' AND ')} ORDER BY uri LIMIT ?`)
    .bind(...params, q.limit ?? MAX_OBJECTS).all<ObjectRow>();
  return results;
}

/** Splits an If-Match / If-None-Match header into bare etags; `*` stays `*`. Weak markers are ignored. */
export function etagList(h: string | null | undefined): string[] | null {
  if (h == null) return null;
  return h.split(',').map((s) => s.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1')).filter(Boolean);
}

export interface Cond { ifMatch?: string | null; ifNoneMatch?: string | null }

interface Meta {
  uid: string; component: string | null; dtstart: number | null; dtend: number | null; recurring: boolean;
  recUntil: number | null; approx: boolean; fn: string | null; emails: string | null;
}

function analyze(coll: CollectionRow, text: string, uri: string): Meta {
  try {
    if (coll.kind === 'calendar') {
      const i = analyzeIcs(text);
      if (!coll.components.split(',').includes(i.component)) throw new DavError(403, ['C', 'supported-component']);
      return { ...i, fn: null, emails: null };
    }
    const v = analyzeVcard(text);
    return { uid: v.uid ?? uri.replace(/\.vcf$/i, ''), component: null, dtstart: null, dtend: null, recurring: false, recUntil: null, approx: false, fn: v.fn, emails: v.emails.join('\n') };
  } catch (e) {
    if (e instanceof IcsError) throw new DavError(403, ['C', 'valid-calendar-data']);
    if (e instanceof VcfError) throw new DavError(403, ['CR', 'valid-address-data']);
    throw e;
  }
}

/** Statements that bump the collection's revision and record `uri` in its change log. Must run after the write, in the same batch. */
function bump(db: D1Database, collId: string, uri: string, now: number): D1PreparedStatement[] {
  return [
    db.prepare('UPDATE dav_collections SET rev = rev + 1, updated_at = ? WHERE id = ?').bind(now, collId),
    db.prepare('INSERT INTO dav_changes (collection_id, rev, uri, created_at) SELECT id, rev, ?, ? FROM dav_collections WHERE id = ?').bind(uri, now, collId),
  ];
}

function checkConditions(existing: { etag: string } | null, cond: Cond): void {
  const inm = etagList(cond.ifNoneMatch);
  if (inm && existing && (inm.includes('*') || inm.includes(existing.etag))) throw new DavError(412);
  const im = etagList(cond.ifMatch);
  if (im && (!existing || !(im.includes('*') || im.includes(existing.etag)))) throw new DavError(412);
}

/** Creates or replaces an object. Throws DavError (403 invalid data / uid conflict, 412 precondition, 413 too large). */
export async function putObject(db: D1Database, coll: CollectionRow, uri: string, text: string, cond: Cond = {}): Promise<{ created: boolean; etag: string; id: string }> {
  const bytes = enc.encode(text).length;
  if (bytes > MAX_OBJECT_BYTES) throw new DavError(413);
  const existing = await getObject(db, coll.id, uri, false);
  checkConditions(existing, cond);
  const m = analyze(coll, text, uri);
  const clash = await db.prepare('SELECT uri FROM dav_objects WHERE collection_id = ? AND uid = ? AND uri != ? LIMIT 1').bind(coll.id, m.uid, uri).first<string>('uri');
  if (clash) throw new DavError(403, ['C', 'no-uid-conflict'], clash);
  if (!existing) {
    const n = await db.prepare('SELECT COUNT(*) AS n FROM dav_objects WHERE collection_id = ?').bind(coll.id).first<number>('n');
    if ((n ?? 0) >= MAX_OBJECTS) throw new DavError(507);
  }
  const etag = await sha256Hex(text);
  const now = Date.now();
  const id = existing?.id ?? ulid(now);
  await db.batch([
    db.prepare(
      `INSERT INTO dav_objects (id, collection_id, uri, uid, etag, size, data, component, dtstart, dtend, recurring, rec_until, approx, fn, emails, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (collection_id, uri) DO UPDATE SET uid = excluded.uid, etag = excluded.etag, size = excluded.size, data = excluded.data,
         component = excluded.component, dtstart = excluded.dtstart, dtend = excluded.dtend, recurring = excluded.recurring,
         rec_until = excluded.rec_until, approx = excluded.approx, fn = excluded.fn, emails = excluded.emails, updated_at = excluded.updated_at`,
    ).bind(id, coll.id, uri, m.uid, etag, bytes, text, m.component, m.dtstart, m.dtend, m.recurring ? 1 : 0, m.recUntil, m.approx ? 1 : 0, m.fn, m.emails, now, now),
    ...bump(db, coll.id, uri, now),
  ]);
  return { created: !existing, etag, id };
}

export async function deleteObject(db: D1Database, coll: CollectionRow, uri: string, cond: Cond = {}): Promise<void> {
  const existing = await getObject(db, coll.id, uri, false);
  if (!existing) throw new DavError(404);
  checkConditions(existing, { ifMatch: cond.ifMatch });
  const now = Date.now();
  await db.batch([db.prepare('DELETE FROM dav_objects WHERE collection_id = ? AND uri = ?').bind(coll.id, uri), ...bump(db, coll.id, uri, now)]);
}
