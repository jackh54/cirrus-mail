// Mailbox/*: Cirrus folders and labels both appear as JMAP mailboxes. Folders carry roles; labels have none.
import { LABEL_COLORS, LABEL_LIMITS, type FolderRole } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { cleanHeaderText } from '../lib/validate';
import {
  accountOf, idsOf, invalidArguments, jsonIds, LIMITS_JMAP, MethodError, parseSince, propsOf, readState, structureOf, stateReadStmt, toState,
  type Ctx, type J, type MethodDef,
} from './core';

const ROLE_OUT: Record<FolderRole, string | null> = {
  inbox: 'inbox', sent: 'sent', drafts: 'drafts', archive: 'archive', spam: 'junk', trash: 'trash', scheduled: null,
};
export const roleToJmap = (r: FolderRole | null): string | null => (r ? ROLE_OUT[r] : null);

const PROPS = ['id', 'name', 'parentId', 'role', 'sortOrder', 'totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads', 'myRights', 'isSubscribed', 'cirrusKind', 'cirrusColor'] as const;
const COUNT_PROPS = ['totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads'];
const LABEL_SORT = 1000;

interface Counts { total: number; unread: number; threads: number; unreadThreads: number }
const ZERO: Counts = { total: 0, unread: 0, threads: 0, unreadThreads: 0 };

async function countsFor(db: D1Database, mb: string): Promise<{ state: ReturnType<typeof toState>; folders: Map<string, Counts>; labels: Map<string, Counts> }> {
  const [st, f, l] = await db.batch([
    stateReadStmt(db, mb),
    db.prepare(
      `SELECT folder_id AS id, COUNT(*) AS total, COALESCE(SUM(is_read = 0), 0) AS unread, COUNT(DISTINCT thread_id) AS threads,
              COUNT(DISTINCT CASE WHEN is_read = 0 THEN thread_id END) AS unreadThreads
         FROM messages WHERE mailbox_id = ? GROUP BY folder_id`,
    ).bind(mb),
    db.prepare(
      `SELECT ml.label_id AS id, COUNT(*) AS total, COALESCE(SUM(m.is_read = 0), 0) AS unread, COUNT(DISTINCT m.thread_id) AS threads,
              COUNT(DISTINCT CASE WHEN m.is_read = 0 THEN m.thread_id END) AS unreadThreads
         FROM message_labels ml JOIN messages m ON m.id = ml.message_id
        WHERE ml.label_id IN (SELECT id FROM labels WHERE mailbox_id = ?1) AND m.mailbox_id = ?1 GROUP BY ml.label_id`,
    ).bind(mb),
  ]);
  const map = (r: D1Result) => new Map((r.results as (Counts & { id: string })[]).map((x) => [x.id, x]));
  return { state: toState(st.results[0]), folders: map(f), labels: map(l) };
}

export function mailboxObject(
  kind: 'folder' | 'label', row: { id: string; name: string; role?: FolderRole | null; sort?: number; color?: string }, c: Counts,
) {
  const system = kind === 'folder' && !!row.role;
  return {
    id: row.id, name: row.name, parentId: null, role: kind === 'folder' ? roleToJmap(row.role ?? null) : null,
    sortOrder: kind === 'folder' ? row.sort ?? 100 : LABEL_SORT,
    totalEmails: c.total, unreadEmails: c.unread, totalThreads: c.threads, unreadThreads: c.unreadThreads,
    myRights: {
      mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true,
      mayCreateChild: false, mayRename: !system, mayDelete: !system, maySubmit: true,
    },
    isSubscribed: true,
    cirrusKind: kind,
    cirrusColor: kind === 'label' ? row.color ?? null : null,
  };
}

const mailboxGet: MethodDef = {
  cap: 'urn:ietf:params:jmap:mail',
  async run(ctx, args) {
    const acc = accountOf(ctx, args);
    const ids = idsOf(args, true);
    const props = propsOf(args, PROPS);
    const [st, { state, folders, labels }] = await Promise.all([structureOf(ctx, acc.id), countsFor(ctx.env.DB, acc.id)]);
    const all = [
      ...st.folders.map((f) => mailboxObject('folder', f, folders.get(f.id) ?? ZERO)),
      ...st.labels.map((l) => mailboxObject('label', l, labels.get(l.id) ?? ZERO)),
    ];
    const want = ids ?? all.map((m) => m.id);
    const byId = new Map(all.map((m) => [m.id, m]));
    const list: J[] = [];
    const notFound: string[] = [];
    for (const id of want) {
      const m = byId.get(id);
      if (!m) notFound.push(id);
      else list.push(Object.fromEntries(Object.entries(m).filter(([k]) => props.has(k))));
    }
    return { accountId: acc.id, state: String(state.mailbox), list, notFound };
  },
};

