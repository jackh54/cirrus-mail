import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck, CalendarDays, MapPin, Repeat, User } from 'lucide-react';
import type { Attachment, InvitePreview, MessageFull } from '@shared/api';
import { Button } from '../../components/Button';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { displayName, escapeHtml } from '../../lib/format';
import { parseInvite, useAcceptInvite } from '../../lib/queries/dav';
import { addDays, fmt, isSameDay, parseDayKey } from '../calendar/dates';
import { buildReply, findInviteAttachment, PARTSTAT_VERB, type Partstat } from '../calendar/itip';
import { draftApi } from '../compose/draftApi';

/** The .ics text and the server's reading of it. The signed URL is same-origin and expires, so it is not part of the key. */
function useInvite(a: Attachment | undefined) {
  return useQuery({
    queryKey: ['dav', 'invite', a?.id],
    enabled: !!a,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const res = await fetch(a!.url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Could not read the invitation');
      const ics = await res.text();
      return { ics, preview: await parseInvite(ics) };
    },
  });
}

/** When: a date for all-day events, else the local start and end. */
function when(e: InvitePreview['event']): string {
  if (e.allDay) {
    const s = parseDayKey(e.start);
    if (!s) return e.start;
    const last = e.end ? addDays(parseDayKey(e.end) ?? s, -1) : s;
    return isSameDay(s, last) || last < s ? `${fmt.dayLong(s)}, all day` : `${fmt.dayShort(s)} – ${fmt.dayShort(last)}`;
  }
  const s = new Date(e.start);
  const end = e.end ? new Date(e.end) : null;
  if (!end || end.getTime() === s.getTime()) return `${fmt.dayLong(s)}, ${fmt.time(s)}`;
  return isSameDay(s, end) ? `${fmt.dayLong(s)}, ${fmt.time(s)} – ${fmt.time(end)}` : `${fmt.dayShort(s)}, ${fmt.time(s)} – ${fmt.dayShort(end)}, ${fmt.time(end)}`;
}

interface Props { message: MessageFull; mailboxId: string; myEmails: Set<string> }

/** An event card for a received meeting request; null for anything that is not one. */
export function InviteCard({ message: m, mailboxId, myEmails }: Props) {
  const att = m.direction === 'in' ? findInviteAttachment(m.attachments) : undefined;
  const q = useInvite(att);
  const accept = useAcceptInvite();
  const { toast } = useToast();
  const [replied, setReplied] = useState<Partstat | null>(null);
  const [replying, setReplying] = useState<Partstat | null>(null);
  const data = q.data;
  if (!att || !data || data.preview.method !== 'REQUEST') return null;
  const { preview: p, ics } = data;
  const e = p.event;
  // The address the organiser invited: an attendee that is one of ours, else whichever of ours the message went to.
  const me = p.attendees.find((a) => myEmails.has(a)) ?? [...m.to, ...m.cc].map((a) => a.email.toLowerCase()).find((a) => myEmails.has(a));
  const added = accept.isSuccess || (!!p.existing && !accept.isPending && !accept.isError);

  const respond = async (partstat: Partstat) => {
    if (!me || !p.organizer) return;
    setReplying(partstat);
    let draftId: string | null = null;
    try {
      const verb = PARTSTAT_VERB[partstat];
      const draft = await draftApi.create(mailboxId, {
        from: me, to: [p.organizer], cc: [], bcc: [], composeMode: 'new',
        subject: `${partstat === 'ACCEPTED' ? 'Accepted' : partstat === 'DECLINED' ? 'Declined' : 'Tentative'}: ${e.summary}`,
        html: `<p>${escapeHtml(me)} has ${verb} this invitation.</p>`,
      });
      draftId = draft.id;
      const file = new File([buildReply({ uid: p.uid, sequence: p.sequence, event: e, organizer: p.organizer.email, attendee: me, partstat })], 'invite.ics', { type: 'text/calendar' });
      await draftApi.upload(mailboxId, draft.id, file, () => {});
      await draftApi.send(mailboxId, draft.id);
      setReplied(partstat);
      if (partstat === 'ACCEPTED' && !added) accept.mutate(ics);
    } catch (err) {
      if (draftId) void draftApi.discard(mailboxId, draftId).catch(() => {});
      toast({ tone: 'error', title: "Couldn't send your reply", description: errorMessage(err) });
    } finally {
      setReplying(null);
    }
  };

  return (
    <section aria-label="Calendar invitation" className="mt-4 rounded-lg border border-border bg-surface-2 px-4 py-3">
      <div className="flex items-start gap-3">
        <CalendarDays size={18} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] leading-5 font-semibold break-words">{e.summary || '(No title)'}</h3>
          <p className="tnum text-[13px] leading-5 text-fg">{when(e)}</p>
          <dl className="mt-1.5 space-y-0.5 text-[13px] leading-5 text-muted">
            {e.rrule && <Meta icon={<Repeat size={13} />} label="Repeats">Repeats</Meta>}
            {e.location && <Meta icon={<MapPin size={13} />} label="Location">{e.location}</Meta>}
            {p.organizer && <Meta icon={<User size={13} />} label="Organiser">{p.organizer.name ? `${displayName(p.organizer)} (${p.organizer.email})` : p.organizer.email}</Meta>}
          </dl>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {added ? (
          <Link to="/calendar" className="inline-flex h-7 items-center gap-1.5 text-[13px] font-medium text-success hover:underline pointer-coarse:h-11"><CalendarCheck size={15} />{p.existing && !accept.isSuccess ? 'In your calendar' : 'Added to your calendar'}</Link>
        ) : (
          <Button size="sm" variant="primary" loading={accept.isPending} onClick={() => accept.mutate(ics, { onError: (err) => toast({ tone: 'error', title: "Couldn't add the event", description: errorMessage(err) }) })}>
            Add to calendar
          </Button>
        )}
        {added && p.existing && !accept.isSuccess && (
          <Button size="sm" variant="ghost" loading={accept.isPending} onClick={() => accept.mutate(ics, { onError: (err) => toast({ tone: 'error', title: "Couldn't update the event", description: errorMessage(err) }) })}>Update from this invitation</Button>
        )}
        {me && p.organizer && (
          replied ? (
            <span role="status" className="text-[13px] text-muted">You replied: {PARTSTAT_VERB[replied]}</span>
          ) : (
            <div role="group" aria-label="Reply to the organiser" className="flex gap-1">
              {(['ACCEPTED', 'TENTATIVE', 'DECLINED'] as const).map((s) => (
                <Button key={s} size="sm" variant="secondary" disabled={!!replying} loading={replying === s} onClick={() => void respond(s)}>
                  {s === 'ACCEPTED' ? 'Accept' : s === 'TENTATIVE' ? 'Maybe' : 'Decline'}
                </Button>
              ))}
            </div>
          )
        )}
      </div>
    </section>
  );
}

function Meta({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <dt className="sr-only">{label}</dt>
      <span aria-hidden="true" className="mt-1 shrink-0 text-faint">{icon}</span>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}
