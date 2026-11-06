// iCalendar (RFC 5545) analysis for storage and calendar-query, plus the structured event view used by the JSON API.
import type { Address, EventInput } from '../../shared/api';
import { escapeText, oneLine, parseLines, serialize, unescapeText, type Line } from './lines';

export class IcsError extends Error {}

/** Floating, all-day and unknown-zone times can be off by up to a day in UTC; queries pad by this much. */
export const APPROX_PAD_MS = 15 * 3600 * 1000;
const DAY = 86_400_000;

interface Comp { name: string; start: number; end: number; props: number[] }

/** Splits the lines into the VCALENDAR's direct child components; throws on unbalanced input. */
function scan(lines: Line[]): Comp[] {
  const stack: Comp[] = [];
  const comps: Comp[] = [];
  let sawRoot = false;
  lines.forEach((l, i) => {
    if (l.name === 'BEGIN') {
      const name = l.value.trim().toUpperCase();
      if (!stack.length) {
        if (name !== 'VCALENDAR' || sawRoot) throw new IcsError('Expected a single VCALENDAR');
        sawRoot = true;
      }
      if (stack.length > 4) throw new IcsError('Nested too deep');
      stack.push({ name, start: i, end: -1, props: [] });
    } else if (l.name === 'END') {
      const top = stack.pop();
      if (!top || top.name !== l.value.trim().toUpperCase()) throw new IcsError('Unbalanced components');
      top.end = i;
      if (stack.length === 1) comps.push(top);
    } else {
      if (!stack.length) throw new IcsError('Content outside VCALENDAR');
      if (stack.length === 2) stack[1].props.push(i);
    }
  });
  if (stack.length || !sawRoot) throw new IcsError('Unbalanced components');
  return comps;
}

const prop = (lines: Line[], c: Comp, name: string): Line | undefined => c.props.map((i) => lines[i]).find((l) => l.name === name);
const props = (lines: Line[], c: Comp, name: string): Line[] => c.props.map((i) => lines[i]).filter((l) => l.name === name);

const tzFormatters = new Map<string, Intl.DateTimeFormat>();

/** Offset (ms) of `tz` at the UTC instant `utc`, or null for an unknown zone. */
function tzOffset(tz: string, utc: number): number | null {
  try {
    let f = tzFormatters.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
      tzFormatters.set(tz, f);
    }
    const p: Record<string, number> = {};
    for (const part of f.formatToParts(new Date(utc))) if (part.type !== 'literal') p[part.type] = Number(part.value);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utc / 1000) * 1000;
  } catch {
    return null;
  }
}

function tzToUtc(tz: string, local: number): number | null {
  const o1 = tzOffset(tz, local);
  if (o1 === null) return null;
  const guess = local - o1;
  const o2 = tzOffset(tz, guess);
  return o2 === null ? null : local - o2;
}

interface DT { ms: number; allDay: boolean; approx: boolean }

function parseDt(l: Line): DT | null {
  const v = l.value.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) {
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return Number.isFinite(ms) ? { ms, allDay: true, approx: true } : null;
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  const local = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (!Number.isFinite(local)) return null;
  if (m[7]) return { ms: local, allDay: false, approx: false };
  const tz = l.params.TZID;
  if (tz) {
    const ms = tzToUtc(tz, local);
    if (ms !== null) return { ms, allDay: false, approx: false };
  }
  return { ms: local, allDay: false, approx: true };
}

function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const n = (s: string | undefined) => (s ? Number(s) : 0);
  const ms = ((n(m[2]) * 7 + n(m[3])) * 86400 + n(m[4]) * 3600 + n(m[5]) * 60 + n(m[6])) * 1000;
  return m[1] === '-' ? -ms : ms;
}

interface CompTimes { start: number | null; end: number | null; approx: boolean; allDay: boolean }

function compTimes(lines: Line[], c: Comp): CompTimes {
  const ds = prop(lines, c, 'DTSTART');
  const start = ds ? parseDt(ds) : null;
  const endLine = prop(lines, c, c.name === 'VTODO' ? 'DUE' : 'DTEND');
  const endDt = endLine ? parseDt(endLine) : null;
  const dur = prop(lines, c, 'DURATION');
  let end: number | null = null;
  let approx = !!(start?.approx || endDt?.approx);
  if (endDt) end = endDt.ms;
  else if (start && dur) end = start.ms + (parseDuration(dur.value) ?? 0);
  else if (start) end = start.allDay ? start.ms + DAY : start.ms;
  let s = start?.ms ?? null;
  if (s === null && endDt) { s = endDt.ms; approx = approx || endDt.approx; }
  if (s !== null && end !== null && end < s) end = s;
  return { start: s, end, approx, allDay: !!start?.allDay };
}

