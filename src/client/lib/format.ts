import type { Address } from '@shared/api';

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const dayMonthFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const fullDateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const longFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
});

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Thread-list time: "14:05" today, "Mon" this week, "12 Oct" this year, else "12 Oct 2024". */
export function smartTime(ms: number, now: Date = new Date()): string {
  const d = new Date(ms);
  const today = startOfDay(now);
  if (ms >= today) return timeFmt.format(d);
  if (ms >= today - 6 * 86_400_000) return weekdayFmt.format(d);
  if (d.getFullYear() === now.getFullYear()) return dayMonthFmt.format(d);
  return fullDateFmt.format(d);
}

export function longDate(ms: number): string {
  return longFmt.format(new Date(ms));
}

export function relativeAgo(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return fullDateFmt.format(new Date(ms));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function displayName(a: Address): string {
  return a.name?.trim() || a.email.split('@')[0] || a.email;
}

export function formatAddress(a: Address): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

export function initials(a: Address): string {
  const n = displayName(a);
  const parts = n.split(/[\s._-]+/).filter(Boolean);
  const s = (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '');
  return (s || n[0] || '?').toUpperCase();
}

/** Stable pleasant hue for an avatar. */
export function avatarHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;
export function isValidEmail(s: string): boolean {
  return EMAIL_RE.test(s.trim());
}

/** Parse `Name <a@b.c>`, `"Name" <a@b.c>` or `a@b.c`. */
export function parseAddress(raw: string): Address | null {
  const s = raw.trim();
  if (!s) return null;
  const m = /^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/.exec(s);
  if (m) {
    const name = m[1]?.trim();
    return name ? { email: m[2].trim(), name } : { email: m[2].trim() };
  }
  return { email: s.replace(/^mailto:/i, '') };
}

/** Split a pasted list on commas/semicolons/newlines, respecting quoted names. */
export function parseAddressList(raw: string): Address[] {
  const out: Address[] = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted;
    if (ch === '<') angle = true;
    if (ch === '>') angle = false;
    if (!quoted && !angle && (ch === ',' || ch === ';' || ch === '\n')) {
      const a = parseAddress(cur);
      if (a) out.push(a);
      cur = '';
    } else {
      cur += ch;
    }
  }
  const a = parseAddress(cur);
  if (a) out.push(a);
  return out;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
