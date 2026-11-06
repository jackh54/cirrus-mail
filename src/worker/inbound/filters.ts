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

export const MAX_FIELD_LENGTH = 1024;
/** Regex conditions see at most this much of a field. */
export const MAX_REGEX_INPUT = 256;
/** Upper bound on the product of alternatives and bounded-quantifier ranges in one pattern. */
export const MAX_REGEX_BRANCHING = 32;

export const REGEX_RULE =
  'Patterns may use at most one unbounded quantifier (*, +, {n,}), may not put a quantifier on a group, and may not ' +
  'use backreferences (\\1, \\k<name>) or lookarounds. Forms such as (a+)+ or .*.*x are refused because they can take ' +
  'very long to run. Long chains of alternatives or optional parts are refused for the same reason.';

/** `{n}`, `{n,}`, `{n,m}`, `*`, `+` or `?` at `i`: its length and range, else null. */
function quantifierAt(pattern: string, i: number): { len: number; min: number; max: number } | null {
  const ch = pattern[i];
  if (ch === '*') return { len: 1, min: 0, max: Infinity };
  if (ch === '+') return { len: 1, min: 1, max: Infinity };
  if (ch === '?') return { len: 1, min: 0, max: 1 };
  if (ch !== '{') return null;
  const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
  if (!m) return null;
  const min = Number(m[1]);
  const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
  return { len: m[0].length, min, max };
}

/**
 * Conservative ReDoS check (input is capped at MAX_REGEX_INPUT). Returns a reason when the pattern uses a
 * backreference or lookaround, quantifies a group, has more than one unbounded quantifier, or multiplies
 * alternatives and bounded ranges (`?` counts 2, `{2,5}` counts 4) beyond MAX_REGEX_BRANCHING; else null.
 */
export function regexSafetyIssue(pattern: string): string | null {
  let unbounded = 0;
  let branching = 1;
  const alts: number[] = [1]; // alternatives per open group; [0] is the top level
  let afterGroup = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    const q = quantifierAt(pattern, i);
    if (q) {
      if (afterGroup) return 'quantified group';
      if (q.max === Infinity) {
        if (++unbounded > 1) return 'more than one unbounded quantifier';
      } else branching *= q.max - q.min + 1;
      i += q.len - 1;
      if (pattern[i + 1] === '?') i++; // lazy modifier
      afterGroup = false;
      continue;
    }
    afterGroup = false;
    if (ch === '\\') {
      const next = pattern[i + 1] ?? '';
      if (/[1-9]/.test(next) || (next === 'k' && pattern[i + 2] === '<')) return 'backreference';
      i++;
      continue;
    }
    if (ch === '[') {
      let j = i + 1;
      if (pattern[j] === '^') j++;
      if (pattern[j] === ']') j++;
      while (j < pattern.length && pattern[j] !== ']') j += pattern[j] === '\\' ? 2 : 1;
      i = j;
      continue;
    }
    if (ch === '(') {
      if (/^\?(?:=|!|<=|<!)/.test(pattern.slice(i + 1))) return 'lookaround';
      const m = pattern.slice(i + 1).match(/^\?(?::|<[A-Za-z_$][\w$]*>)/);
      if (m) i += m[0].length;
      alts.push(1);
      continue;
    }
    if (ch === ')') {
      branching *= alts.length > 1 ? alts.pop()! : 1;
      afterGroup = true;
      continue;
    }
    if (ch === '|') alts[alts.length - 1]++;
  }
  for (const n of alts) branching *= n;
  if (branching > MAX_REGEX_BRANCHING) return 'too many alternatives or optional parts';
  return null;
}

/** Compiles a user regex safely: too long, invalid or ReDoS-prone → null (never throws). */
export function compileRegex(pattern: string): RegExp | null {
  if (pattern.length > MAX_REGEX_LENGTH || regexSafetyIssue(pattern)) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

function matchValue(value: string, op: FilterCondition['op'], needle: string): boolean {
  // Every matched field is capped, display names included, so no rule scans unbounded input.
  // Regexes get a shorter cap: even an allowed pattern can be quadratic in its input.
  const capped = value.slice(0, op === 'regex' ? MAX_REGEX_INPUT : MAX_FIELD_LENGTH);
  const v = capped.toLowerCase();
  const n = needle.toLowerCase();
  switch (op) {
    case 'contains': return n !== '' && v.includes(n);
    case 'equals': return v === n;
    case 'ends_with': return n !== '' && v.endsWith(n);
    case 'regex': {
      const re = compileRegex(needle);
      return re ? re.test(capped) : false;
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
