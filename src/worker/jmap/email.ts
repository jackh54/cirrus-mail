// Email/*, Thread/*, SearchSnippet/get. Emails are Cirrus messages: mailboxIds = folder + labels, $seen/$flagged/$draft come from columns.
import PostalMime from 'postal-mime';
import { LIMITS, type Address } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { dedupeAddresses, fromParsed, isValidEmail, parseJsonAddresses, normalizeEmail } from '../lib/addresses';
import {
  addressesForFts, deleteMessagesForever, ftsInsertStmts, inlineBodyJson, loadRowBody, recomputeThreadStmts, type MessageRow, type StoredBody,
} from '../lib/db';
import { escapeHtml, htmlToText, makeSnippet } from '../lib/html';
import { cleanHeaderText } from '../lib/validate';
import { findThread, normalizeSubject, parseMessageIds } from '../inbound/thread';
import { sendableAddresses } from '../outbound/send';
import { blobId, loadBlob, parseBlobId } from './blob';
import {
  accountOf, idsOf, invalidArguments, isoUtc, jsonIds, LIMITS_JMAP, maxChangesOf, MethodError, parseSince, propsOf, readState, stateReadStmt,
  structureOf, toState, type Account, type Ctx, type J, type MethodDef, type Structure,
} from './core';
import { buildFtsQuery, ftsQuote } from '../search';

const CAP = 'urn:ietf:params:jmap:mail';
const OUTBOX = new Set(['draft', 'scheduled', 'sending']);
const MAX_SCAN = 10_000;

const EMAIL_DEFAULT = [
  'id', 'blobId', 'threadId', 'mailboxIds', 'keywords', 'size', 'receivedAt', 'messageId', 'inReplyTo', 'references', 'sender', 'from', 'to', 'cc',
  'bcc', 'replyTo', 'subject', 'sentAt', 'hasAttachment', 'preview', 'bodyValues', 'textBody', 'htmlBody', 'attachments',
] as const;
const EMAIL_ALL = [...EMAIL_DEFAULT, 'headers', 'bodyStructure'] as const;
const PART_DEFAULT = ['partId', 'blobId', 'size', 'name', 'type', 'charset', 'disposition', 'cid', 'language', 'location'];

const BASE_COLS = `m.id, m.mailbox_id, m.thread_id, m.folder_id, m.direction, m.status, m.message_id_hdr, m.in_reply_to, m.references_hdr,
  m.from_email, m.from_name, m.to_json, m.cc_json, m.bcc_json, m.reply_to, m.subject, m.snippet, m.size, m.has_attachments, m.is_read,
  m.is_starred, m.date, m.display_date, m.list_id, m.body_key`;

interface EmailRow {
  id: string; mailbox_id: string; thread_id: string; folder_id: string; direction: 'in' | 'out'; status: string; message_id_hdr: string | null;
  in_reply_to: string | null; references_hdr: string | null; from_email: string; from_name: string; to_json: string; cc_json: string; bcc_json: string;
  reply_to: string | null; subject: string; snippet: string; size: number; has_attachments: number; is_read: number; is_starred: number;
  date: number; display_date: number | null; list_id: string | null; body_key: string | null; body_inline?: string | null;
}
interface AttRow { id: string; message_id: string; filename: string; mime_type: string; size: number; content_id: string | null; inline: number }

interface Part {
  partId: string | null; blobId: string | null; size: number; name: string | null; type: string; charset: string | null; disposition: string | null;
  cid: string | null; language: string[] | null; location: string | null; headers: { name: string; value: string }[]; subParts?: Part[];
}

const enc = new TextEncoder();
const byteLen = (s: string) => enc.encode(s).byteLength;

const addrs = (list: Address[]) => list.map((a) => ({ name: a.name || null, email: a.email }));
const idList = (v: string | null | undefined) => { const l = parseMessageIds(v).map((x) => x.slice(1, -1)); return l.length ? l : null; };
const keywordsOf = (r: EmailRow): Record<string, boolean> => ({
  ...(r.is_read ? { $seen: true } : {}), ...(r.is_starred ? { $flagged: true } : {}),
  ...(r.direction === 'out' && (r.status === 'draft' || r.status === 'failed') ? { $draft: true } : {}),
});

/** Cuts a UTF-8 string to at most `max` bytes on a character boundary. */
function truncateUtf8(s: string, max: number): { value: string; truncated: boolean } {
  const b = enc.encode(s);
  if (b.byteLength <= max) return { value: s, truncated: false };
  let end = max;
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
  return { value: new TextDecoder().decode(b.subarray(0, end)), truncated: true };
}

function buildParts(r: EmailRow, body: StoredBody | null, atts: AttRow[]) {
  const hasHtml = body?.html !== null && body?.html !== undefined;
  const text = body ? body.text ?? (hasHtml ? htmlToText(body.html!) : '') : '';
  const mk = (partId: string | null, bid: string | null, size: number, type: string, extra: Partial<Part> = {}): Part => ({
    partId, blobId: bid, size, name: null, type, charset: type.startsWith('text/') ? 'utf-8' : null, disposition: null, cid: null, language: null, location: null,
    headers: [{ name: 'Content-Type', value: type }], ...extra,
  });
  const textPart = mk('1', blobId('t', r.id), byteLen(text), 'text/plain');
  const htmlPart = hasHtml ? mk('2', blobId('h', r.id), byteLen(body!.html!), 'text/html') : null;
  const attParts = atts.map((a, i) => mk(String(3 + i), blobId('a', a.id), a.size, a.mime_type, {
    name: a.filename, disposition: a.inline ? 'inline' : 'attachment', cid: a.content_id, charset: null,
  }));
  const textBody = [htmlPart && !text ? htmlPart : textPart];
  const htmlBody = [htmlPart ?? textPart];
  const bodyRoot: Part = htmlPart
    ? mk(null, null, 0, 'multipart/alternative', { subParts: [textPart, htmlPart], charset: null })
    : textPart;
  const root: Part = attParts.length ? mk(null, null, 0, 'multipart/mixed', { subParts: [bodyRoot, ...attParts], charset: null }) : bodyRoot;
  return { root, textBody, htmlBody, attachments: attParts, all: [textPart, ...(htmlPart ? [htmlPart] : [])] };
}

function shapePart(p: Part, props: Set<string>): J {
  const o: J = {};
  for (const k of props) if (k in p && k !== 'subParts') o[k] = (p as J)[k];
  if (p.subParts) o.subParts = p.subParts.map((s) => shapePart(s, props));
  return o;
}

const NAMES: Record<string, string> = {};
function parseHeaderProp(prop: string): { name: string; form: string; all: boolean } | null {
  const parts = prop.split(':');
  if (parts[0] !== 'header' || parts.length < 2) return null;
  let all = false;
  const rest = parts.slice(1);
  if (rest[rest.length - 1] === 'all') { all = true; rest.pop(); }
  const [name, form = 'asRaw'] = rest;
  if (!name || rest.length > 2 || !['asRaw', 'asText', 'asAddresses', 'asGroupedAddresses', 'asMessageIds', 'asDate', 'asURLs'].includes(form)) return null;
  return { name: NAMES[name] ?? name.toLowerCase(), form, all };
}

