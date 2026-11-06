// Plain-Date helpers for the calendar. Everything is local time; day arithmetic goes through the Date
// constructor so DST changes never shift a wall-clock time.

export const MINUTE = 60_000;
export const HOUR = 3_600_000;

/** 0 = Sunday ... 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());
export const startOfMonth = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), 1);
export const addMonths = (d: Date, n: number): Date => {
  const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last), d.getHours(), d.getMinutes());
};
export const isSameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Whole local days from `a` to `b` (both reduced to their dates). */
export function dayDiff(a: Date, b: Date): number {
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** `YYYY-MM-DD` of the local date. */
export const dayKey = (d: Date): string => `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local midnight of a `YYYY-MM-DD` string, or null if it is not one. */
export function parseDayKey(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** `HH:MM` of the local time. */
export const timeKey = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * The first day of the week from the user's locale (`Intl.Locale#weekInfo`, or `getWeekInfo()` in newer
 * engines). Falls back to Monday when the runtime cannot say.
 */
export function localeWeekStart(locale: string | undefined = typeof navigator === 'undefined' ? undefined : navigator.language): Weekday {
  try {
    const l = new Intl.Locale(locale ?? 'en') as Intl.Locale & { weekInfo?: { firstDay: number }; getWeekInfo?: () => { firstDay: number } };
    const first = l.getWeekInfo?.().firstDay ?? l.weekInfo?.firstDay;
    if (typeof first === 'number' && first >= 1 && first <= 7) return (first % 7) as Weekday;
  } catch {
    /* fall through */
  }
  return 1;
}

/** The first day of the week that contains `d`. */
export function startOfWeek(d: Date, weekStart: Weekday): Date {
  return addDays(startOfDay(d), -((d.getDay() - weekStart + 7) % 7));
}

/** The 6 x 7 days a month grid shows. */
export function monthGrid(month: Date, weekStart: Weekday): Date[] {
  const first = startOfWeek(startOfMonth(month), weekStart);
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

export function weekDays(d: Date, weekStart: Weekday): Date[] {
  const first = startOfWeek(d, weekStart);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

export const fmt = {
  monthYear: (d: Date) => new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(d),
  dayLong: (d: Date) => new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(d),
  dayShort: (d: Date) => new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(d),
  weekday: (d: Date) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d),
  monthDay: (d: Date) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(d),
  time: (d: Date) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d),
  hour: (h: number) => new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(new Date(2000, 0, 1, h)),
};

/** "Mar 3 - 9, 2026" style title for a run of days. */
export function rangeTitle(first: Date, last: Date): string {
  const f = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: first.getFullYear() === last.getFullYear() ? undefined : 'numeric' });
  const tail = new Intl.DateTimeFormat(undefined, { year: 'numeric' }).format(last);
  return `${f.format(first)} – ${f.format(last)}${first.getFullYear() === last.getFullYear() ? `, ${tail}` : ''}`;
}
