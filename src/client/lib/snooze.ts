import { MAX_SNOOZE_MS } from '@shared/api';

export interface SnoozePreset {
  id: 'later' | 'tomorrow' | 'weekend' | 'next-week';
  label: string;
  /** Epoch ms, computed in the browser's local time. */
  at: number;
}

const HALF_HOUR = 30 * 60 * 1000;

function at8(now: Date, daysAhead: number): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysAhead, 8, 0, 0, 0);
  return d.getTime();
}

/** Later today (+3 h, rounded up to the half hour; only while it is still today), tomorrow, the weekend and next week at 8:00. */
export function snoozePresets(now: Date = new Date()): SnoozePreset[] {
  const out: SnoozePreset[] = [];
  const later = new Date(Math.ceil((now.getTime() + 3 * 3600_000) / HALF_HOUR) * HALF_HOUR);
  if (later.getDate() === now.getDate()) out.push({ id: 'later', label: 'Later today', at: later.getTime() });
  const day = now.getDay();
  out.push({ id: 'tomorrow', label: 'Tomorrow', at: at8(now, 1) });
  out.push({ id: 'weekend', label: 'This weekend', at: at8(now, (6 - day + 7) % 7 || 7) });
  out.push({ id: 'next-week', label: 'Next week', at: at8(now, (1 - day + 7) % 7 || 7) });
  return out;
}

/** "Sat 8:00 AM", or with the date when it is more than a week away. */
export function snoozeLabel(ms: number, now = Date.now()): string {
  const far = ms - now > 6 * 24 * 3600_000;
  return new Date(ms).toLocaleString(undefined, far
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** `datetime-local` value (local time, minutes) for an epoch. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Parses a `datetime-local` value; null unless it is a time in the future, within the server's limit. */
export function fromLocalInput(v: string, now = Date.now()): number | null {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) && t > now && t <= now + MAX_SNOOZE_MS ? t : null;
}