const mailboxChanges: MethodDef = {
  cap: 'urn:ietf:params:jmap:mail',
  async run(ctx, args) {
    const acc = accountOf(ctx, args);
    const db = ctx.env.DB;
    const st = await readState(db, acc.id);
    const since = parseSince(args.sinceState, st.mailbox, st.pruned);
    const max = args.maxChanges === undefined || args.maxChanges === null ? LIMITS_JMAP.maxChanges : args.maxChanges;
    if (!Number.isInteger(max) || max < 1) throw invalidArguments('maxChanges must be a positive integer');
    const [f, l, t, all] = await db.batch([
      db.prepare('SELECT id, cseq FROM folders WHERE mailbox_id = ? AND modseq > ?').bind(acc.id, since),
      db.prepare('SELECT id, cseq FROM labels WHERE mailbox_id = ? AND modseq > ?').bind(acc.id, since),
      db.prepare("SELECT id FROM jmap_tombstones WHERE mailbox_id = ? AND type = 'Mailbox' AND modseq > ?").bind(acc.id, since),
      db.prepare('SELECT id FROM folders WHERE mailbox_id = ? UNION ALL SELECT id FROM labels WHERE mailbox_id = ?').bind(acc.id, acc.id),
    ]);
    const rows = [...f.results, ...l.results] as { id: string; cseq: number }[];
    const created = rows.filter((r) => r.cseq > since).map((r) => r.id);
    const updated = rows.filter((r) => r.cseq <= since).map((r) => r.id);
    const destroyed = (t.results as { id: string }[]).map((r) => r.id);
    const structural = rows.length + destroyed.length > 0;
    let updatedProperties: string[] | null = null;
    if (!structural && st.mailbox > since) {
      // Only message changes moved the counts: every mailbox may differ, but only in its counts.
      updated.push(...(all.results as { id: string }[]).map((r) => r.id));
      updatedProperties = COUNT_PROPS;
    } else if (st.email > since) {
      // Structural changes plus count changes: report every mailbox with all properties.
      for (const r of all.results as { id: string }[]) if (!created.includes(r.id) && !updated.includes(r.id)) updated.push(r.id);
    }
    if (created.length + updated.length + destroyed.length > max) throw new MethodError('cannotCalculateChanges', 'Too many changes; refetch the mailboxes');
    return {
      accountId: acc.id, oldState: args.sinceState, newState: String(st.mailbox), hasMoreChanges: false, created, updated, destroyed, updatedProperties,
    };
  },
};

const mailboxQuery: MethodDef = {
  cap: 'urn:ietf:params:jmap:mail',
  async run(ctx, args) {
    const acc = accountOf(ctx, args);
    const [st, { state, folders, labels }] = await Promise.all([structureOf(ctx, acc.id), countsFor(ctx.env.DB, acc.id)]);
    let list = [
      ...st.folders.map((f) => mailboxObject('folder', f, folders.get(f.id) ?? ZERO)),
      ...st.labels.map((l) => mailboxObject('label', l, labels.get(l.id) ?? ZERO)),
    ];
    const f = args.filter ?? {};
    if (typeof f !== 'object') throw invalidArguments('filter must be an object');
    for (const k of Object.keys(f)) {
      if (!['parentId', 'name', 'role', 'hasAnyRole', 'isSubscribed'].includes(k)) throw new MethodError('unsupportedFilter', `Unsupported filter ${k}`);
    }
    if ('parentId' in f) list = list.filter((m) => m.parentId === f.parentId);
    if ('name' in f) list = list.filter((m) => m.name.toLowerCase().includes(String(f.name).toLowerCase()));
    if ('role' in f) list = list.filter((m) => m.role === f.role);
    if ('hasAnyRole' in f) list = list.filter((m) => (m.role !== null) === !!f.hasAnyRole);
    if ('isSubscribed' in f) list = list.filter((m) => m.isSubscribed === !!f.isSubscribed);
    const sort = Array.isArray(args.sort) && args.sort.length ? args.sort : [{ property: 'sortOrder' }, { property: 'name' }];
    for (const s of sort) if (s.property !== 'sortOrder' && s.property !== 'name') throw new MethodError('unsupportedSort', `Unsupported sort ${s.property}`);
    list.sort((a, b) => {
      for (const s of sort) {
        const k = s.property as 'sortOrder' | 'name';
        const d = k === 'name' ? a.name.localeCompare(b.name) : a.sortOrder - b.sortOrder;
        if (d) return s.isAscending === false ? -d : d;
      }
      return 0;
    });
    const pos = Number.isInteger(args.position) ? Math.max(0, args.position) : 0;
    const ids = list.map((m) => m.id);
    const limit = Number.isInteger(args.limit) && args.limit >= 0 ? args.limit : undefined;
    return {
      accountId: acc.id, queryState: String(state.mailbox), canCalculateChanges: false, position: pos,
      ids: ids.slice(pos, limit === undefined ? undefined : pos + limit), ...(args.calculateTotal ? { total: ids.length } : {}),
    };
  },
};

