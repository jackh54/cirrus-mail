// Client-side expansion of RRULE for the visible range. Supported: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with
// INTERVAL, COUNT, UNTIL (and WKST) and, for WEEKLY only, BYDAY without ordinals. Anything else yields the
// first occurrence only. Occurrences keep their local wall-clock time across DST changes.
import { addDays, dayDiff, startOfDay, type Weekday } from './dates';

export interface Span {
  /** Epoch ms. All-day events start at local midnight. */
  start: number;
  /** Epoch ms. Exclusive for all-day events (local midnight after the last day). */
  end: number;
  allDay: boolean;
  rrule: string | null;
}

export interface Occurrence { start: number; end: number }

const DAYS: Record<string, Weekday> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MAX_OCCURRENCES = 2000;
const MAX_STEPS = 20_000;

interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count: number | null;
  until: number | null;
  byDay: Weekday[];
  wkst: Weekday;
}

function parseUntil(v: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(v);
  if (!m) return null;
  if (!m[4]) return new Date(+m[1], +m[2] - 1, +m[3] + 1).getTime() - 1; // a date: through the end of that day
  const ms = m[7] ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** The rule if this module can expand it exactly, else null. */
export function parseRule(rrule: string): Rule | null {
  const kv = new Map<string, string>();
  for (const part of rrule.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) return null;
    kv.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1));
  }
  const freq = kv.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;
  for (const k of kv.keys()) if (!['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST'].includes(k)) return null;
  const num = (k: string, dflt: number | null): number | null | undefined => {
    const v = kv.get(k);
    if (v === undefined) return dflt;
    return /^\d{1,6}$/.test(v) && Number(v) > 0 ? Number(v) : undefined;
  };
  const interval = num('INTERVAL', 1);
  const count = num('COUNT', null);
  if (interval == null || count === undefined) return null;
  let until: number | null = null;
  if (kv.has('UNTIL')) {
    until = parseUntil(kv.get('UNTIL')!);
    if (until === null) return null;
  }
  const byDay: Weekday[] = [];
  if (kv.has('BYDAY')) {
    if (freq !== 'WEEKLY') return null;
    for (const t of kv.get('BYDAY')!.split(',')) {
      const d = DAYS[t.toUpperCase()];
      if (d === undefined) return null;
      if (!byDay.includes(d)) byDay.push(d);
    }
  }
  const wkst = kv.has('WKST') ? DAYS[kv.get('WKST')!.toUpperCase()] : 1;
  if (wkst === undefined) return null;
  return { freq, interval, count, until, byDay, wkst };
}

/** True when `rrule` is one this module expands in full (otherwise only the first occurrence shows). */
export const isExpandable = (rrule: string): boolean => parseRule(rrule) !== null;

/** Local start of step `n` (every `interval` periods from the first occurrence); weekly rules give several. */
function candidates(rule: Rule, base: Date, n: number): Date[] {
  const k = n * rule.interval;
  const h = base.getHours(), mi = base.getMinutes(), s = base.getSeconds();
  switch (rule.freq) {
    case 'DAILY':
      return [new Date(base.getFullYear(), base.getMonth(), base.getDate() + k, h, mi, s)];
    case 'WEEKLY': {
      if (!rule.byDay.length) return [new Date(base.getFullYear(), base.getMonth(), base.getDate() + 7 * k, h, mi, s)];
      const weekFirst = base.getDate() - ((base.getDay() - rule.wkst + 7) % 7);
      return rule.byDay
        .map((d) => (d - rule.wkst + 7) % 7)
        .sort((a, b) => a - b)
        .map((off) => new Date(base.getFullYear(), base.getMonth(), weekFirst + 7 * k + off, h, mi, s));
    }
    case 'MONTHLY': {
      const d = new Date(base.getFullYear(), base.getMonth() + k, base.getDate(), h, mi, s);
      return d.getDate() === base.getDate() ? [d] : []; // e.g. the 31st skips short months
    }
    case 'YEARLY': {
      const d = new Date(base.getFullYear() + k, base.getMonth(), base.getDate(), h, mi, s);
      return d.getMonth() === base.getMonth() ? [d] : [];
    }
  }
}

/** A step index from which no occurrence can still overlap `from`, so far-past series are not walked from the start. */
function skipTo(rule: Rule, base: Date, from: Date, lookbackDays: number): number {
  if (rule.count !== null) return 0; // COUNT needs every earlier occurrence counted
  const ref = addDays(startOfDay(from), -lookbackDays - 7);
  let steps: number;
  switch (rule.freq) {
    case 'DAILY': steps = dayDiff(base, ref); break;
    case 'WEEKLY': steps = Math.floor(dayDiff(base, ref) / 7); break;
    case 'MONTHLY': steps = (ref.getFullYear() - base.getFullYear()) * 12 + ref.getMonth() - base.getMonth(); break;
    case 'YEARLY': steps = ref.getFullYear() - base.getFullYear(); break;
  }
  return Math.max(0, Math.floor(steps / rule.interval) - 1);
}

/** Every occurrence of `span` that overlaps [rangeStart, rangeEnd), in start order. */
export function expandRecurrence(span: Span, rangeStart: number, rangeEnd: number): Occurrence[] {
  const out: Occurrence[] = [];
  const dur = span.end - span.start;
  const startDate = new Date(span.start);
  const endOf = (s: Date): number => {
    if (!span.allDay) return s.getTime() + dur;
    return addDays(s, Math.max(1, dayDiff(startDate, new Date(span.end)))).getTime();
  };
  const overlaps = (s: number, e: number) => s < rangeEnd && (e > rangeStart || (e === s && s >= rangeStart));
  const push = (s: Date): void => {
    const e = endOf(s);
    if (overlaps(s.getTime(), e)) out.push({ start: s.getTime(), end: e });
  };

  const rule = span.rrule ? parseRule(span.rrule) : null;
  push(startDate);
  if (!rule) return out;

  let seen = 1; // the first occurrence counts toward COUNT whether or not the rule would generate it
  const lookbackDays = Math.ceil(dur / 86_400_000) + 1;
  for (let n = skipTo(rule, startDate, new Date(rangeStart), lookbackDays), steps = 0; steps < MAX_STEPS && out.length < MAX_OCCURRENCES; n++, steps++) {
    const list = candidates(rule, startDate, n).filter((d) => d.getTime() > span.start);
    for (const d of list) {
      seen++;
      if (rule.count !== null && seen > rule.count) return out;
      if (rule.until !== null && d.getTime() > rule.until) return out;
      if (d.getTime() >= rangeEnd) return out;
      push(d);
    }
    // Candidates of later steps are never earlier than this step's first one.
    if (!list.length && candidates(rule, startDate, n)[0]?.getTime() >= rangeEnd) return out;
  }
  return out;
}
