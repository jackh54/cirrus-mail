// Filter rule evaluation. Pure functions; the inbound handler applies the outcome.
import type { Filter, FilterCondition } from '../../shared/api';

export const MAX_REGEX_LENGTH = 200;

export interface FilterSubject {
  from: { email: string; name?: string };
  to: string[];            // to + cc + envelope recipient
  subject: string;
  hasAttachment: boolean;
  listId: string | null;
}

export interface FilterOutcome {
  folderId: string | null;
  markRead: boolean;
  star: boolean;
  trash: boolean;
  forwards: string[];
  matched: string[];       // ids of filters that matched
}

/** Compiles a user regex safely: too long or invalid → null (never throws). */
export function compileRegex(pattern: string): RegExp | null {
  if (pattern.length > MAX_REGEX_LENGTH) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

function matchValue(value: string, op: FilterCondition['op'], needle: string): boolean {
  const v = value.toLowerCase();
  const n = needle.toLowerCase();
  switch (op) {
    case 'contains': return n !== '' && v.includes(n);
    case 'equals': return v === n;
    case 'ends_with': return n !== '' && v.endsWith(n);
    case 'regex': {
      const re = compileRegex(needle);
      return re ? re.test(value) : false;
    }
    case 'is_true': return v !== '' && v !== 'false' && v !== '0';
  }
  return false;
}

export function conditionMatches(cond: FilterCondition, s: FilterSubject): boolean {
  switch (cond.field) {
    case 'from':
      return [s.from.email, s.from.name ?? '', s.from.name ? `${s.from.name} <${s.from.email}>` : ''].filter(Boolean).some((v) => matchValue(v, cond.op, cond.value));
    case 'to':
      return s.to.some((v) => matchValue(v, cond.op, cond.value));
    case 'subject':
      return matchValue(s.subject, cond.op, cond.value);
    case 'list_id':
      return s.listId ? matchValue(s.listId, cond.op, cond.value) : false;
    case 'has_attachment':
      if (cond.op === 'is_true') return s.hasAttachment;
      return matchValue(String(s.hasAttachment), cond.op, cond.value);
  }
  return false;
}

/** Runs enabled filters in `sort` order. All matching filters apply; a later move_to wins; delete wins over move. */
export function evaluateFilters(filters: Filter[], s: FilterSubject): FilterOutcome {
  const out: FilterOutcome = { folderId: null, markRead: false, star: false, trash: false, forwards: [], matched: [] };
  for (const f of [...filters].sort((a, b) => a.sort - b.sort)) {
    if (!f.enabled || !f.conditions.length) continue;
    const hit = f.match === 'any' ? f.conditions.some((c) => conditionMatches(c, s)) : f.conditions.every((c) => conditionMatches(c, s));
    if (!hit) continue;
    out.matched.push(f.id);
    for (const a of f.actions) {
      if (a.type === 'move_to') out.folderId = a.folderId;
      else if (a.type === 'mark_read') out.markRead = true;
      else if (a.type === 'star') out.star = true;
      else if (a.type === 'delete') out.trash = true;
      else if (a.type === 'forward_to' && !out.forwards.includes(a.email)) out.forwards.push(a.email);
    }
  }
  return out;
}

export interface FilterRow { id: string; name: string; match: 'all' | 'any'; conditions: string; actions: string; enabled: number; sort: number }

export function rowToFilter(r: FilterRow): Filter {
  let conditions: Filter['conditions'] = [];
  let actions: Filter['actions'] = [];
  try { conditions = JSON.parse(r.conditions); } catch { /* corrupt row: no conditions → never matches */ }
  try { actions = JSON.parse(r.actions); } catch { /* ignore */ }
  return { id: r.id, name: r.name, match: r.match, conditions, actions, enabled: !!r.enabled, sort: r.sort };
}
