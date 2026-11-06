// Threading: In-Reply-To / References first, then normalized subject + shared participant (30 days).
import { parseJsonAddresses } from '../lib/addresses';

const PREFIX = /^\s*(?:(?:re|fw|fwd|aw|wg|sv|vs|antw|tr|rif|ref)(?:\s*\[\d+\]|\s*\(\d+\))?\s*[:：]\s*)+/i;
const THIRTY_DAYS = 30 * 24 * 3600 * 1000;

export function normalizeSubject(subject: string): string {
  let s = subject.replace(/\s+/g, ' ').trim();
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(PREFIX, '').trim();
  }
  return s.toLowerCase();
}

/** Extracts `<id>` tokens from an In-Reply-To / References header value. */
export function parseMessageIds(value: string | null | undefined): string[] {
  if (!value) return [];
  const ids = value.match(/<[^<>\s]+>/g);
  if (ids) return ids;
  return value.split(/[\s,]+/).filter((v) => v.includes('@')).map((v) => `<${v}>`);
}

export interface ThreadLookup {
  mailboxId: string;
  inReplyTo: string[];
  references: string[];
  subjectNorm: string;
  participants: string[];   // lowercase addresses of the incoming message (from, to, cc)
  ownAddresses: Set<string>;
  now: number;
}

export async function findThread(db: D1Database, q: ThreadLookup): Promise<string | null> {
  // 1. Header references, In-Reply-To first, then References newest → oldest.
  const ids = [...new Set([...q.inReplyTo, ...[...q.references].reverse()])].slice(0, 50);
  if (ids.length) {
    const { results } = await db.prepare(
      `SELECT message_id_hdr, thread_id FROM messages WHERE mailbox_id = ? AND message_id_hdr IN (${ids.map(() => '?').join(',')})`,
    ).bind(q.mailboxId, ...ids).all<{ message_id_hdr: string; thread_id: string }>();
    const map = new Map(results.map((r) => [r.message_id_hdr, r.thread_id]));
    for (const id of ids) if (map.has(id)) return map.get(id)!;
  }
  // 2. Subject fallback: same normalized subject and a shared (non-own) participant within 30 days.
  if (!q.subjectNorm) return null;
  const others = new Set(q.participants.filter((p) => !q.ownAddresses.has(p)));
  if (!others.size) return null;
  const { results: candidates } = await db.prepare(
    'SELECT id FROM threads WHERE mailbox_id = ? AND subject_norm = ? AND last_message_at > ? ORDER BY last_message_at DESC LIMIT 5',
  ).bind(q.mailboxId, q.subjectNorm, q.now - THIRTY_DAYS).all<{ id: string }>();
  for (const t of candidates) {
    const { results: msgs } = await db.prepare('SELECT from_email, to_json, cc_json FROM messages WHERE thread_id = ? LIMIT 100').bind(t.id).all<{ from_email: string; to_json: string; cc_json: string }>();
    for (const m of msgs) {
      const addrs = [m.from_email, ...parseJsonAddresses(m.to_json).map((a) => a.email), ...parseJsonAddresses(m.cc_json).map((a) => a.email)];
      if (addrs.some((a) => others.has(a.toLowerCase()))) return t.id;
    }
  }
  return null;
}
