import { describe, expect, it } from 'vitest';
import { addDays, dayKey, localeWeekStart, monthGrid, startOfWeek } from '../src/client/features/calendar/dates';
import { layoutColumns } from '../src/client/features/calendar/layout';
import { expandRecurrence, isExpandable } from '../src/client/features/calendar/recurrence';
import { WINDOWS_ZONES, resolveZone } from '../src/shared/tz';

const at = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const days = (occ: { start: number }[]) => occ.map((o) => dayKey(new Date(o.start)));

describe('recurrence expander', () => {
  const hour = { start: at(2026, 3, 2, 9), end: at(2026, 3, 2, 10), allDay: false };

  it('returns the single occurrence of a plain event, only when in range', () => {
    expect(expandRecurrence({ ...hour, rrule: null }, at(2026, 3, 1), at(2026, 3, 8))).toHaveLength(1);
    expect(expandRecurrence({ ...hour, rrule: null }, at(2026, 3, 3), at(2026, 3, 8))).toHaveLength(0);
  });

  it('expands daily with INTERVAL and COUNT', () => {
    const o = expandRecurrence({ ...hour, rrule: 'FREQ=DAILY;INTERVAL=2;COUNT=4' }, at(2026, 3, 1), at(2026, 4, 1));
    expect(days(o)).toEqual(['2026-03-02', '2026-03-04', '2026-03-06', '2026-03-08']);
    expect(o[1].end - o[1].start).toBe(3_600_000);
  });

  it('expands weekly BYDAY, never before the first start, and stops at UNTIL', () => {
    const o = expandRecurrence({ ...hour, rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260311' }, at(2026, 3, 1), at(2026, 4, 1));
    expect(days(o)).toEqual(['2026-03-02', '2026-03-04', '2026-03-06', '2026-03-09', '2026-03-11']);
  });

  it('counts the first occurrence toward COUNT with BYDAY', () => {
    const o = expandRecurrence({ ...hour, rrule: 'FREQ=WEEKLY;BYDAY=MO,TU;COUNT=3' }, at(2026, 3, 1), at(2026, 5, 1));
    expect(days(o)).toEqual(['2026-03-02', '2026-03-03', '2026-03-09']);
  });

  it('skips ahead for old series without losing occurrences in range', () => {
    const old = { start: at(2020, 1, 31, 9), end: at(2020, 1, 31, 10), allDay: false };
    const monthly = expandRecurrence({ ...old, rrule: 'FREQ=MONTHLY' }, at(2026, 3, 1), at(2026, 6, 1));
    expect(days(monthly)).toEqual(['2026-03-31', '2026-05-31']); // April has no 31st
    const yearly = expandRecurrence({ ...old, rrule: 'FREQ=YEARLY' }, at(2026, 1, 1), at(2027, 1, 1));
    expect(days(yearly)).toEqual(['2026-01-31']);
    const daily = expandRecurrence({ ...old, rrule: 'FREQ=DAILY' }, at(2026, 3, 10), at(2026, 3, 12));
    expect(days(daily)).toEqual(['2026-03-10', '2026-03-11']);
  });

  it('keeps all-day length and local time of day', () => {
    const trip = { start: at(2026, 3, 2), end: at(2026, 3, 4), allDay: true };
    const o = expandRecurrence({ ...trip, rrule: 'FREQ=WEEKLY' }, at(2026, 3, 8), at(2026, 3, 20));
    expect(days(o)).toEqual(['2026-03-09', '2026-03-16']);
    expect(days([{ start: o[0].end }])).toEqual(['2026-03-11']);
    // An occurrence that started before the range still shows if it runs into it.
    expect(expandRecurrence({ ...trip, rrule: 'FREQ=WEEKLY' }, at(2026, 3, 10), at(2026, 3, 11))).toHaveLength(1);
  });

  it('shows only the first occurrence for rules it cannot expand', () => {
    for (const rule of ['FREQ=MONTHLY;BYDAY=2TU', 'FREQ=MONTHLY;BYMONTHDAY=1,15', 'FREQ=HOURLY', 'FREQ=DAILY;BYHOUR=9']) {
      expect(isExpandable(rule)).toBe(false);
      expect(expandRecurrence({ ...hour, rrule: rule }, at(2026, 3, 1), at(2027, 3, 1))).toHaveLength(1);
    }
  });
});

describe('recurrence in the event zone', () => {
  const iso = (occ: { start: number }[]) => occ.map((o) => new Date(o.start).toISOString());
  // Mondays 10:00 New York, first on 2 March 2026 (EST); US clocks go forward on 8 March, EU clocks on 29 March.
  const ny = { start: Date.UTC(2026, 2, 2, 15), end: Date.UTC(2026, 2, 2, 16), allDay: false, rrule: 'FREQ=WEEKLY', tzid: 'America/New_York' };

  it('repeats at the same wall-clock time in the event zone, whatever the viewer zone does', () => {
    const o = expandRecurrence(ny, Date.UTC(2026, 2, 1), Date.UTC(2026, 3, 7));
    expect(iso(o)).toEqual(['2026-03-02T15:00:00.000Z', '2026-03-09T14:00:00.000Z', '2026-03-16T14:00:00.000Z', '2026-03-23T14:00:00.000Z', '2026-03-30T14:00:00.000Z', '2026-04-06T14:00:00.000Z']);
    expect(o[1].end - o[1].start).toBe(3_600_000);
    // Starting the walk later (skipTo) gives the same instants.
    expect(iso(expandRecurrence(ny, Date.UTC(2026, 2, 28), Date.UTC(2026, 3, 1)))).toEqual(['2026-03-30T14:00:00.000Z']);
  });

  it('knows the Windows zone names it maps to', () => {
    expect(resolveZone('Pacific Standard Time')).toBe('America/Los_Angeles');
    expect(resolveZone('Europe/Paris')).toBe('Europe/Paris');
    expect(resolveZone('Nowhere Standard Time')).toBeNull();
    for (const [win, iana] of Object.entries(WINDOWS_ZONES)) expect(resolveZone(win), win).toBe(iana);
  });
});

describe('column layout', () => {
  it('puts overlapping events side by side and frees the width afterwards', () => {
    const p = layoutColumns([
      { id: 'a', start: 60, end: 120 }, { id: 'b', start: 90, end: 150 }, { id: 'c', start: 100, end: 110 }, { id: 'd', start: 200, end: 230 },
    ]);
    const by = Object.fromEntries(p.map((x) => [x.id, x]));
    expect([by.a.col, by.b.col, by.c.col]).toEqual([0, 1, 2]);
    expect([by.a.cols, by.b.cols, by.c.cols]).toEqual([3, 3, 3]);
    expect(by.d).toMatchObject({ col: 0, cols: 1 });
  });

  it('reuses a column once its event has ended', () => {
    const p = layoutColumns([{ id: 'a', start: 0, end: 60 }, { id: 'b', start: 30, end: 90 }, { id: 'c', start: 60, end: 120 }]);
    const by = Object.fromEntries(p.map((x) => [x.id, x]));
    expect(by.c.col).toBe(0);
    expect(by.c.cols).toBe(2);
  });

  it('treats back-to-back events as separate clusters', () => {
    const p = layoutColumns([{ id: 'a', start: 0, end: 60 }, { id: 'b', start: 60, end: 120 }]);
    expect(p.every((x) => x.cols === 1 && x.col === 0)).toBe(true);
  });
});

describe('date helpers', () => {
  it('builds a 6x7 month grid starting on the requested weekday', () => {
    const g = monthGrid(new Date(2026, 2, 15), 1);
    expect(g).toHaveLength(42);
    expect(g[0].getDay()).toBe(1);
    expect(dayKey(g[0])).toBe('2026-02-23');
    expect(dayKey(startOfWeek(new Date(2026, 2, 1), 0))).toBe('2026-03-01');
  });

  it('keeps wall-clock time across DST when adding days', () => {
    expect(addDays(new Date(2026, 2, 7, 9, 30), 2).getHours()).toBe(9);
  });

  it('reads the week start from the locale, with Monday as the fallback', () => {
    expect(localeWeekStart('en-US')).toBeGreaterThanOrEqual(0);
    expect(localeWeekStart('not a locale!!')).toBe(1);
  });
});