function headerValue(r: EmailRow, name: string, form: string, all: boolean): J {
  const list = (a: Address[]) => a.map((x) => (x.name ? `${x.name} <${x.email}>` : x.email)).join(', ');
  let addrList: Address[] | null = null;
  let raw: string | null = null;
  let ids: string[] | null = null;
  let date: number | null = null;
  switch (name) {
    case 'subject': raw = r.subject; break;
    case 'from': addrList = r.from_email ? [{ email: r.from_email, ...(r.from_name ? { name: r.from_name } : {}) }] : null; break;
    case 'to': addrList = parseJsonAddresses(r.to_json); break;
    case 'cc': addrList = parseJsonAddresses(r.cc_json); break;
    case 'bcc': addrList = parseJsonAddresses(r.bcc_json); break;
    case 'reply-to': addrList = r.reply_to ? r.reply_to.split(',').map((e) => ({ email: e.trim() })) : null; break;
    case 'message-id': ids = idList(r.message_id_hdr); break;
    case 'in-reply-to': ids = idList(r.in_reply_to); break;
    case 'references': ids = idList(r.references_hdr); break;
    case 'date': date = r.display_date ?? r.date; break;
    case 'list-id': raw = r.list_id; break;
    default: return all ? [] : null;
  }
  let v: J = null;
  if (form === 'asAddresses') v = addrList && addrList.length ? addrs(addrList) : null;
  else if (form === 'asMessageIds') v = ids;
  else if (form === 'asDate') v = date === null ? null : isoUtc(date);
  else if (form === 'asURLs' || form === 'asGroupedAddresses') v = null;
  else {
    const s = raw ?? (addrList && addrList.length ? list(addrList) : ids ? ids.map((i) => `<${i}>`).join(' ') : date !== null ? new Date(date).toUTCString() : null);
    v = s === null ? null : form === 'asText' ? s : ` ${s}`;
  }
  return all ? (v === null ? [] : [v]) : v;
}

interface GetOpts { props: Set<string>; bodyProps: Set<string>; fetchText: boolean; fetchHtml: boolean; fetchAll: boolean; maxBytes: number | null }

function emailObject(r: EmailRow, mailboxIds: Record<string, boolean>, atts: AttRow[], body: StoredBody | null, o: GetOpts): J {
  const parts = o.props.has('bodyStructure') || o.props.has('textBody') || o.props.has('htmlBody') || o.props.has('attachments') || o.props.has('bodyValues')
    ? buildParts(r, body, atts) : null;
  const out: J = {};
  for (const p of o.props) {
    switch (p) {
      case 'id': out.id = r.id; break;
      case 'blobId': out.blobId = blobId('m', r.id); break;
      case 'threadId': out.threadId = r.thread_id; break;
      case 'mailboxIds': out.mailboxIds = mailboxIds; break;
      case 'keywords': out.keywords = keywordsOf(r); break;
      case 'size': out.size = r.size; break;
      case 'receivedAt': out.receivedAt = isoUtc(r.date); break;
      case 'sentAt': out.sentAt = isoUtc(r.display_date ?? r.date); break;
      case 'messageId': out.messageId = idList(r.message_id_hdr); break;
      case 'inReplyTo': out.inReplyTo = idList(r.in_reply_to); break;
      case 'references': out.references = idList(r.references_hdr); break;
      case 'sender': out.sender = null; break;
      case 'from': out.from = r.from_email ? addrs([{ email: r.from_email, name: r.from_name }]) : null; break;
      case 'to': { const l = parseJsonAddresses(r.to_json); out.to = l.length ? addrs(l) : null; break; }
      case 'cc': { const l = parseJsonAddresses(r.cc_json); out.cc = l.length ? addrs(l) : null; break; }
      case 'bcc': { const l = parseJsonAddresses(r.bcc_json); out.bcc = l.length ? addrs(l) : null; break; }
      case 'replyTo': out.replyTo = r.reply_to ? addrs(r.reply_to.split(',').map((e) => ({ email: e.trim() })).filter((a) => a.email)) : null; break;
      case 'subject': out.subject = r.subject; break;
      case 'hasAttachment': out.hasAttachment = !!r.has_attachments; break;
      case 'preview': out.preview = r.snippet.slice(0, 256); break;
      case 'headers': out.headers = ['Subject', 'From', 'To', 'Cc', 'Message-ID', 'In-Reply-To', 'References', 'Date']
        .map((n) => ({ name: n, value: headerValue(r, n.toLowerCase(), 'asRaw', false) })).filter((h) => h.value !== null); break;
      case 'bodyStructure': out.bodyStructure = shapePart(parts!.root, o.bodyProps); break;
      case 'textBody': out.textBody = parts!.textBody.map((x) => shapePart(x, o.bodyProps)); break;
      case 'htmlBody': out.htmlBody = parts!.htmlBody.map((x) => shapePart(x, o.bodyProps)); break;
      case 'attachments': out.attachments = parts!.attachments.map((x) => shapePart(x, o.bodyProps)); break;
      case 'bodyValues': {
        const want = new Set<string>();
        if (o.fetchAll) parts!.all.forEach((x) => want.add(x.partId!));
        if (o.fetchText) parts!.textBody.forEach((x) => want.add(x.partId!));
        if (o.fetchHtml) parts!.htmlBody.forEach((x) => want.add(x.partId!));
        const values: J = {};
        for (const pid of want) {
          const raw = pid === '2' ? body?.html ?? '' : body?.text ?? (body?.html ? htmlToText(body.html) : '');
          const t = o.maxBytes ? truncateUtf8(raw, o.maxBytes) : { value: raw, truncated: false };
          values[pid] = { value: t.value, isEncodingProblem: false, isTruncated: t.truncated };
        }
        out.bodyValues = values;
        break;
      }
      default: {
        const h = parseHeaderProp(p);
        if (h) out[p] = headerValue(r, h.name, h.form, h.all);
      }
    }
  }
  return out;
}

async function labelMap(db: D1Database, ids: string[]): Promise<Map<string, string[]>> {
  const { results } = await db.prepare('SELECT message_id, label_id FROM message_labels WHERE message_id IN (SELECT value FROM json_each(?))').bind(jsonIds(ids)).all<{ message_id: string; label_id: string }>();
  const m = new Map<string, string[]>();
  for (const r of results) m.set(r.message_id, [...(m.get(r.message_id) ?? []), r.label_id]);
  return m;
}

const mailboxIdsOf = (r: { folder_id: string }, labels: string[] | undefined) => ({ [r.folder_id]: true, ...Object.fromEntries((labels ?? []).map((l) => [l, true])) });

// ---------- Email/get ----------