const PERIOD_MS: Record<string, number> = {
  SECONDLY: 1000, MINUTELY: 60_000, HOURLY: 3_600_000, DAILY: DAY, WEEKLY: 7 * DAY, MONTHLY: 31 * DAY, YEARLY: 366 * DAY,
};

/** Upper bound for the end of the last occurrence, or null when the rule is unbounded or too complex to bound. */
function recurrenceEnd(rule: string, start: number, dur: number): number | null {
  const kv: Record<string, string> = {};
  for (const part of rule.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) kv[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  if (kv.UNTIL) {
    const u = parseDt({ group: '', name: 'UNTIL', params: {}, value: kv.UNTIL, raw: '' });
    if (u) return u.ms + (u.allDay ? DAY : 0) + dur + (u.approx ? APPROX_PAD_MS : 0);
    return null;
  }
  const count = Number(kv.COUNT);
  const hasBy = Object.keys(kv).some((k) => k.startsWith('BY'));
  const period = PERIOD_MS[(kv.FREQ ?? '').toUpperCase()];
  if (kv.COUNT && Number.isInteger(count) && count > 0 && !hasBy && period) {
    const interval = Math.max(1, Number(kv.INTERVAL) || 1);
    return start + count * interval * period + dur;
  }
  return null;
}

export interface IcsInfo {
  uid: string;
  component: 'VEVENT' | 'VTODO';
  dtstart: number | null;
  dtend: number | null;
  recurring: boolean;
  recUntil: number | null;
  approx: boolean;
}

export function analyzeIcs(text: string): IcsInfo {
  let lines: Line[];
  try {
    lines = parseLines(text);
  } catch {
    throw new IcsError('Malformed content line');
  }
  const items = scan(lines).filter((c) => c.name !== 'VTIMEZONE');
  if (!items.length) throw new IcsError('No VEVENT or VTODO');
  const component = items[0].name;
  if (component !== 'VEVENT' && component !== 'VTODO') throw new IcsError('Unsupported component');
  let uid = '';
  let minStart: number | null = null;
  let maxEnd: number | null = null;
  let recurring = false, unbounded = false, approx = false;
  for (const c of items) {
    if (c.name !== component) throw new IcsError('Mixed component types');
    const u = prop(lines, c, 'UID')?.value.trim() ?? '';
    if (!u || (uid && u !== uid)) throw new IcsError('Missing or inconsistent UID');
    uid = u;
    const t = compTimes(lines, c);
    approx = approx || t.approx;
    if (t.start !== null) minStart = minStart === null ? t.start : Math.min(minStart, t.start);
    const rrules = props(lines, c, 'RRULE');
    const rdates = props(lines, c, 'RDATE');
    if (rrules.length || rdates.length) {
      recurring = true;
      if (rdates.length || t.start === null) unbounded = true;
      for (const r of rrules) {
        const last = recurrenceEnd(r.value, t.start ?? 0, (t.end ?? 0) - (t.start ?? 0));
        if (last === null) unbounded = true;
        else maxEnd = Math.max(maxEnd ?? last, last);
      }
    }
    if (t.end !== null) maxEnd = Math.max(maxEnd ?? t.end, t.end);
  }
  if (uid.length > 255) throw new IcsError('UID too long');
  return { uid, component, dtstart: minStart, dtend: maxEnd, recurring, recUntil: recurring && !unbounded ? maxEnd : null, approx };
}

// ---------- structured event view (JSON API) ----------

const fmtDt = (ms: number, allDay: boolean) => (allDay ? new Date(ms).toISOString().slice(0, 10) : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'));
const compact = (ms: number, allDay: boolean) => {
  const s = new Date(ms).toISOString().replace(/[-:]/g, '');
  return allDay ? s.slice(0, 8) : `${s.slice(0, 15)}Z`;
};

export type EventFields = Omit<EventInput, 'calendarId'>;

function masterOf(lines: Line[], comps: Comp[]): Comp {
  const events = comps.filter((c) => c.name === 'VEVENT');
  const m = events.find((c) => !prop(lines, c, 'RECURRENCE-ID')) ?? events[0];
  if (!m) throw new IcsError('Not an event');
  return m;
}

export function eventFields(text: string): EventFields & { recurring: boolean } {
  const lines = parseLines(text);
  const comps = scan(lines);
  const m = masterOf(lines, comps);
  const t = compTimes(lines, m);
  const txt = (n: string) => unescapeText(prop(lines, m, n)?.value ?? '');
  return {
    summary: txt('SUMMARY'),
    start: t.start === null ? '' : fmtDt(t.start, t.allDay),
    end: t.end === null ? null : fmtDt(t.end, t.allDay),
    allDay: t.allDay,
    location: txt('LOCATION'),
    description: txt('DESCRIPTION'),
    rrule: prop(lines, m, 'RRULE')?.value ?? null,
    recurring: !!(prop(lines, m, 'RRULE') || prop(lines, m, 'RDATE')),
  };
}

const mailto = (v: string) => v.trim().replace(/^mailto:/i, '').toLowerCase();

/** What the mail reader shows for an invitation: the iTIP method, the master event and who is involved. */
export function inviteFields(text: string): { method: string | null; uid: string; event: EventFields; organizer: Address | null; attendees: string[]; sequence: number } {
  const lines = parseLines(text);
  const comps = scan(lines);
  const m = masterOf(lines, comps);
  const event = eventFields(text);
  const org = prop(lines, m, 'ORGANIZER');
  const organizer = org && mailto(org.value).includes('@') ? { email: mailto(org.value), ...(org.params.CN ? { name: org.params.CN } : {}) } : null;
  return {
    method: lines.find((l) => l.name === 'METHOD')?.value.trim().toUpperCase() ?? null,
    uid: prop(lines, m, 'UID')?.value.trim() ?? '',
    event: { summary: event.summary, start: event.start, end: event.end, allDay: event.allDay, location: event.location, description: event.description, rrule: event.rrule },
    organizer,
    attendees: props(lines, m, 'ATTENDEE').map((l) => mailto(l.value)).filter((e) => e.includes('@')).slice(0, 100),
    sequence: Number(prop(lines, m, 'SEQUENCE')?.value) || 0,
  };
}

function dtLines(f: EventFields): string[] {
  const s = Date.parse(f.allDay ? `${f.start}T00:00:00Z` : f.start);
  if (!Number.isFinite(s)) throw new IcsError('Bad start');
  let e = f.end ? Date.parse(f.allDay ? `${f.end}T00:00:00Z` : f.end) : NaN;
  if (!Number.isFinite(e)) e = f.allDay ? s + DAY : s;
  if (e < s) throw new IcsError('End is before start');
  if (f.allDay) return [`DTSTART;VALUE=DATE:${compact(s, true)}`, `DTEND;VALUE=DATE:${compact(e, true)}`];
  return [`DTSTART:${compact(s, false)}`, `DTEND:${compact(e, false)}`];
}

function textLine(name: string, v: string): string[] {
  // escapeText turns newlines into \n, so a value can never start another content line.
  return v ? [`${name}:${escapeText(v)}`] : [];
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

export function buildEvent(f: EventFields, uid: string): string {
  return serialize([
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cirrus Mail//DAV//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:${oneLine(uid)}`, `DTSTAMP:${stamp()}`,
    ...textLine('SUMMARY', f.summary), ...dtLines(f), ...textLine('LOCATION', f.location), ...textLine('DESCRIPTION', f.description),
    ...(f.rrule ? [`RRULE:${f.rrule}`] : []),
    'END:VEVENT', 'END:VCALENDAR',
  ]);
}

/** Applies `f` to the master VEVENT of `text`, touching only the fields that changed; everything else is kept as is. */
export function applyEvent(text: string, f: EventFields): string {
  const lines = parseLines(text);
  const comps = scan(lines);
  const m = masterOf(lines, comps);
  const cur = eventFields(text);
  const remove = new Set<string>();
  const add: string[] = [];
  const set = (name: string, same: boolean, v: string[]) => { if (!same) { remove.add(name); add.push(...v); } };
  set('SUMMARY', cur.summary === f.summary, textLine('SUMMARY', f.summary));
  set('LOCATION', cur.location === f.location, textLine('LOCATION', f.location));
  set('DESCRIPTION', cur.description === f.description, textLine('DESCRIPTION', f.description));
  set('RRULE', (cur.rrule ?? null) === (f.rrule ?? null), f.rrule ? [`RRULE:${f.rrule}`] : []);
  const endSame = (cur.end ?? null) === (f.end ?? null) || (!f.end && cur.end === cur.start);
  if (cur.start !== f.start || cur.allDay !== f.allDay || !endSame) {
    for (const n of ['DTSTART', 'DTEND', 'DURATION', 'DUE']) remove.add(n);
    add.push(...dtLines(f));
  }
  if (!remove.size) return text;
  for (const n of ['DTSTAMP', 'LAST-MODIFIED']) remove.add(n);
  add.push(`DTSTAMP:${stamp()}`, `LAST-MODIFIED:${stamp()}`);
  const seq = Number(prop(lines, m, 'SEQUENCE')?.value) || 0;
  remove.add('SEQUENCE');
  add.push(`SEQUENCE:${seq + 1}`);
  const drop = new Set(m.props.filter((i) => remove.has(lines[i].name)));
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (i === m.end) out.push(...add);
    if (!drop.has(i)) out.push(l.raw);
  });
  return serialize(out);
}

/** Parses a calendar-query time-range bound (UTC `YYYYMMDDTHHMMSSZ`). */
export function parseRangeBound(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v.trim());
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}
