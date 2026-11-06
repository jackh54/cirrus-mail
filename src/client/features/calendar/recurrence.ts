// Client-side expansion of RRULE for the visible range. Supported: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with
// INTERVAL, COUNT, UNTIL (and WKST) and, for WEEKLY only, BYDAY without ordinals. Anything else yields the
// first occurrence only. Occurrences keep their wall-clock time across DST changes: in the event's own zone when it has
// one (tzid), else in the viewer's zone.
import { tzOffset, tzToUtc } from '../../../shared/tz';
import { addDays, dayDiff, type Weekday } from './dates';

export interface Span {
  /** Epoch ms. All-day events start at local midnight. */
  start: number;
  /** Epoch ms. Exclusive for all-day events (local midnight after the last day). */
  end: number;
  allDay: boolean;
  rrule: string | null;
  /** IANA zone of a timed event; its series repeats at the same wall-clock time there. Null: the viewer's zone. */
  tzid?: string | null;
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

const DAY = 86_400_000;

/** Calendar arithmetic on a Date: the viewer's zone, or (with `WALL`) wall-clock fields read as UTC so no viewer DST gap can interfere. */
interface Cal {
  year(d: Date): number; month(d: Date): number; date(d: Date): number; day(d: Date): number;
  hours(d: Date): number; minutes(d: Date): number; seconds(d: Date): number;
  make(y: number, mo: number, d: number, h: number, mi: number, s: number): Date;
}
const LOCAL: Cal = {
  year: (d) => d.getFullYear(), month: (d) => d.getMonth(), date: (d) => d.getDate(), day: (d) => d.getDay(),
  hours: (d) => d.getHours(), minutes: (d) => d.getMinutes(), seconds: (d) => d.getSeconds(),
  make: (y, mo, d, h, mi, s) => new Date(y, mo, d, h, mi, s),
};
const WALL: Cal = {
  year: (d) => d.getUTCFullYear(), month: (d) => d.getUTCMonth(), date: (d) => d.getUTCDate(), day: (d) => d.getUTCDay(),
  hours: (d) => d.getUTCHours(), minutes: (d) => d.getUTCMinutes(), seconds: (d) => d.getUTCSeconds(),
  make: (y, mo, d, h, mi, s) => new Date(Date.UTC(y, mo, d, h, mi, s)),
};

/** Start of step `n` (every `interval` periods from the first occurrence); weekly rules give several. */
function candidates(rule: Rule, base: Date, n: number, c: Cal): Date[] {
  const k = n * rule.interval;
  const y = c.year(base), mo = c.month(base), dt = c.date(base);
  const h = c.hours(base), mi = c.minutes(base), s = c.seconds(base);
  switch (rule.freq) {
    case 'DAILY':
      return [c.make(y, mo, dt + k, h, mi, s)];
    case 'WEEKLY': {
      if (!rule.byDay.length) return [c.make(y, mo, dt + 7 * k, h, mi, s)];
      const weekFirst = dt - ((c.day(base) - rule.wkst + 7) % 7);
      return rule.byDay
        .map((d) => (d - rule.wkst + 7) % 7)
        .sort((a, b) => a - b)
        .map((off) => c.make(y, mo, weekFirst + 7 * k + off, h, mi, s));
    }
    case 'MONTHLY': {
      const d = c.make(y, mo + k, dt, h, mi, s);
      return c.date(d) === dt ? [d] : []; // e.g. the 31st skips short months
    }
    case 'YEARLY': {
      const d = c.make(y + k, mo, dt, h, mi, s);
      return c.month(d) === mo ? [d] : [];
    }
  }
}

/** A step index from which no occurrence can still overlap `from`, so far-past series are not walked from the start. */
function skipTo(rule: Rule, base: Date, from: Date, lookbackDays: number, c: Cal): number {
  if (rule.count !== null) return 0; // COUNT needs every earlier occurrence counted
  const ref = new Date(from.getTime() - (lookbackDays + 8) * DAY);
  let steps: number;
  switch (rule.freq) {
    case 'DAILY': steps = Math.floor((ref.getTime() - base.getTime()) / DAY); break;
    case 'WEEKLY': steps = Math.floor(Math.floor((ref.getTime() - base.getTime()) / DAY) / 7); break;
    case 'MONTHLY': steps = (c.year(ref) - c.year(base)) * 12 + c.month(ref) - c.month(base); break;
    case 'YEARLY': steps = c.year(ref) - c.year(base); break;
  }
  return Math.max(0, Math.floor(steps / rule.interval) - 1);
}

/** Every occurrence of `span` that overlaps [rangeStart, rangeEnd), in start order. */
export function expandRecurrence(span: Span, rangeStart: number, rangeEnd: number): Occurrence[] {
  const out: Occurrence[] = [];
  const dur = span.end - span.start;
  const tz = span.tzid && !span.allDay && tzOffset(span.tzid, span.start) !== null ? span.tzid : null;
  const cal = tz ? WALL : LOCAL;
  const wallOf = (ms: number): Date => new Date(tz ? ms + tzOffset(tz, ms)! : ms);
  /** The instant of a candidate (a wall-clock Date in the event's zone, or a viewer-local Date). */
  const inst = (d: Date): number => (tz ? tzToUtc(tz, d.getTime())! : d.getTime());
  const startDate = wallOf(span.start);
  const endOf = (s: Date, ms: number): number => {
    if (!span.allDay) return ms + dur;
    return addDays(s, Math.max(1, dayDiff(startDate, new Date(span.end)))).getTime();
  };
  const overlaps = (s: number, e: number) => s < rangeEnd && (e > rangeStart || (e === s && s >= rangeStart));
  const push = (s: Date, ms = inst(s)): void => {
    const e = endOf(s, ms);
    if (overlaps(ms, e)) out.push({ start: ms, end: e });
  };

  const rule = span.rrule ? parseRule(span.rrule) : null;
  push(startDate, span.start);
  if (!rule) return out;

  let seen = 1; // the first occurrence counts toward COUNT whether or not the rule would generate it
  const lookbackDays = Math.ceil(dur / DAY) + 1;
  for (let n = skipTo(rule, startDate, wallOf(rangeStart), lookbackDays, cal), steps = 0; steps < MAX_STEPS && out.length < MAX_OCCURRENCES; n++, steps++) {
    const list = candidates(rule, startDate, n, cal).filter((d) => inst(d) > span.start);
    for (const d of list) {
      const ms = inst(d);
      seen++;
      if (rule.count !== null && seen > rule.count) return out;
      if (rule.until !== null && ms > rule.until) return out;
      if (ms >= rangeEnd) return out;
      push(d, ms);
    }
    // Candidates of later steps are never earlier than this step's first one.
    if (!list.length) {
      const first = candidates(rule, startDate, n, cal)[0];
      if (first && inst(first) >= rangeEnd) return out;
    }
  }
  return out;
}