const emailGet: MethodDef = {
  cap: CAP,
  async run(ctx, args) {
    const acc = accountOf(ctx, args);
    const ids = idsOf(args)!;
    const props = propsOf(args, EMAIL_DEFAULT);
    for (const p of props) if (!(EMAIL_ALL as readonly string[]).includes(p) && !parseHeaderProp(p)) throw invalidArguments(`Unknown property ${p}`);
    const bp = args.bodyProperties;
    if (bp !== undefined && bp !== null && (!Array.isArray(bp) || bp.some((x: unknown) => typeof x !== 'string'))) throw invalidArguments('bodyProperties must be an array of strings');
    if (args.maxBodyValueBytes !== undefined && args.maxBodyValueBytes !== null && (!Number.isInteger(args.maxBodyValueBytes) || args.maxBodyValueBytes < 0)) throw invalidArguments('maxBodyValueBytes must be a non-negative integer');
    const o: GetOpts = {
      props, bodyProps: new Set(bp ?? PART_DEFAULT), fetchText: !!args.fetchTextBodyValues, fetchHtml: !!args.fetchHTMLBodyValues, fetchAll: !!args.fetchAllBodyValues,
      maxBytes: args.maxBodyValueBytes || null,
    };
    const needBody = ['bodyStructure', 'textBody', 'htmlBody', 'bodyValues'].some((p) => props.has(p));
    const needAtts = props.has('bodyStructure') || props.has('attachments');
    const db = ctx.env.DB;
    const [st, rows] = await db.batch([
      stateReadStmt(db, acc.id),
      db.prepare(`SELECT ${BASE_COLS}${needBody ? ', m.body_inline' : ''} FROM messages m WHERE m.mailbox_id = ? AND m.id IN (SELECT value FROM json_each(?))`).bind(acc.id, jsonIds(ids)),
    ]);
    const list = rows.results as unknown as EmailRow[];
    const found = list.map((r) => r.id);
    const [labels, attRes] = await Promise.all([
      props.has('mailboxIds') ? labelMap(db, found) : Promise.resolve(new Map<string, string[]>()),
      needAtts && found.length
        ? db.prepare('SELECT id, message_id, filename, mime_type, size, content_id, inline FROM attachments WHERE mailbox_id = ? AND message_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, id').bind(acc.id, jsonIds(found)).all<AttRow>()
        : Promise.resolve({ results: [] as AttRow[] }),
    ]);
    const attBy = new Map<string, AttRow[]>();
    for (const a of attRes.results) attBy.set(a.message_id, [...(attBy.get(a.message_id) ?? []), a]);
    const byId = new Map(list.map((r) => [r.id, r]));
    const out: J[] = [];
    const notFound: string[] = [];
    const bodies = new Map<string, StoredBody>();
    if (needBody) await Promise.all(list.map(async (r) => { bodies.set(r.id, await loadRowBody(ctx.env, r as unknown as Pick<MessageRow, 'body_key' | 'body_inline'>)); }));
    for (const id of new Set(ids)) {
      const r = byId.get(id);
      if (!r) notFound.push(id);
      else out.push(emailObject(r, mailboxIdsOf(r, labels.get(id)), attBy.get(id) ?? [], bodies.get(id) ?? null, o));
    }
    return { accountId: acc.id, state: String(toState(st.results[0]).email), list: out, notFound };
  },
};

// ---------- Email/query ----------

const kwSql = (alias: string, kw: string): string | null => {
  switch (kw) {
    case '$seen': return `${alias}.is_read = 1`;
    case '$flagged': return `${alias}.is_starred = 1`;
    case '$draft': return `(${alias}.direction = 'out' AND ${alias}.status IN ('draft','failed'))`;
    default: return null;
  }
};

function parseDate(v: unknown): number {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) throw invalidArguments('Invalid date in filter');
  return t;
}

function textTerms(v: unknown): { value: string; phrase: boolean }[] {
  if (typeof v !== 'string') throw invalidArguments('Filter text must be a string');
  return v.split(/\s+/).filter(Boolean).slice(0, 20).map((w) => ({ value: w, phrase: false }));
}

const like = (s: string) => '%' + s.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%';

function buildFilter(f: J, st: Structure, p: unknown[], depth = 0): string {
  if (!f || typeof f !== 'object' || Array.isArray(f) || depth > 8) throw new MethodError('unsupportedFilter', 'Unsupported filter');
  if ('operator' in f) {
    if (!['AND', 'OR', 'NOT'].includes(f.operator) || !Array.isArray(f.conditions)) throw new MethodError('unsupportedFilter', 'Bad operator');
    const parts = f.conditions.map((c: J) => buildFilter(c, st, p, depth + 1));
    if (!parts.length) return f.operator === 'OR' ? '0' : '1';
    if (f.operator === 'NOT') return `NOT (${parts.join(' OR ')})`;
    return `(${parts.join(f.operator === 'AND' ? ' AND ' : ' OR ')})`;
  }
  const c: string[] = [];
  for (const [k, v] of Object.entries(f)) {
    switch (k) {
      case 'inMailbox':
        if (typeof v !== 'string') throw invalidArguments('inMailbox must be an id');
        if (st.folders.some((x) => x.id === v)) { c.push('m.folder_id = ?'); p.push(v); }
        else if (st.labels.some((x) => x.id === v)) { c.push('EXISTS (SELECT 1 FROM message_labels fl WHERE fl.message_id = m.id AND fl.label_id = ?)'); p.push(v); }
        else c.push('0');
        break;
      case 'inMailboxOtherThan':
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw invalidArguments('inMailboxOtherThan must be an array of ids');
        c.push('(m.folder_id NOT IN (SELECT value FROM json_each(?)) OR EXISTS (SELECT 1 FROM message_labels fl WHERE fl.message_id = m.id AND fl.label_id NOT IN (SELECT value FROM json_each(?))))');
        p.push(JSON.stringify(v), JSON.stringify(v));
        break;
      case 'before': c.push('m.date < ?'); p.push(parseDate(v)); break;
      case 'after': c.push('m.date >= ?'); p.push(parseDate(v)); break;
      case 'minSize': c.push('m.size >= ?'); p.push(Number(v) || 0); break;
      case 'maxSize': c.push('m.size < ?'); p.push(Number(v) || 0); break;
      case 'hasAttachment': c.push(`m.has_attachments = ${v ? 1 : 0}`); break;
      case 'hasKeyword':
      case 'notKeyword': {
        if (typeof v !== 'string') throw invalidArguments(`${k} must be a string`);
        const s = kwSql('m', v);
        c.push(k === 'hasKeyword' ? s ?? '0' : s ? `NOT (${s})` : '1');
        break;
      }
      case 'allInThreadHaveKeyword':
      case 'someInThreadHaveKeyword':
      case 'noneInThreadHaveKeyword': {
        if (typeof v !== 'string') throw invalidArguments(`${k} must be a string`);
        const s = kwSql('x', v);
        const any = (cond: string) => `EXISTS (SELECT 1 FROM messages x WHERE x.thread_id = m.thread_id AND ${cond})`;
        if (k === 'allInThreadHaveKeyword') c.push(s ? `NOT ${any(`NOT (${s})`)}` : '0');
        else if (k === 'someInThreadHaveKeyword') c.push(s ? any(s) : '0');
        else c.push(s ? `NOT ${any(s)}` : '1');
        break;
      }
      case 'text':
      case 'body': {
        const q = buildFtsQuery(textTerms(v));
        if (!q) { c.push('0'); break; }
        c.push('m.id IN (SELECT message_id FROM messages_fts WHERE messages_fts MATCH ?)');
        p.push(k === 'body' ? `body : (${q})` : q);
        break;
      }
      case 'from':
        if (typeof v !== 'string') throw invalidArguments('from must be a string');
        c.push("(lower(m.from_email) LIKE ? ESCAPE '\\' OR lower(m.from_name) LIKE ? ESCAPE '\\')"); p.push(like(v), like(v));
        break;
      case 'to':
      case 'cc':
      case 'bcc':
        if (typeof v !== 'string') throw invalidArguments(`${k} must be a string`);
        c.push(`lower(m.${k}_json) LIKE ? ESCAPE '\\'`); p.push(like(v));
        break;
      case 'subject':
        if (typeof v !== 'string') throw invalidArguments('subject must be a string');
        c.push("lower(m.subject) LIKE ? ESCAPE '\\'"); p.push(like(v));
        break;
      default:
        throw new MethodError('unsupportedFilter', `Unsupported filter condition ${k}`);
    }
  }
  return c.length ? `(${c.join(' AND ')})` : '1';
}

const SORT_EXPR: Record<string, string> = { receivedAt: 'm.date', sentAt: 'COALESCE(m.display_date, m.date)', size: 'm.size' };

