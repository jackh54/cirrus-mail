// JMAP core: limits, errors, per-request context, state helpers and the request processor (back references, creation ids).
import type { FolderRole } from '../../shared/api';
import type { UserRow } from '../lib/db';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type J = any;

export const CAP_CORE = 'urn:ietf:params:jmap:core';
export const CAP_MAIL = 'urn:ietf:params:jmap:mail';
export const CAP_SUBMISSION = 'urn:ietf:params:jmap:submission';
export const CAP_VACATION = 'urn:ietf:params:jmap:vacationresponse';
export const CAP_CIRRUS = 'urn:cirrus:params:jmap:labels';
export const SUPPORTED_CAPS = [CAP_CORE, CAP_MAIL, CAP_SUBMISSION, CAP_VACATION, CAP_CIRRUS];

export const LIMITS_JMAP = {
  maxSizeUpload: 50 * 1024 * 1024,
  maxConcurrentUpload: 4,
  maxSizeRequest: 10 * 1024 * 1024,
  maxConcurrentRequests: 4,
  maxCallsInRequest: 16,
  maxObjectsInGet: 500,
  maxObjectsInSet: 500,
  maxChanges: 500,
} as const;

/** A method-level error: becomes `["error", {type, description}, callId]`. */
export class MethodError extends Error {
  constructor(public type: string, public description?: string, public extra: Record<string, unknown> = {}) {
    super(type);
  }
}

export const invalidArguments = (d?: string) => new MethodError('invalidArguments', d);

export interface Account {
  id: string;
  address: string;
  displayName: string;
  role: 'owner' | 'member';
  members: number;
}

export interface Structure {
  folders: { id: string; name: string; role: FolderRole | null; sort: number }[];
  labels: { id: string; name: string; color: string }[];
  roles: Record<string, string>;
}

export interface Ctx {
  env: Env;
  user: UserRow;
  origin: string;
  accounts: Map<string, Account>;
  using: Set<string>;
  createdIds: Map<string, string>;
  structures: Map<string, Promise<Structure>>;
}

/** The account named by `args.accountId`, or the right method error. */
export function accountOf(ctx: Ctx, args: J): Account {
  if (typeof args?.accountId !== 'string') throw invalidArguments('accountId is required');
  const a = ctx.accounts.get(args.accountId);
  if (!a) throw new MethodError('accountNotFound');
  return a;
}

export function structureOf(ctx: Ctx, mb: string): Promise<Structure> {
  let p = ctx.structures.get(mb);
  if (!p) {
    p = ctx.env.DB.batch([
      ctx.env.DB.prepare('SELECT id, name, role, sort FROM folders WHERE mailbox_id = ? ORDER BY sort, name').bind(mb),
      ctx.env.DB.prepare('SELECT id, name, color FROM labels WHERE mailbox_id = ? ORDER BY name').bind(mb),
    ]).then(([f, l]) => {
      const folders = f.results as Structure['folders'];
      const roles: Record<string, string> = {};
      for (const x of folders) if (x.role) roles[x.role] = x.id;
      return { folders, labels: l.results as Structure['labels'], roles };
    });
    ctx.structures.set(mb, p);
  }
  return p;
}

export interface MailState { seq: number; email: number; mailbox: number; thread: number; pruned: number }

export const stateReadStmt = (db: D1Database, mb: string) =>
  db.prepare('SELECT seq, email, mailbox, thread, pruned FROM jmap_state WHERE mailbox_id = ?').bind(mb);

export function toState(r: unknown): MailState {
  return (r as MailState | undefined) ?? { seq: 0, email: 0, mailbox: 0, thread: 0, pruned: 0 };
}

export async function readState(db: D1Database, mb: string): Promise<MailState> {
  return toState(await stateReadStmt(db, mb).first());
}

/** The numeric sinceState, or a cannotCalculateChanges error when it is malformed, from the future or older than the kept tombstones. */
export function parseSince(since: unknown, current: number, pruned: number): number {
  if (typeof since !== 'string' || !/^\d{1,15}$/.test(since)) throw new MethodError('cannotCalculateChanges', 'Unknown state');
  const n = Number(since);
  // Nothing has changed since this state, so there is nothing a pruned tombstone could have hidden.
  if (n !== current && (n > current || n < pruned)) throw new MethodError('cannotCalculateChanges', 'State is too old');
  return n;
}

export function maxChangesOf(args: J): number {
  const m = args.maxChanges;
  if (m === undefined || m === null) return LIMITS_JMAP.maxChanges;
  if (!Number.isInteger(m) || m < 1) throw invalidArguments('maxChanges must be a positive integer');
  return Math.min(m, LIMITS_JMAP.maxChanges);
}

/** Validates an `ids` argument for /get (null is only allowed where `allowNull`). */
export function idsOf(args: J, allowNull = false): string[] | null {
  const ids = args.ids;
  if (ids === null || ids === undefined) {
    if (allowNull) return null;
    throw new MethodError('requestTooLarge', 'ids must be given');
  }
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string')) throw invalidArguments('ids must be an array of strings');
  if (ids.length > LIMITS_JMAP.maxObjectsInGet) throw new MethodError('requestTooLarge', `At most ${LIMITS_JMAP.maxObjectsInGet} ids`);
  return ids as string[];
}

export function propsOf(args: J, all: readonly string[]): Set<string> {
  const p = args.properties;
  if (p === null || p === undefined) return new Set(all);
  if (!Array.isArray(p) || p.some((x) => typeof x !== 'string')) throw invalidArguments('properties must be an array of strings');
  return new Set(['id', ...p]);
}

