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

export const REGEX_RULE =
  'Patterns may not use backreferences (\\1, \\k<name>) or put a quantifier (*, +, ?, {n}) on a group that itself ' +
  'contains a quantifier or |, such as (a+)+ or (a|b)*. These forms can take exponential time.';

/**
 * Conservative ReDoS heuristic. Returns a reason when the pattern uses a backreference or a quantified
 * group whose body contains a quantifier or alternation (directly or in a nested group); else null.
 */
export function regexSafetyIssue(pattern: string): string | null {
  type Frame = { quant: boolean; alt: boolean };
  const stack: Frame[] = [{ quant: false, alt: false }];
  const top = () => stack[stack.length - 1];
  const quantAt = (j: number) => {
    const ch = pattern[j];
    if (ch === '*' || ch === '+' || ch === '?') return true;
    return ch === '{' && /^\{\d+(,\d*)?\}/.test(pattern.slice(j));
  };
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
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
      stack.push({ quant: false, alt: false });
      const m = pattern.slice(i + 1).match(/^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/);
      if (m) i += m[0].length;
      continue;
    }
    if (ch === ')') {
      const f = stack.length > 1 ? stack.pop()! : { quant: false, alt: false };
      if (quantAt(i + 1) && (f.quant || f.alt)) return 'quantified group containing a quantifier or alternation';
      top().quant ||= f.quant;
      top().alt ||= f.alt;
      continue;
    }
    if (ch === '|') top().alt = true;
    else if (quantAt(i)) top().quant = true;
  }
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
  const capped = value.slice(0, MAX_FIELD_LENGTH);
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
