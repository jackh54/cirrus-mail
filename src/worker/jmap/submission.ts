// Identity/get, EmailSubmission/set and VacationResponse/get+set.
import { ulid } from '../../shared/ulid';
import { sha256Hex } from '../lib/crypto';
import { parseJsonAddresses } from '../lib/addresses';
import { HttpError } from '../lib/errors';
import { htmlToText } from '../lib/html';
import type { MessageRow } from '../lib/db';
import { cleanHeaderText } from '../lib/validate';
import { claimForSend, performSend, validateDraft } from '../outbound/send';
import {
  accountOf, idsOf, invalidArguments, isoUtc, jsonIds, LIMITS_JMAP, MethodError, propsOf, readState,
  type Account, type Ctx, type J, type MethodDef,
} from './core';
import { setEmails } from './email';

interface Identity { id: string; name: string; email: string; signature: string; mayDelete: false }

async function identitiesOf(ctx: Ctx, acc: Account): Promise<{ list: Identity[]; state: string }> {
  const db = ctx.env.DB;
  const [mb, al] = await db.batch([
    db.prepare('SELECT display_name, signature_html FROM mailboxes WHERE id = ?').bind(acc.id),
    db.prepare('SELECT id, address FROM aliases WHERE mailbox_id = ? AND can_send = 1 ORDER BY created_at, id').bind(acc.id),
  ]);
  const m = mb.results[0] as { display_name: string; signature_html: string };
  const name = m.display_name || ctx.user.name;
  const list: Identity[] = [
    { id: acc.id, name, email: acc.address, signature: m.signature_html, mayDelete: false },
    ...(al.results as { id: string; address: string }[]).map((a): Identity => ({ id: a.id, name, email: a.address, signature: m.signature_html, mayDelete: false })),
  ];
  return { list, state: (await sha256Hex(JSON.stringify(list))).slice(0, 16) };
}

const IDENTITY_PROPS = ['id', 'name', 'email', 'replyTo', 'bcc', 'textSignature', 'htmlSignature', 'mayDelete'] as const;

const identityGet: MethodDef = {
  cap: 'urn:ietf:params:jmap:submission',
  async run(ctx, args) {
    const acc = accountOf(ctx, args);
    const ids = idsOf(args, true);
    const props = propsOf(args, IDENTITY_PROPS);
    const { list, state } = await identitiesOf(ctx, acc);
    const want = ids ?? list.map((i) => i.id);
    const out: J[] = [];
    const notFound: string[] = [];
    for (const id of want) {
      const i = list.find((x) => x.id === id);
      if (!i) { notFound.push(id); continue; }
      const full: J = {
        id: i.id, name: i.name, email: i.email, replyTo: null, bcc: null,
        textSignature: i.signature ? htmlToText(i.signature) : '', htmlSignature: i.signature, mayDelete: false,
      };
      out.push(Object.fromEntries(Object.entries(full).filter(([k]) => props.has(k))));
    }
    return { accountId: acc.id, state, list: out, notFound };
  },
};

const identityChanges: MethodDef = {
  cap: 'urn:ietf:params:jmap:submission',
  async run(ctx, args) {
    const acc = accountOf(ctx, args);
    const { state } = await identitiesOf(ctx, acc);
    if (args.sinceState === state) {
      return { accountId: acc.id, oldState: state, newState: state, hasMoreChanges: false, created: [], updated: [], destroyed: [] };
    }
    throw new MethodError('cannotCalculateChanges', 'Identities are small; refetch them');
  },
};

// ---------- EmailSubmission ----------

function sendFailure(code: string, message: string): J {
  if (code === 'E_RATE_LIMIT_EXCEEDED' || code === 'E_DAILY_LIMIT_EXCEEDED') return { type: 'forbiddenToSend', description: message };
  if (code === 'E_TOO_MANY_RECIPIENTS') return { type: 'tooManyRecipients', description: message };
  if (code === 'E_SENDER_NOT_VERIFIED') return { type: 'forbiddenFrom', description: message };
  return { type: 'serverFail', description: message };
}