export function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------- request processing ----------

export type MethodResult = J | [string, J][];
export type Handler = (ctx: Ctx, args: J, callId: string) => Promise<MethodResult>;
export interface MethodDef { cap: string; run: Handler }

/** JSON Pointer with the RFC 8620 `*` wildcard (maps over an array and flattens array results). */
function resolvePointer(value: J, path: string): J {
  if (path === '') return value;
  if (!path.startsWith('/')) throw new Error('bad path');
  const walk = (v: J, tokens: string[]): J => {
    if (!tokens.length) return v;
    const [t, ...rest] = tokens;
    if (t === '*') {
      if (!Array.isArray(v)) throw new Error('not an array');
      return v.map((x) => walk(x, rest)).flatMap((x) => (Array.isArray(x) ? x : [x]));
    }
    if (Array.isArray(v)) {
      if (!/^\d+$/.test(t) || Number(t) >= v.length) throw new Error('bad index');
      return walk(v[Number(t)], rest);
    }
    if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, t)) return walk(v[t], rest);
    throw new Error('missing');
  };
  return walk(value, path.slice(1).split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~')));
}

/** Replaces `#name` arguments with the earlier method result they point at. */
function resolveBackRefs(args: J, responses: [string, J, string][]): J {
  const out: J = {};
  for (const [k, v] of Object.entries(args) as [string, J][]) {
    if (!k.startsWith('#')) {
      out[k] = v;
      continue;
    }
    const real = k.slice(1);
    if (real in args) throw invalidArguments(`Both ${real} and #${real} are present`);
    if (!v || typeof v !== 'object' || typeof v.resultOf !== 'string' || typeof v.name !== 'string' || typeof v.path !== 'string') {
      throw new MethodError('invalidResultReference', 'Malformed result reference');
    }
    const prev = responses.find((r) => r[2] === v.resultOf && r[0] === v.name);
    if (!prev) throw new MethodError('invalidResultReference', 'No such earlier result');
    try {
      out[real] = resolvePointer(prev[1], v.path);
    } catch {
      throw new MethodError('invalidResultReference', 'The path does not exist in the result');
    }
  }
  return out;
}

/** Properties whose string value is an id, arrays whose strings are ids, and maps keyed by ids (RFC 8620/8621). */
const ID_PROPS = new Set(['emailId', 'identityId', 'threadId', 'blobId', 'parentId', 'mailboxId', 'inMailbox', 'anchor']);
const ID_LISTS = new Set(['ids', 'destroy', 'emailIds', 'threadIds', 'inMailboxOtherThan', 'onSuccessDestroyEmail']);
const ID_KEYED = new Set(['mailboxIds', 'keywords', 'update', 'onSuccessUpdateEmail']);

/** Replaces `#creationId` with the ids the server assigned earlier in this request, in id positions only: subjects and bodies are left alone. */
function resolveCreationIds(v: J, ids: Map<string, string>, prop = ''): J {
  const sub = (s: string): string => (s.startsWith('#') && ids.has(s.slice(1)) ? ids.get(s.slice(1))! : s);
  if (typeof v === 'string') return ID_PROPS.has(prop) ? sub(v) : v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? (ID_LISTS.has(prop) ? sub(x) : x) : resolveCreationIds(x, ids, prop)));
  if (v && typeof v === 'object') {
    const keyed = ID_KEYED.has(prop);
    const o: J = {};
    for (const [k, x] of Object.entries(v)) {
      const patch = /^mailboxIds\/(#.+)$/.exec(k); // patch path to one mailbox
      o[keyed ? sub(k) : patch ? `mailboxIds/${sub(patch[1])}` : k] = resolveCreationIds(x, ids, keyed ? '' : k);
    }
    return o;
  }
  return v;
}

export async function runCalls(ctx: Ctx, calls: [string, J, string][], methods: Record<string, MethodDef>): Promise<[string, J, string][]> {
  const responses: [string, J, string][] = [];
  for (const [name, rawArgs, callId] of calls) {
    try {
      const def = methods[name];
      if (!def || !ctx.using.has(def.cap)) throw new MethodError('unknownMethod');
      if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) throw invalidArguments('Arguments must be an object');
      let args = resolveBackRefs(rawArgs, responses);
      args = resolveCreationIds(args, ctx.createdIds);
      const result = await def.run(ctx, args, callId);
      const list: [string, J][] = Array.isArray(result) ? result : [[name, result]];
      for (const [n, a] of list) {
        responses.push([n, a, callId]);
        if (a?.created && typeof a.created === 'object' && n.endsWith('/set')) {
          for (const [cid, obj] of Object.entries(a.created as Record<string, J>)) if (obj?.id) ctx.createdIds.set(cid, obj.id);
        }
        if (a?.created && n === 'Email/import') {
          for (const [cid, obj] of Object.entries(a.created as Record<string, J>)) if (obj?.id) ctx.createdIds.set(cid, obj.id);
        }
      }
    } catch (e) {
      if (e instanceof MethodError) {
        responses.push(['error', { type: e.type, ...(e.description ? { description: e.description } : {}), ...e.extra }, callId]);
      } else {
        console.error('jmap method error', (e as Error).name);
        responses.push(['error', { type: 'serverFail' }, callId]);
      }
    }
  }
  return responses;
}

/** Binds a JSON array as one parameter: `WHERE id IN (SELECT value FROM json_each(?))` (D1 allows 100 variables). */
export const jsonIds = (ids: string[]) => JSON.stringify(ids);