const emailQuery: MethodDef = {
  cap: CAP,
  async run(ctx, args) {
    const acc = accountOf(ctx, args);
    const db = ctx.env.DB;
    const st = await structureOf(ctx, acc.id);
    const params: unknown[] = [acc.id];
    const where = args.filter ? buildFilter(args.filter, st, params) : '1';
    if (params.length > 90) throw new MethodError('unsupportedFilter', 'Filter is too complex');
    const sorts: J[] = Array.isArray(args.sort) && args.sort.length ? args.sort : [{ property: 'receivedAt', isAscending: false }];
    const keys: string[] = [];
    const order: string[] = [];
    const rawOrder: string[] = [];
    sorts.forEach((s, i) => {
      const expr = SORT_EXPR[s?.property];
      if (!expr) throw new MethodError('unsupportedSort', `Unsupported sort ${s?.property}`);
      keys.push(`${expr} AS k${i}`);
      order.push(`k${i} ${s.isAscending === false ? 'DESC' : 'ASC'}`);
      rawOrder.push(`${expr} ${s.isAscending === false ? 'DESC' : 'ASC'}`);
    });
    const tie = sorts[0].isAscending === false ? 'DESC' : 'ASC';
    const orderBy = `${order.join(', ')}, id ${tie}`;
    const collapse = !!args.collapseThreads;
    const inner = `SELECT m.id AS id, m.thread_id AS tid, ${keys.join(', ')}${collapse ? `, ROW_NUMBER() OVER (PARTITION BY m.thread_id ORDER BY ${rawOrder.join(', ')}, m.id ${tie}) AS rn` : ''}
        FROM messages m WHERE m.mailbox_id = ? AND ${where}`;
    const source = collapse ? `(SELECT * FROM (${inner}) WHERE rn = 1)` : `(${inner})`;

    if (args.limit !== undefined && args.limit !== null && (!Number.isInteger(args.limit) || args.limit < 0)) throw invalidArguments('limit must be a non-negative integer');
    const requested = args.limit ?? LIMITS_JMAP.maxObjectsInGet;
    const limit = Math.min(requested, LIMITS_JMAP.maxObjectsInGet);
    const position = args.position === undefined || args.position === null ? 0 : args.position;
    if (!Number.isInteger(position)) throw invalidArguments('position must be an integer');
    const anchored = typeof args.anchor === 'string';
    const scan = anchored || position < 0;

    const stmts = [stateReadStmt(db, acc.id)];
    if (scan) {
      stmts.push(db.prepare(`SELECT id FROM ${source} ORDER BY ${orderBy} LIMIT ${MAX_SCAN}`).bind(...params));
    } else {
      stmts.push(db.prepare(`SELECT id FROM ${source} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).bind(...params, limit, position));
      if (args.calculateTotal) stmts.push(db.prepare(`SELECT COUNT(*) AS n FROM ${source}`).bind(...params));
    }
    const res = await db.batch(stmts);
    const state = toState(res[0].results[0]);
    let ids = (res[1].results as { id: string }[]).map((r) => r.id);
    let total: number | undefined;
    let pos = position;
    if (scan) {
      total = ids.length;
      if (anchored) {
        const i = ids.indexOf(args.anchor);
        if (i < 0) throw new MethodError('anchorNotFound');
        pos = Math.max(0, i + (Number.isInteger(args.anchorOffset) ? args.anchorOffset : 0));
      } else {
        pos = Math.max(0, total + position);
      }
      ids = ids.slice(pos, pos + limit);
    } else if (args.calculateTotal) {
      total = (res[2].results[0] as { n: number }).n;
    }
    return {
      accountId: acc.id, queryState: String(state.email), canCalculateChanges: false, position: pos, ids,
      ...(total !== undefined ? { total } : {}), ...(requested > limit ? { limit } : {}),
    };
  },
};

const cannotQueryChanges: MethodDef = {
  cap: CAP,
  async run(ctx, args) {
    accountOf(ctx, args);
    throw new MethodError('cannotCalculateChanges', 'queryChanges is not supported; re-run the query');
  },
};

// ---------- changes ----------

async function changes(ctx: Ctx, args: J, type: 'Email' | 'Thread') {
  const acc = accountOf(ctx, args);
  const db = ctx.env.DB;
  const st = await readState(db, acc.id);
  const cur = type === 'Email' ? st.email : st.thread;
  const since = parseSince(args.sinceState, cur, st.pruned);
  const max = maxChangesOf(args);
  const table = type === 'Email' ? 'messages' : 'threads';
  const [rows, tombs] = await db.batch([
    db.prepare(`SELECT id, cseq, modseq FROM ${table} WHERE mailbox_id = ? AND modseq > ? ORDER BY modseq LIMIT ?`).bind(acc.id, since, max + 1),
    db.prepare('SELECT id, modseq FROM jmap_tombstones WHERE mailbox_id = ? AND type = ? AND modseq > ? ORDER BY modseq LIMIT ?').bind(acc.id, type, since, max + 1),
  ]);
  type Ev = { id: string; modseq: number; kind: 'c' | 'u' | 'd' };
  const events: Ev[] = [
    ...(rows.results as { id: string; cseq: number; modseq: number }[]).map((r): Ev => ({ id: r.id, modseq: r.modseq, kind: r.cseq > since ? 'c' : 'u' })),
    ...(tombs.results as { id: string; modseq: number }[]).map((r): Ev => ({ id: r.id, modseq: r.modseq, kind: 'd' })),
  ].sort((a, b) => a.modseq - b.modseq);
  const hasMore = events.length > max;
  const taken = events.slice(0, max);
  const created = taken.filter((e) => e.kind === 'c').map((e) => e.id);
  const updated = taken.filter((e) => e.kind === 'u').map((e) => e.id);
  const destroyed = taken.filter((e) => e.kind === 'd').map((e) => e.id);
  const newState = hasMore ? taken[taken.length - 1].modseq : cur;
  return { accountId: acc.id, oldState: args.sinceState, newState: String(newState), hasMoreChanges: hasMore, created, updated, destroyed };
}

// ---------- Thread ----------

const threadGet: MethodDef = {
  cap: CAP,
  async run(ctx, args) {
    const acc = accountOf(ctx, args);
    const ids = idsOf(args)!;
    const db = ctx.env.DB;
    const [st, rows] = await db.batch([
      stateReadStmt(db, acc.id),
      db.prepare('SELECT thread_id, id FROM messages WHERE mailbox_id = ? AND thread_id IN (SELECT value FROM json_each(?)) ORDER BY date, id').bind(acc.id, jsonIds(ids)),
    ]);
    const by = new Map<string, string[]>();
    for (const r of rows.results as { thread_id: string; id: string }[]) by.set(r.thread_id, [...(by.get(r.thread_id) ?? []), r.id]);
    const list: J[] = [];
    const notFound: string[] = [];
    for (const id of new Set(ids)) {
      const e = by.get(id);
      if (e) list.push({ id, emailIds: e });
      else notFound.push(id);
    }
    return { accountId: acc.id, state: String(toState(st.results[0]).thread), list, notFound };
  },
};

// ---------- Email/set ----------

const KW_RE = /^[\x21-\x7e]{1,255}$/;
const FORBIDDEN_KW = /[(){\]%*"\\]/;

function checkKeywords(v: unknown): Set<string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('keywords');
  const out = new Set<string>();
  for (const [k, x] of Object.entries(v)) {
    if (x !== true || !KW_RE.test(k) || FORBIDDEN_KW.test(k)) throw new Error('keywords');
    out.add(k.toLowerCase());
  }
  return out;
}

class SetErr extends Error {
  constructor(public set: J) { super(set.type); }
}
const invalidProp = (prop: string, description: string) => new SetErr({ type: 'invalidProperties', properties: [prop], description });

interface Cur { id: string; thread_id: string; folder_id: string; status: string; direction: 'in' | 'out'; is_read: number; is_starred: number }

/** Applies a JMAP patch (full property or `property/path`) to the email's keywords and mailboxIds. */
function applyPatch(cur: Cur, curLabels: string[], patch: J): { keywords: Set<string>; mailboxIds: Record<string, true> } {
  let keywords = checkKeywords(keywordsOf({ ...cur } as EmailRow));
  let mailboxIds: Record<string, true> = { [cur.folder_id]: true, ...Object.fromEntries(curLabels.map((l) => [l, true as const])) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'keywords') {
      try { keywords = checkKeywords(v); } catch { throw invalidProp('keywords', 'keywords must map keyword names to true'); }
    } else if (k.startsWith('keywords/')) {
      const kw = k.slice(9).replace(/~1/g, '/').replace(/~0/g, '~').toLowerCase();
      if (!KW_RE.test(kw) || FORBIDDEN_KW.test(kw)) throw invalidProp(k, 'Invalid keyword');
      if (v === true) keywords.add(kw);
      else if (v === null) keywords.delete(kw);
      else throw invalidProp(k, 'Keyword values must be true or null');
    } else if (k === 'mailboxIds') {
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.values(v).some((x) => x !== true)) throw invalidProp('mailboxIds', 'mailboxIds must map ids to true');
      mailboxIds = { ...(v as Record<string, true>) };
    } else if (k.startsWith('mailboxIds/')) {
      const id = k.slice(11);
      if (v === true) mailboxIds[id] = true;
      else if (v === null) delete mailboxIds[id];
      else throw invalidProp(k, 'mailboxIds values must be true or null');
    } else {
      throw invalidProp(k, 'This property is immutable');
    }
  }
  return { keywords, mailboxIds };
}

/** Reads and validates a mailboxIds object into exactly one folder plus any labels (else invalidProperties). */
function splitMailboxIds(st: Structure, ids: Record<string, true>): { folder: string; labels: string[] } {
  const keys = Object.keys(ids);
  const folders = keys.filter((k) => st.folders.some((f) => f.id === k));
  const labels = keys.filter((k) => st.labels.some((l) => l.id === k));
  if (folders.length + labels.length !== keys.length) throw invalidProp('mailboxIds', 'Unknown mailbox id');
  if (folders.length !== 1) throw invalidProp('mailboxIds', 'An email must be in exactly one folder (plus any labels)');
  return { folder: folders[0], labels };
}

async function chunkedBatch(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
}

interface Identity { email: string; name: string }

async function identityFor(ctx: Ctx, acc: Account, from: string | null): Promise<Identity> {
  const allowed = await sendableAddresses(ctx.env.DB, acc.id);
  const email = (from ?? acc.address).toLowerCase();
  if (!allowed.has(email)) throw invalidProp('from', 'You cannot send from that address');
  return { email, name: acc.displayName || ctx.user.name };
}

const CREATE_PROPS = new Set([
  'mailboxIds', 'keywords', 'from', 'to', 'cc', 'bcc', 'replyTo', 'subject', 'sentAt', 'receivedAt', 'messageId', 'inReplyTo', 'references',
  'bodyStructure', 'bodyValues', 'textBody', 'htmlBody', 'attachments', 'sender',
]);

function addressList(v: unknown, prop: string): Address[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw invalidProp(prop, 'Expected an array of addresses');
  const out: Address[] = [];
  for (const a of v) {
    const email = typeof a?.email === 'string' ? normalizeEmail(a.email) : '';
    if (!isValidEmail(email)) throw invalidProp(prop, 'Invalid email address');
    const name = typeof a.name === 'string' ? cleanHeaderText(a.name).trim().slice(0, 200) : '';
    out.push(name ? { email, name } : { email });
  }
  return dedupeAddresses(out);
}

interface DraftAtt { id: string; key: string; filename: string; mime: string; bytes: Uint8Array; cid: string | null; inline: boolean }

async function createDraft(ctx: Ctx, acc: Account, st: Structure, obj: J, now: number): Promise<J> {
  const db = ctx.env.DB;
  for (const k of Object.keys(obj)) if (!CREATE_PROPS.has(k)) throw invalidProp(k, 'This property cannot be set');
  if (!obj.mailboxIds || typeof obj.mailboxIds !== 'object' || Object.values(obj.mailboxIds).some((x) => x !== true)) throw invalidProp('mailboxIds', 'mailboxIds is required');
  const { folder, labels } = splitMailboxIds(st, obj.mailboxIds);
  if (folder !== st.roles.drafts) throw invalidProp('mailboxIds', 'Only drafts can be created with Email/set; use Email/import for other mail');
  if (obj.keywords !== undefined) try { checkKeywords(obj.keywords); } catch { throw invalidProp('keywords', 'keywords must map keyword names to true'); }
  const from = obj.from === undefined || obj.from === null ? null : addressList(obj.from, 'from');
  if (from && from.length !== 1) throw invalidProp('from', 'Exactly one From address is required');
  const ident = await identityFor(ctx, acc, from?.[0]?.email ?? null);
  const fromName = from?.[0]?.name ?? ident.name;
  const to = addressList(obj.to, 'to'), cc = addressList(obj.cc, 'cc'), bcc = addressList(obj.bcc, 'bcc');
  if (to.length + cc.length + bcc.length > LIMITS.maxRecipients) throw invalidProp('to', `At most ${LIMITS.maxRecipients} recipients`);
  const replyTo = obj.replyTo ? addressList(obj.replyTo, 'replyTo').map((a) => a.email).join(', ') : null;
  const subject = cleanHeaderText(typeof obj.subject === 'string' ? obj.subject : '').trim().slice(0, LIMITS.maxSubject);

  // Body: bodyStructure XOR (textBody / htmlBody / attachments), text read from bodyValues.
  const values = (obj.bodyValues ?? {}) as Record<string, J>;
  let text: string | null = null, html: string | null = null;
  const attParts: J[] = [];
  const valueOf = (p: J): string => {
    const v = values[p?.partId];
    if (typeof v?.value !== 'string') throw invalidProp('bodyValues', `No bodyValues entry for part ${p?.partId}`);
    return v.value;
  };
  const walk = (p: J) => {
    if (!p || typeof p !== 'object') return;
    if (Array.isArray(p.subParts)) { p.subParts.forEach(walk); return; }
    const type = String(p.type ?? '').toLowerCase();
    if (typeof p.blobId === 'string' && (p.disposition === 'attachment' || p.disposition === 'inline' || !(type === 'text/plain' || type === 'text/html') || !p.partId)) attParts.push(p);
    else if (type === 'text/html') html = html === null ? valueOf(p) : html;
    else if (type === 'text/plain' || type === '') text = text === null ? valueOf(p) : text;
  };
  if (obj.bodyStructure) {
    if (obj.textBody || obj.htmlBody || obj.attachments) throw invalidProp('bodyStructure', 'bodyStructure cannot be combined with textBody, htmlBody or attachments');
    walk(obj.bodyStructure);
  } else {
    for (const p of obj.textBody ?? []) text = valueOf(p);
    for (const p of obj.htmlBody ?? []) html = valueOf(p);
    for (const p of obj.attachments ?? []) attParts.push(p);
  }
  if (html === null && text === null) text = '';
  const textOut: string = text ?? htmlToText(html ?? '');
  const bytes = (s: string | null) => (s ? byteLen(s) : 0);
  if (bytes(html) + bytes(textOut) > 10 * 1024 * 1024) throw new SetErr({ type: 'tooLarge' });
  if (attParts.length > LIMITS.maxAttachments) throw new SetErr({ type: 'tooLarge', description: `At most ${LIMITS.maxAttachments} attachments` });

  const atts: DraftAtt[] = [];
  let total = bytes(html) + bytes(textOut);
  for (const p of attParts) {
    if (typeof p.blobId !== 'string' || !parseBlobId(p.blobId)) throw new SetErr({ type: 'blobNotFound', notFound: [String(p.blobId)] });
    const blob = await loadBlob(ctx.env, acc.id, p.blobId);
    if (!blob) throw new SetErr({ type: 'blobNotFound', notFound: [p.blobId] });
    total += blob.bytes.byteLength;
    if (total > LIMITS.maxMessageBytes) throw new SetErr({ type: 'tooLarge', description: 'Message exceeds 25 MiB' });
    const aid = ulid(now);
    atts.push({
      id: aid, key: `att/${acc.id}/${aid}`, bytes: blob.bytes,
      filename: String(p.name ?? blob.name ?? 'attachment').replace(/[\r\n"\\/]/g, '_').slice(0, 255),
      mime: String(p.type ?? blob.type).toLowerCase().slice(0, 200) || 'application/octet-stream',
      cid: typeof p.cid === 'string' ? p.cid.replace(/^<|>$/g, '').slice(0, 300) : null, inline: p.disposition === 'inline',
    });
  }

  // Threading: a draft replying to a message we hold joins its thread.
  const inReplyTo = Array.isArray(obj.inReplyTo) ? obj.inReplyTo.filter((x: unknown) => typeof x === 'string').map((x: string) => `<${x.replace(/[<>\s]/g, '')}>`) : [];
  const refs = Array.isArray(obj.references) ? obj.references.filter((x: unknown) => typeof x === 'string').map((x: string) => `<${x.replace(/[<>\s]/g, '')}>`) : [];
  let parent: { id: string; thread_id: string; references_hdr: string | null } | null = null;
  const lookup = [...new Set([...inReplyTo, ...refs])].slice(0, 50);
  if (lookup.length) {
    parent = await db.prepare(
      `SELECT id, thread_id, references_hdr FROM messages WHERE mailbox_id = ? AND message_id_hdr IN (SELECT value FROM json_each(?))
        ORDER BY direction = 'out' DESC, created_at LIMIT 1`,
    ).bind(acc.id, JSON.stringify(lookup)).first();
  }
  const id = ulid(now);
  const threadId = parent?.thread_id ?? ulid(now);
  const inReplyHdr = inReplyTo[0] ?? null;
  const refsHdr = (refs.length ? refs : [...(parent?.references_hdr ?? '').split(/\s+/).filter(Boolean), ...inReplyTo]).slice(-50);
  const bodyKey = `body/${acc.id}/${id}.json`;
  await Promise.all([
    ctx.env.BUCKET.put(bodyKey, JSON.stringify({ html, text: textOut }), { httpMetadata: { contentType: 'application/json' } }),
    ...atts.map((a) => ctx.env.BUCKET.put(a.key, a.bytes, { httpMetadata: { contentType: a.mime } })),
  ]);
  const stmts: D1PreparedStatement[] = [];
  if (!parent) {
    stmts.push(db.prepare('INSERT INTO threads (id, mailbox_id, subject, subject_norm, last_message_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(threadId, acc.id, subject, normalizeSubject(subject), now, now));
  }
  stmts.push(db.prepare(
    `INSERT INTO messages (id, mailbox_id, thread_id, folder_id, direction, status, in_reply_to, references_hdr, parent_id, compose_mode,
       from_email, from_name, to_json, cc_json, bcc_json, reply_to, subject, snippet, body_key, body_inline, size, has_attachments, is_read, date, created_at, updated_at, folder_changed_at)
     VALUES (?, ?, ?, ?, 'out', 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).bind(id, acc.id, threadId, folder, inReplyHdr, refsHdr.length ? refsHdr.join(' ') : null, parent?.id ?? null, parent ? 'reply' : 'new',
    ident.email, fromName, JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), replyTo, subject, makeSnippet(textOut), bodyKey,
    inlineBodyJson(html, textOut), total, atts.some((a) => !a.inline) ? 1 : 0, now, now, now, now));
  for (const a of atts) {
    stmts.push(db.prepare('INSERT INTO attachments (id, message_id, mailbox_id, filename, mime_type, size, content_id, inline, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(a.id, id, acc.id, a.filename, a.mime, a.bytes.byteLength, a.cid, a.inline ? 1 : 0, a.key, now));
  }
  for (const l of labels) stmts.push(db.prepare('INSERT OR IGNORE INTO message_labels (message_id, label_id) SELECT ?, id FROM labels WHERE id = ? AND mailbox_id = ?').bind(id, l, acc.id));
  stmts.push(...ftsInsertStmts(db, { id, mailboxId: acc.id, subject, addresses: addressesForFts({ email: ident.email, name: fromName }, to, cc, bcc), body: textOut }));
  stmts.push(...recomputeThreadStmts(db, threadId));
  try {
    await db.batch(stmts);
  } catch (e) {
    await ctx.env.BUCKET.delete([bodyKey, ...atts.map((a) => a.key)]).catch(() => undefined);
    throw e;
  }
  return { id, blobId: blobId('m', id), threadId, size: total };
}

/** Email/set update + destroy bookkeeping shared by Email/set and EmailSubmission's onSuccess* actions. */
export async function setEmails(ctx: Ctx, acc: Account, args: { update?: Record<string, J>; destroy?: string[]; create?: Record<string, J> }) {
  const db = ctx.env.DB;
  const st = await structureOf(ctx, acc.id);
  const update = args.update ?? {};
  const destroy = args.destroy ?? [];
  const create = args.create ?? {};
  const created: Record<string, J> = {}, notCreated: Record<string, J> = {};
  const updated: Record<string, J> = {}, notUpdated: Record<string, J> = {};
  const destroyed: string[] = [];
  const notDestroyed: Record<string, J> = {};
  const now = Date.now();

  for (const [cid, obj] of Object.entries(create)) {
    try {
      created[cid] = await createDraft(ctx, acc, st, obj, now);
    } catch (e) {
      if (e instanceof SetErr) notCreated[cid] = e.set;
      else {
        console.error('jmap create failed', (e as Error).name);
        notCreated[cid] = { type: 'serverFail' };
      }
    }
  }

  const ids = [...new Set([...Object.keys(update), ...destroy])];
  const curRows = new Map<string, Cur>();
  let labelsOf = new Map<string, string[]>();
  if (ids.length) {
    const { results } = await db.prepare(
      'SELECT id, thread_id, folder_id, status, direction, is_read, is_starred FROM messages WHERE mailbox_id = ? AND id IN (SELECT value FROM json_each(?))',
    ).bind(acc.id, jsonIds(ids)).all<Cur>();
    for (const r of results) curRows.set(r.id, r);
    labelsOf = await labelMap(db, [...curRows.keys()]);
  }

  const stmts: D1PreparedStatement[] = [];
  const threads = new Set<string>();
  for (const [id, patch] of Object.entries(update)) {
    const cur = curRows.get(id);
    if (!cur) { notUpdated[id] = { type: 'notFound' }; continue; }
    try {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalidProp('update', 'Patch must be an object');
      const curLabels = labelsOf.get(id) ?? [];
      const next = applyPatch(cur, curLabels, patch);
      const target = splitMailboxIds(st, next.mailboxIds);
      const outbox = OUTBOX.has(cur.status);
      const read = next.keywords.has('$seen') ? 1 : 0;
      const star = outbox ? cur.is_starred : next.keywords.has('$flagged') ? 1 : 0;
      if (read !== cur.is_read || star !== cur.is_starred) {
        stmts.push(db.prepare('UPDATE messages SET is_read = ?, is_starred = ?, updated_at = ? WHERE id = ? AND mailbox_id = ?').bind(read, star, now, id, acc.id));
      }
      if (target.folder !== cur.folder_id) {
        const role = st.folders.find((f) => f.id === target.folder)?.role ?? null;
        if (role === 'drafts' || role === 'scheduled') throw invalidProp('mailboxIds', 'Messages cannot be moved there');
        if (role === 'spam' && cur.direction !== 'in') throw invalidProp('mailboxIds', 'Only received mail can be marked as junk');
        if (cur.status === 'sending') throw new SetErr({ type: 'forbidden', description: 'The message is being sent' });
        if (outbox && role !== 'trash') throw invalidProp('mailboxIds', 'Drafts and scheduled messages can only be moved to Trash');
        // Trashing a scheduled message cancels the send, as in the Cirrus API.
        if (cur.status === 'scheduled') stmts.push(db.prepare("UPDATE messages SET status = 'draft', send_at = NULL WHERE id = ? AND mailbox_id = ? AND status = 'scheduled'").bind(id, acc.id));
        stmts.push(db.prepare('UPDATE messages SET folder_id = ?, folder_changed_at = ?, updated_at = ? WHERE id = ? AND mailbox_id = ?').bind(target.folder, now, now, id, acc.id));
        stmts.push(db.prepare('UPDATE threads SET snoozed_until = NULL WHERE id = ? AND mailbox_id = ?').bind(cur.thread_id, acc.id));
      }
      for (const l of target.labels.filter((x) => !curLabels.includes(x))) {
        stmts.push(db.prepare('INSERT OR IGNORE INTO message_labels (message_id, label_id) SELECT ?, id FROM labels WHERE id = ? AND mailbox_id = ?').bind(id, l, acc.id));
      }
      for (const l of curLabels.filter((x) => !target.labels.includes(x))) {
        stmts.push(db.prepare('DELETE FROM message_labels WHERE message_id = ? AND label_id = ?').bind(id, l));
      }
      threads.add(cur.thread_id);
      updated[id] = null;
    } catch (e) {
      if (e instanceof SetErr) notUpdated[id] = e.set;
      else throw e;
    }
  }

  const forever: string[] = [];
  for (const id of destroy) {
    const cur = curRows.get(id);
    if (!cur) { notDestroyed[id] = { type: 'notFound' }; continue; }
    if (cur.status === 'scheduled' || cur.status === 'sending') { notDestroyed[id] = { type: 'forbidden', description: 'The message is scheduled or being sent' }; continue; }
    const role = st.folders.find((f) => f.id === cur.folder_id)?.role;
    // A draft in Drafts is deleted outright, not parked in Trash.
    if (role === 'trash' || role === 'spam' || (role === 'drafts' && cur.status === 'draft')) forever.push(id);
    else {
      // Cirrus semantics (threads/actions "trash"): not yet in Trash means it goes to Trash.
      stmts.push(db.prepare('UPDATE messages SET folder_id = ?, folder_changed_at = ?, updated_at = ? WHERE id = ? AND mailbox_id = ?').bind(st.roles.trash, now, now, id, acc.id));
      threads.add(cur.thread_id);
    }
    destroyed.push(id);
  }
  for (const t of threads) stmts.push(...recomputeThreadStmts(db, t, acc.id));
  await chunkedBatch(db, stmts);
  if (forever.length) await deleteMessagesForever(ctx.env, acc.id, forever);
  return { created, notCreated, updated, notUpdated, destroyed, notDestroyed };
}

const emailSet: MethodDef = {
  cap: CAP,
  async run(ctx, args) {
    const acc = accountOf(ctx, args);
    const before = await readState(ctx.env.DB, acc.id);
    if (args.ifInState !== undefined && args.ifInState !== null && args.ifInState !== String(before.email)) throw new MethodError('stateMismatch');
    const create = args.create ?? {}, update = args.update ?? {}, destroy = args.destroy ?? [];
    for (const [n, v] of [['create', create], ['update', update]] as const) if (typeof v !== 'object' || Array.isArray(v)) throw invalidArguments(`${n} must be an object`);
    if (!Array.isArray(destroy) || destroy.some((d: unknown) => typeof d !== 'string')) throw invalidArguments('destroy must be an array of ids');
    if (Object.keys(create).length + Object.keys(update).length + destroy.length > LIMITS_JMAP.maxObjectsInSet) throw new MethodError('requestTooLarge');
    const r = await setEmails(ctx, acc, { create, update, destroy });
    const after = await readState(ctx.env.DB, acc.id);
    const none = (o: object) => (Object.keys(o).length ? o : null);
    return {
      accountId: acc.id, oldState: String(before.email), newState: String(after.email), created: none(r.created), updated: none(r.updated),
      destroyed: r.destroyed.length ? r.destroyed : null, notCreated: none(r.notCreated), notUpdated: none(r.notUpdated), notDestroyed: none(r.notDestroyed),
    };
  },
};

// ---------- Email/import ----------

async function importOne(ctx: Ctx, acc: Account, st: Structure, obj: J, now: number): Promise<J> {
  const db = ctx.env.DB;
  if (typeof obj?.blobId !== 'string' || !obj.mailboxIds) throw invalidProp('blobId', 'blobId and mailboxIds are required');
  const { folder, labels } = splitMailboxIds(st, obj.mailboxIds);
  let kw: Set<string>;
  try { kw = obj.keywords === undefined || obj.keywords === null ? new Set() : checkKeywords(obj.keywords); } catch { throw invalidProp('keywords', 'Invalid keywords'); }
  const role = st.folders.find((f) => f.id === folder)?.role;
  if (role === 'scheduled') throw invalidProp('mailboxIds', 'Messages cannot be imported there');
  const blob = parseBlobId(obj.blobId) ? await loadBlob(ctx.env, acc.id, obj.blobId) : null;
  if (!blob) throw new SetErr({ type: 'blobNotFound', notFound: [obj.blobId] });
  if (blob.bytes.byteLength > LIMITS.maxMessageBytes) throw new SetErr({ type: 'tooLarge', description: 'Message exceeds 25 MiB' });
  let email;
  try { email = await PostalMime.parse(blob.bytes, { attachmentEncoding: 'arraybuffer' }); } catch { throw new SetErr({ type: 'invalidEmail' }); }

  const own = await sendableAddresses(db, acc.id);
  const from: Address = fromParsed(email.from)[0] ?? { email: '' };
  const to = dedupeAddresses(fromParsed(email.to)), cc = dedupeAddresses(fromParsed(email.cc));
  const subject = (email.subject ?? '').slice(0, LIMITS.maxSubject);
  const text = email.text ?? (email.html ? htmlToText(email.html) : '');
  const html = email.html ?? null;
  const headerDate = email.date ? Date.parse(email.date) : NaN;
  const recv = typeof obj.receivedAt === 'string' && Number.isFinite(Date.parse(obj.receivedAt)) ? Date.parse(obj.receivedAt) : Number.isFinite(headerDate) ? headerDate : now;
  const shown = Number.isFinite(headerDate) ? headerDate : recv;
  const msgId = parseMessageIds(email.messageId)[0] ?? null;
  const inReplyTo = parseMessageIds(email.inReplyTo), references = parseMessageIds(email.references);
  const subjectNorm = normalizeSubject(subject);
  const existing = await findThread(db, {
    mailboxId: acc.id, inReplyTo, references, subjectNorm, participants: [from.email, ...to.map((a) => a.email), ...cc.map((a) => a.email)].map((e) => e.toLowerCase()), ownAddresses: own, now,
  });
  const direction = role === 'sent' || role === 'drafts' ? 'out' : 'in';
  const status = role === 'sent' ? 'sent' : role === 'drafts' ? 'draft' : 'received';
  const id = ulid(now), threadId = existing ?? ulid(now);
  const rawKey = `raw/${acc.id}/${id}.eml`, bodyKey = `body/${acc.id}/${id}.json`;
  const attList = email.attachments.slice(0, 100).map((a) => {
    const aid = ulid(now);
    const b = typeof a.content === 'string' ? enc.encode(a.content) : new Uint8Array(a.content as ArrayBuffer);
    return {
      id: aid, bytes: b, key: `att/${acc.id}/${aid}`, filename: (a.filename || 'attachment').replace(/[\r\n]/g, ' ').slice(0, 255),
      mime: (a.mimeType || 'application/octet-stream').toLowerCase().slice(0, 200), cid: a.contentId ? a.contentId.replace(/^<|>$/g, '').slice(0, 300) : null,
      inline: !!a.contentId && (a.disposition === 'inline' || !!a.related) ? 1 : 0,
    };
  });
  await Promise.all([
    ctx.env.BUCKET.put(rawKey, blob.bytes, { httpMetadata: { contentType: 'message/rfc822' } }),
    ctx.env.BUCKET.put(bodyKey, JSON.stringify({ html, text }), { httpMetadata: { contentType: 'application/json' } }),
    ...attList.map((a) => ctx.env.BUCKET.put(a.key, a.bytes, { httpMetadata: { contentType: a.mime } })),
  ]);
  const stmts: D1PreparedStatement[] = [];
  if (!existing) {
    stmts.push(db.prepare('INSERT INTO threads (id, mailbox_id, subject, subject_norm, last_message_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(threadId, acc.id, subject, subjectNorm, recv, now));
  }
  const read = kw.has('$seen') || direction === 'out' ? 1 : 0;
  stmts.push(db.prepare(
    `INSERT INTO messages (id, mailbox_id, thread_id, folder_id, direction, status, message_id_hdr, in_reply_to, references_hdr, from_email, from_name,
       to_json, cc_json, bcc_json, reply_to, subject, snippet, body_key, body_inline, raw_key, size, has_attachments, is_read, is_starred, date, display_date,
       created_at, updated_at, folder_changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, acc.id, threadId, folder, direction, status, msgId, inReplyTo[0] ?? null, references.length ? references.join(' ').slice(0, 8000) : null,
    from.email, from.name ?? '', JSON.stringify(to), JSON.stringify(cc), email.replyTo?.length ? fromParsed(email.replyTo).map((a) => a.email).join(', ') : null,
    subject, makeSnippet(text), bodyKey, inlineBodyJson(html, text), rawKey, blob.bytes.byteLength, attList.some((a) => !a.inline) ? 1 : 0,
    read, kw.has('$flagged') ? 1 : 0, recv, shown, now, now, now));
  for (const a of attList) {
    stmts.push(db.prepare('INSERT INTO attachments (id, message_id, mailbox_id, filename, mime_type, size, content_id, inline, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(a.id, id, acc.id, a.filename, a.mime, a.bytes.byteLength, a.cid, a.inline, a.key, now));
  }
  for (const l of labels) stmts.push(db.prepare('INSERT OR IGNORE INTO message_labels (message_id, label_id) SELECT ?, id FROM labels WHERE id = ? AND mailbox_id = ?').bind(id, l, acc.id));
  stmts.push(...ftsInsertStmts(db, { id, mailboxId: acc.id, subject, addresses: addressesForFts(from, to, cc), body: text }));
  stmts.push(...recomputeThreadStmts(db, threadId));
  try {
    await db.batch(stmts);
  } catch (e) {
    await ctx.env.BUCKET.delete([rawKey, bodyKey, ...attList.map((a) => a.key)]).catch(() => undefined);
    throw e;
  }
  return { id, blobId: blobId('m', id), threadId, size: blob.bytes.byteLength };
}

const emailImport: MethodDef = {
  cap: CAP,
  async run(ctx, args) {
    const acc = accountOf(ctx, args);
    const emails = args.emails;
    if (!emails || typeof emails !== 'object' || Array.isArray(emails)) throw invalidArguments('emails must be an object');
    if (Object.keys(emails).length > LIMITS_JMAP.maxObjectsInSet) throw new MethodError('requestTooLarge');
    const db = ctx.env.DB;
    const before = await readState(db, acc.id);
    if (args.ifInState !== undefined && args.ifInState !== null && args.ifInState !== String(before.email)) throw new MethodError('stateMismatch');
    const st = await structureOf(ctx, acc.id);
    const created: Record<string, J> = {}, notCreated: Record<string, J> = {};
    for (const [cid, obj] of Object.entries(emails)) {
      try {
        created[cid] = await importOne(ctx, acc, st, obj, Date.now());
      } catch (e) {
        if (e instanceof SetErr) notCreated[cid] = e.set;
        else {
          console.error('jmap import failed', (e as Error).name);
          notCreated[cid] = { type: 'serverFail' };
        }
      }
    }
    const after = await readState(db, acc.id);
    const none = (o: object) => (Object.keys(o).length ? o : null);
    return { accountId: acc.id, oldState: String(before.email), newState: String(after.email), created: none(created), notCreated: none(notCreated) };
  },
};

// ---------- SearchSnippet/get ----------

function filterTerms(f: J, out: string[] = []): string[] {
  if (!f || typeof f !== 'object') return out;
  if (Array.isArray(f.conditions)) {
    if (f.operator !== 'NOT') f.conditions.forEach((c: J) => filterTerms(c, out));
    return out;
  }
  for (const k of ['text', 'subject', 'body']) if (typeof f[k] === 'string') out.push(...f[k].split(/\s+/).filter(Boolean));
  return out;
}

const searchSnippetGet: MethodDef = {
  cap: CAP,
  async run(ctx, args) {
    const acc = accountOf(ctx, args);
    const ids = args.emailIds;
    if (!Array.isArray(ids) || ids.some((i: unknown) => typeof i !== 'string')) throw invalidArguments('emailIds must be an array of ids');
    if (ids.length > LIMITS_JMAP.maxObjectsInGet) throw new MethodError('requestTooLarge');
    const terms = [...new Set(filterTerms(args.filter).map((t) => t.toLowerCase()))].slice(0, 10);
    const re = terms.length ? new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi') : null;
    const mark = (s: string) => {
      const esc = escapeHtml(s);
      return re ? esc.replace(re, '<mark>$1</mark>') : esc;
    };
    const { results } = await ctx.env.DB.prepare('SELECT id, subject, snippet FROM messages WHERE mailbox_id = ? AND id IN (SELECT value FROM json_each(?))').bind(acc.id, jsonIds(ids)).all<{ id: string; subject: string; snippet: string }>();
    const by = new Map(results.map((r) => [r.id, r]));
    const list: J[] = [];
    const notFound: string[] = [];
    for (const id of ids) {
      const r = by.get(id);
      if (!r) notFound.push(id);
      else list.push({ emailId: id, subject: re && re.test(r.subject) ? mark(r.subject) : null, preview: re && (re.lastIndex = 0, re.test(r.snippet)) ? mark(r.snippet) : null });
      if (re) re.lastIndex = 0;
    }
    return { accountId: acc.id, list, notFound };
  },
};

export const emailMethods: Record<string, MethodDef> = {
  'Email/get': emailGet,
  'Email/query': emailQuery,
  'Email/queryChanges': cannotQueryChanges,
  'Email/changes': { cap: CAP, run: (ctx, args) => changes(ctx, args, 'Email') },
  'Email/set': emailSet,
  'Email/import': emailImport,
  'Thread/get': threadGet,
  'Thread/changes': { cap: CAP, run: (ctx, args) => changes(ctx, args, 'Thread') },
  'SearchSnippet/get': searchSnippetGet,
};

export { ftsQuote };