const cannotQueryChanges: MethodDef = {
  cap: 'urn:ietf:params:jmap:mail',
  async run(ctx, args) {
    accountOf(ctx, args);
    throw new MethodError('cannotCalculateChanges', 'queryChanges is not supported; re-run the query');
  },
};

function validName(v: unknown): string {
  if (typeof v !== 'string') throw new Error('name');
  const n = cleanHeaderText(v).trim();
  if (!n || n.length > (LABEL_LIMITS.maxName > 64 ? LABEL_LIMITS.maxName : 64)) throw new Error('name');
  return n;
}

const mailboxSet: MethodDef = {
  cap: 'urn:ietf:params:jmap:mail',
  async run(ctx, args) {
    const acc = accountOf(ctx, args);
    const db = ctx.env.DB;
    const st = await structureOf(ctx, acc.id);
    const before = await readState(db, acc.id);
    if (args.ifInState !== undefined && args.ifInState !== null && args.ifInState !== String(before.mailbox)) throw new MethodError('stateMismatch');
    const create = (args.create ?? {}) as Record<string, J>;
    const update = (args.update ?? {}) as Record<string, J>;
    const destroy = (args.destroy ?? []) as string[];
    if (!Array.isArray(destroy)) throw invalidArguments('destroy must be an array');
    if (Object.keys(create).length + Object.keys(update).length + destroy.length > LIMITS_JMAP.maxObjectsInSet) throw new MethodError('requestTooLarge');

    const created: Record<string, J> = {};
    const notCreated: Record<string, J> = {};
    const updated: Record<string, J> = {};
    const notUpdated: Record<string, J> = {};
    const destroyed: string[] = [];
    const notDestroyed: Record<string, J> = {};
    const now = Date.now();
    const isFolder = (id: string) => st.folders.find((f) => f.id === id);
    const isLabel = (id: string) => st.labels.find((l) => l.id === id);

    for (const [cid, obj] of Object.entries(create)) {
      try {
        const bad = (p: string, d: string) => Object.assign(new Error(d), { setError: { type: 'invalidProperties', properties: [p], description: d } });
        let name: string;
        try { name = validName(obj.name); } catch { throw bad('name', 'name must be 1-64 characters'); }
        if (obj.parentId !== undefined && obj.parentId !== null) throw bad('parentId', 'Only top-level mailboxes are supported');
        if (obj.role !== undefined && obj.role !== null) throw bad('role', 'System roles cannot be created');
        const kind = obj.cirrusKind ?? 'folder';
        if (kind !== 'folder' && kind !== 'label') throw bad('cirrusKind', 'cirrusKind must be "folder" or "label"');
        const id = ulid(now);
        if (kind === 'folder') {
          const sort = Number.isInteger(obj.sortOrder) && obj.sortOrder >= 0 && obj.sortOrder <= 10_000 ? obj.sortOrder : 100;
          if (st.folders.some((f) => f.name === name)) throw bad('name', 'A folder with that name already exists');
          await db.prepare('INSERT INTO folders (id, mailbox_id, name, role, sort, created_at) VALUES (?, ?, ?, NULL, ?, ?)').bind(id, acc.id, name, sort, now).run();
          created[cid] = { id, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, myRights: mailboxObject('folder', { id, name }, ZERO).myRights, isSubscribed: true, sortOrder: sort };
        } else {
          const color = obj.cirrusColor ?? 'cobalt';
          if (!(LABEL_COLORS as readonly string[]).includes(color)) throw bad('cirrusColor', 'Unknown label color');
          if (st.labels.some((l) => l.name.toLowerCase() === name.toLowerCase())) throw bad('name', 'A label with that name already exists');
          if (st.labels.length >= LABEL_LIMITS.maxPerMailbox) throw Object.assign(new Error('limit'), { setError: { type: 'overQuota', description: 'Too many labels' } });
          await db.prepare('INSERT INTO labels (id, mailbox_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, acc.id, name, color, now).run();
          created[cid] = { id, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, myRights: mailboxObject('label', { id, name }, ZERO).myRights, isSubscribed: true, sortOrder: LABEL_SORT };
        }
      } catch (e) {
        notCreated[cid] = (e as { setError?: J }).setError ?? { type: 'invalidProperties', description: 'Could not create the mailbox' };
      }
    }

    for (const [id, patch] of Object.entries(update)) {
      try {
        const folder = isFolder(id);
        const label = isLabel(id);
        if (!folder && !label) { notUpdated[id] = { type: 'notFound' }; continue; }
        if (folder?.role) { notUpdated[id] = { type: 'forbidden', description: 'System mailboxes cannot be changed' }; continue; }
        let name = (folder ?? label)!.name;
        let sort = folder?.sort ?? 0;
        let color = label?.color ?? '';
        for (const [k, v] of Object.entries(patch as Record<string, J>)) {
          if (k === 'name') name = validName(v);
          else if (k === 'sortOrder' && folder) {
            if (!Number.isInteger(v) || v < 0 || v > 10_000) throw new Error('sortOrder');
            sort = v;
          } else if (k === 'cirrusColor' && label) {
            if (!(LABEL_COLORS as readonly string[]).includes(v)) throw new Error('cirrusColor');
            color = v;
          } else if (k === 'isSubscribed' || k === 'sortOrder') { /* accepted, nothing to store */ }
          else if (k === 'parentId' && v === null) { /* top level already */ }
          else { notUpdated[id] = { type: 'invalidProperties', properties: [k] }; throw new Error('handled'); }
        }
        try {
          if (folder) await db.prepare('UPDATE folders SET name = ?, sort = ? WHERE id = ? AND mailbox_id = ?').bind(name, sort, id, acc.id).run();
          else await db.prepare('UPDATE labels SET name = ?, color = ? WHERE id = ? AND mailbox_id = ?').bind(name, color, id, acc.id).run();
        } catch {
          notUpdated[id] = { type: 'invalidProperties', properties: ['name'], description: 'A mailbox with that name already exists' };
          continue;
        }
        updated[id] = null;
      } catch (e) {
        if ((e as Error).message !== 'handled') notUpdated[id] = { type: 'invalidProperties', properties: [(e as Error).message] };
      }
    }

    for (const id of destroy) {
      const folder = isFolder(id);
      const label = isLabel(id);
      if (!folder && !label) { notDestroyed[id] = { type: 'notFound' }; continue; }
      if (folder?.role) { notDestroyed[id] = { type: 'forbidden', description: 'System mailboxes cannot be destroyed' }; continue; }
      const has = folder
        ? await db.prepare('SELECT 1 FROM messages WHERE mailbox_id = ? AND folder_id = ? LIMIT 1').bind(acc.id, id).first()
        : await db.prepare('SELECT 1 FROM message_labels WHERE label_id = ? LIMIT 1').bind(id).first();
      if (has && args.onDestroyRemoveEmails !== true) { notDestroyed[id] = { type: 'mailboxHasEmail' }; continue; }
      if (folder) {
        // Same as the Cirrus API: the messages are kept and moved to Archive.
        await db.batch([
          db.prepare('UPDATE messages SET folder_id = ?, folder_changed_at = ?, updated_at = ? WHERE mailbox_id = ? AND folder_id = ?').bind(st.roles.archive, now, now, acc.id, id),
          db.prepare('DELETE FROM folders WHERE id = ? AND mailbox_id = ?').bind(id, acc.id),
        ]);
      } else {
        await db.batch([
          db.prepare('DELETE FROM message_labels WHERE label_id IN (SELECT id FROM labels WHERE id = ? AND mailbox_id = ?)').bind(id, acc.id),
          db.prepare('DELETE FROM labels WHERE id = ? AND mailbox_id = ?').bind(id, acc.id),
        ]);
      }
      destroyed.push(id);
    }
    ctx.structures.delete(acc.id);
    const after = await readState(db, acc.id);
    const none = (o: object) => (Object.keys(o).length ? o : null);
    return {
      accountId: acc.id, oldState: String(before.mailbox), newState: String(after.mailbox),
      created: none(created), updated: none(updated), destroyed: destroyed.length ? destroyed : null,
      notCreated: none(notCreated), notUpdated: none(notUpdated), notDestroyed: none(notDestroyed),
    };
  },
};

export const mailboxMethods: Record<string, MethodDef> = {
  'Mailbox/get': mailboxGet,
  'Mailbox/changes': mailboxChanges,
  'Mailbox/query': mailboxQuery,
  'Mailbox/queryChanges': cannotQueryChanges,
  'Mailbox/set': mailboxSet,
};

export { jsonIds };
export type { Ctx };