const submissionSet: MethodDef = {
  cap: 'urn:ietf:params:jmap:submission',
  async run(ctx, args) {
    const acc = accountOf(ctx, args);
    const db = ctx.env.DB;
    const create = (args.create ?? {}) as Record<string, J>;
    if (typeof create !== 'object' || Array.isArray(create)) throw invalidArguments('create must be an object');
    if (args.update && Object.keys(args.update).length) throw invalidArguments('EmailSubmissions are immutable');
    if (Object.keys(create).length > LIMITS_JMAP.maxObjectsInSet) throw new MethodError('requestTooLarge');
    const { list: idents, state } = await identitiesOf(ctx, acc);
    if (args.ifInState !== undefined && args.ifInState !== null && args.ifInState !== state) throw new MethodError('stateMismatch');
    const created: Record<string, J> = {};
    const notCreated: Record<string, J> = {};
    const sentEmail = new Map<string, string>();   // creation id -> email id

    for (const [cid, obj] of Object.entries(create)) {
      const bad = (p: string, d: string) => { notCreated[cid] = { type: 'invalidProperties', properties: [p], description: d }; };
      if (typeof obj?.emailId !== 'string') { bad('emailId', 'emailId is required'); continue; }
      const ident = idents.find((i) => i.id === obj.identityId);
      if (!ident) { bad('identityId', 'Unknown identity'); continue; }
      const row = await db.prepare('SELECT * FROM messages WHERE id = ? AND mailbox_id = ?').bind(obj.emailId, acc.id).first<MessageRow>();
      if (!row || row.direction !== 'out') { bad('emailId', 'No such draft'); continue; }
      if (row.status !== 'draft' && row.status !== 'failed') { bad('emailId', 'This message is not a draft (it may already be sent or scheduled)'); continue; }
      if (row.from_email.toLowerCase() !== ident.email.toLowerCase()) { notCreated[cid] = { type: 'forbiddenFrom', description: 'The identity does not match the From address' }; continue; }
      if (obj.envelope) {
        // Cirrus always sends to the message's own recipients; an envelope is accepted only when it says the same.
        const rcpt = new Set<string>((obj.envelope.rcptTo ?? []).map((r: J) => String(r?.email).toLowerCase()));
        const mine = new Set([...parseJsonAddresses(row.to_json), ...parseJsonAddresses(row.cc_json), ...parseJsonAddresses(row.bcc_json)].map((a) => a.email.toLowerCase()));
        if (rcpt.size !== mine.size || [...rcpt].some((r) => !mine.has(r))) { bad('envelope', 'Custom envelopes are not supported'); continue; }
      }
      try {
        await validateDraft(db, row);
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        const type = e.code === 'INVALID_FROM' ? 'forbiddenFrom' : e.code === 'NO_RECIPIENTS' ? 'noRecipients' : e.code === 'TOO_MANY_RECIPIENTS' ? 'tooManyRecipients' : 'invalidProperties';
        notCreated[cid] = { type, description: e.message };
        continue;
      }
      const claimed = await claimForSend(db, row.id, ['draft', 'failed']);
      if (!claimed) { bad('emailId', 'This message is already being sent'); continue; }
      // The existing pipeline: send counting (send_counts), send_log, contacts and the move to Sent all happen in here.
      const result = await performSend(ctx.env, claimed, [ctx.user.id]);
      if (!result.ok) { notCreated[cid] = sendFailure(result.code, result.message); continue; }
      const id = ulid();
      created[cid] = { id, threadId: row.thread_id, undoStatus: 'final', sendAt: isoUtc(Date.now()) };
      sentEmail.set(cid, row.id);
    }

    const out: [string, J][] = [];
    const none = (o: object) => (Object.keys(o).length ? o : null);
    out.push(['EmailSubmission/set', {
      accountId: acc.id, oldState: state, newState: state, created: none(created), updated: null, destroyed: null,
      notCreated: none(notCreated), notUpdated: null, notDestroyed: null,
    }]);

    // Implicit Email/set for onSuccessUpdateEmail / onSuccessDestroyEmail (keys are creation ids, "#sub1", or email ids).
    const toEmail = (k: string) => (k.startsWith('#') ? sentEmail.get(k.slice(1)) : [...sentEmail.values()].includes(k) ? k : undefined);
    const update: Record<string, J> = {};
    for (const [k, patch] of Object.entries((args.onSuccessUpdateEmail ?? {}) as Record<string, J>)) {
      const id = toEmail(k);
      if (id) update[id] = patch;
    }
    const destroy: string[] = [];
    for (const k of (args.onSuccessDestroyEmail ?? []) as string[]) {
      const id = typeof k === 'string' ? toEmail(k) : undefined;
      if (id) destroy.push(id);
    }
    if (Object.keys(update).length || destroy.length) {
      const emailBefore = await readState(db, acc.id);
      const r = await setEmails(ctx, acc, { update, destroy });
      const after = await readState(db, acc.id);
      out.push(['Email/set', {
        accountId: acc.id, oldState: String(emailBefore.email), newState: String(after.email), created: null,
        updated: none(r.updated), destroyed: r.destroyed.length ? r.destroyed : null, notCreated: null, notUpdated: none(r.notUpdated), notDestroyed: none(r.notDestroyed),
      }]);
    }
    return out;
  },
};

// ---------- VacationResponse ----------

interface VacRow {
  autoreply_enabled: number; autoreply_subject: string; autoreply_body: string; autoreply_start: number | null; autoreply_end: number | null;
}

