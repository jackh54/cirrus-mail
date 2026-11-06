import type { EventInput, EventView } from '@shared/api';
import { addDays, dayKey, parseDayKey, startOfDay } from './dates';
import { expandRecurrence } from './recurrence';

/** An event with its times as local epoch ms (all-day: local midnights, `end` exclusive). */
export interface CalEvent {
  id: string;
  calendarId: string;
  title: string;
  allDay: boolean;
  start: number;
  end: number;
  location: string;
  description: string;
  rrule: string | null;
  view: EventView;
}

/** One visible instance of an event (the only one unless it repeats). */
export interface Occ {
  key: string;
  event: CalEvent;
  start: number;
  end: number;
}

export function toCalEvent(v: EventView): CalEvent | null {
  let start: number, end: number;
  if (v.allDay) {
    const s = parseDayKey(v.start);
    if (!s) return null;
    const e = v.end ? parseDayKey(v.end) : null;
    start = s.getTime();
    end = e && e.getTime() > start ? e.getTime() : addDays(s, 1).getTime();
  } else {
    start = Date.parse(v.start);
    if (!Number.isFinite(start)) return null;
    end = v.end ? Date.parse(v.end) : start;
    if (!Number.isFinite(end) || end < start) end = start;
  }
  return { id: v.id, calendarId: v.calendarId, title: v.summary, allDay: v.allDay, start, end, location: v.location, description: v.description, rrule: v.rrule, view: v };
}

/** Every occurrence overlapping [from, to), sorted by start. */
export function occurrencesBetween(events: CalEvent[], from: Date, to: Date): Occ[] {
  const out: Occ[] = [];
  for (const ev of events) {
    for (const o of expandRecurrence({ start: ev.start, end: ev.end, allDay: ev.allDay, rrule: ev.rrule, tzid: ev.view.tzid }, from.getTime(), to.getTime())) {
      out.push({ key: `${ev.id}:${o.start}`, event: ev, start: o.start, end: o.end });
    }
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** Occurrences that touch the local day `day`. */
export function onDay(occs: Occ[], day: Date): Occ[] {
  const a = startOfDay(day).getTime();
  const b = addDays(startOfDay(day), 1).getTime();
  return occs.filter((o) => o.start < b && (o.end > a || (o.end === o.start && o.start >= a)));
}

/** ISO instant without milliseconds, as the API stores it. */
export const isoInstant = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The API body for `ev` with new times (all-day: local midnights in, dates out). */
export function inputWithTimes(ev: CalEvent, start: number, end: number): EventInput {
  return {
    summary: ev.title, allDay: ev.allDay, location: ev.location, description: ev.description, rrule: ev.rrule,
    start: ev.allDay ? dayKey(new Date(start)) : isoInstant(start),
    end: ev.allDay ? dayKey(new Date(end)) : isoInstant(end),
  };
}

export function inputOf(ev: CalEvent): EventInput {
  return inputWithTimes(ev, ev.start, ev.end);
}

/** The calendar colours offered in the pickers, and the fallback by position. */
export const CAL_COLORS = ['#2B63E8', '#1A8F5C', '#D03A3A', '#B26B00', '#8A4FD6', '#0C9DB8', '#D6409F', '#5F6470'];
export const colorFor = (color: string | null | undefined, index: number): string => (color && /^#[0-9a-f]{6}/i.test(color) ? color.slice(0, 7) : CAL_COLORS[index % CAL_COLORS.length]);
