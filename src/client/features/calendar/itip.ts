// Detection of invitations in a message and the iTIP REPLY that answers one.
import type { Attachment, EventInput } from '@shared/api';

export type Partstat = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED';

export const PARTSTAT_VERB: Record<Partstat, string> = { ACCEPTED: 'accepted', TENTATIVE: 'tentatively accepted', DECLINED: 'declined' };

const MAX_ICS_BYTES = 256 * 1024;

/** The attachment that carries the invitation: a text/calendar part or an .ics file. */
export function findInviteAttachment(items: Attachment[]): Attachment | undefined {
  return items.find((a) => a.size <= MAX_ICS_BYTES && (/^(text\/calendar|application\/ics)\b/i.test(a.mimeType) || /\.ics$/i.test(a.filename)));
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ');
const compact = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** A METHOD:REPLY calendar object for the organiser, answering with `partstat` as `attendee`. */
export function buildReply(p: { uid: string; sequence: number; event: Omit<EventInput, 'calendarId'>; organizer: string; attendee: string; partstat: Partstat; now?: Date }): string {
  const { event: e } = p;
  const dt = e.allDay ? `DTSTART;VALUE=DATE:${e.start.replace(/-/g, '')}` : `DTSTART:${compact(e.start)}`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cirrus Mail//iTIP//EN', 'METHOD:REPLY',
    'BEGIN:VEVENT', `UID:${oneLine(p.uid)}`, `DTSTAMP:${compact((p.now ?? new Date()).toISOString())}`, `SEQUENCE:${p.sequence}`, dt,
    `ORGANIZER:mailto:${oneLine(p.organizer)}`, `ATTENDEE;PARTSTAT=${p.partstat}:mailto:${oneLine(p.attendee)}`,
    ...(e.summary ? [`SUMMARY:${esc(e.summary)}`] : []),
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return `${lines.join('\r\n')}\r\n`;
}