const VAC_PROPS = ['id', 'isEnabled', 'fromDate', 'toDate', 'subject', 'textBody', 'htmlBody'] as const;

async function vacation(db: D1Database, mb: string) {
  const r = (await db.prepare('SELECT autoreply_enabled, autoreply_subject, autoreply_body, autoreply_start, autoreply_end FROM mailboxes WHERE id = ?').bind(mb).first<VacRow>())!;
  const obj = {
    id: 'singleton', isEnabled: !!r.autoreply_enabled,
    fromDate: r.autoreply_start === null ? null : isoUtc(r.autoreply_start), toDate: r.autoreply_end === null ? null : isoUtc(r.autoreply_end),
    subject: r.autoreply_subject || null, textBody: r.autoreply_body || null, htmlBody: null,
  };
  return { obj, state: (await sha256Hex(JSON.stringify(obj))).slice(0, 16) };
}

const vacationGet: MethodDef = {
  cap: 'urn:ietf:params:jmap:vacationresponse',
  async run(ctx, args) {
    const acc = accountOf(ctx, args);
    const props = propsOf(args, VAC_PROPS);
    const ids = idsOf(args, true);
    const { obj, state } = await vacation(ctx.env.DB, acc.id);
    const want = ids ?? ['singleton'];
    return {
      accountId: acc.id, state,
      list: want.includes('singleton') ? [Object.fromEntries(Object.entries(obj).filter(([k]) => props.has(k)))] : [],
      notFound: want.filter((i) => i !== 'singleton'),
    };
  },
};

function vacDate(v: unknown): number | null {
  if (v === null) return null;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) throw new Error('date');
  return t;
}

const vacationSet: MethodDef = {
  cap: 'urn:ietf:params:jmap:vacationresponse',
  async run(ctx, args) {
    const acc = accountOf(ctx, args);
    const db = ctx.env.DB;
    const { state: oldState } = await vacation(db, acc.id);
    if (args.ifInState !== undefined && args.ifInState !== null && args.ifInState !== oldState) throw new MethodError('stateMismatch');
    if (args.create && Object.keys(args.create).length) {
      return { accountId: acc.id, oldState, newState: oldState, created: null, updated: null, destroyed: null, notCreated: Object.fromEntries(Object.keys(args.create).map((k) => [k, { type: 'singleton' }])), notUpdated: null, notDestroyed: null };
    }
    const updated: Record<string, J> = {};
    const notUpdated: Record<string, J> = {};
    for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, J>)) {
      if (id !== 'singleton') { notUpdated[id] = { type: 'notFound' }; continue; }
      const { obj } = await vacation(db, acc.id);
      const next: J = { ...obj };
      try {
        for (const [k, v] of Object.entries(patch as Record<string, J>)) {
          if (!['isEnabled', 'fromDate', 'toDate', 'subject', 'textBody', 'htmlBody'].includes(k)) throw new Error(k);
          next[k] = v;
        }
        if (typeof next.isEnabled !== 'boolean') throw new Error('isEnabled');
        const start = vacDate(next.fromDate), end = vacDate(next.toDate);
        if (next.subject !== null && (typeof next.subject !== 'string' || next.subject.length > 200)) throw new Error('subject');
        let body = next.textBody;
        if (body === null && typeof next.htmlBody === 'string') body = htmlToText(next.htmlBody);
        if (body !== null && (typeof body !== 'string' || body.length > 10_000)) throw new Error('textBody');
        await db.prepare('UPDATE mailboxes SET autoreply_enabled = ?, autoreply_subject = ?, autoreply_body = ?, autoreply_start = ?, autoreply_end = ? WHERE id = ?')
          .bind(next.isEnabled ? 1 : 0, cleanHeaderText(next.subject ?? '').trim(), body ?? '', start, end, acc.id).run();
        updated[id] = null;
      } catch (e) {
        notUpdated[id] = { type: 'invalidProperties', properties: [(e as Error).message] };
      }
    }
    const { state: newState } = await vacation(db, acc.id);
    const none = (o: object) => (Object.keys(o).length ? o : null);
    return {
      accountId: acc.id, oldState, newState, created: null, updated: none(updated), destroyed: null,
      notCreated: null, notUpdated: none(notUpdated), notDestroyed: args.destroy?.length ? Object.fromEntries((args.destroy as string[]).map((k) => [k, { type: 'forbidden' }])) : null,
    };
  },
};

export const submissionMethods: Record<string, MethodDef> = {
  'Identity/get': identityGet,
  'Identity/changes': identityChanges,
  'EmailSubmission/set': submissionSet,
  'VacationResponse/get': vacationGet,
  'VacationResponse/set': vacationSet,
};

export { jsonIds };
