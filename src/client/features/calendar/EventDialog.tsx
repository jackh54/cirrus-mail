import { useState } from 'react';
import type { DavCollectionInfo, EventInput } from '@shared/api';
import { Button } from '../../components/Button';
import { useConfirm } from '../../components/Confirm';
import { Dialog } from '../../components/Dialog';
import { Field, Input, Select, Switch, Textarea } from '../../components/Field';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { useEventMutations } from '../../lib/queries/dav';
import { addDays, dayKey, fmt, HOUR, parseDayKey, timeKey } from './dates';
import { isoInstant, type CalEvent } from './model';
import { isExpandable } from './recurrence';

export type EventDialogState = { kind: 'new'; start: Date; allDay: boolean } | { kind: 'edit'; event: CalEvent };

const SIMPLE = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
type Repeat = 'none' | 'custom' | (typeof SIMPLE)[number];

function repeatOf(rrule: string | null): Repeat {
  if (!rrule) return 'none';
  const m = /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)$/.exec(rrule);
  return m ? (m[1] as Repeat) : 'custom';
}

interface Form {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  location: string;
  description: string;
  calendarId: string;
  repeat: Repeat;
}

function initialForm(s: EventDialogState, calendars: DavCollectionInfo[]): Form {
  if (s.kind === 'edit') {
    const e = s.event;
    const start = new Date(e.start);
    // All-day ends are exclusive in the data; the form shows the last day.
    const end = new Date(e.allDay ? addDays(new Date(e.end), -1).getTime() : e.end);
    return {
      title: e.title, allDay: e.allDay, startDate: dayKey(start), startTime: e.allDay ? '09:00' : timeKey(start), endDate: dayKey(end), endTime: e.allDay ? '10:00' : timeKey(end),
      location: e.location, description: e.description, calendarId: e.calendarId, repeat: repeatOf(e.rrule),
    };
  }
  const end = new Date(s.start.getTime() + HOUR);
  return {
    title: '', allDay: s.allDay, startDate: dayKey(s.start), startTime: timeKey(s.start), endDate: dayKey(s.allDay ? s.start : end), endTime: timeKey(end),
    location: '', description: '', calendarId: calendars[0]?.id ?? '', repeat: 'none',
  };
}

const localMs = (date: string, time: string): number => new Date(`${date}T${time}:00`).getTime();

export function EventDialog({ state, calendars, colorOf, onClose }: { state: EventDialogState | null; calendars: DavCollectionInfo[]; colorOf: (id: string) => string; onClose: () => void }) {
  if (!state) return null;
  return <Inner state={state} calendars={calendars} colorOf={colorOf} onClose={onClose} />;
}

function Inner({ state, calendars, colorOf, onClose }: { state: EventDialogState; calendars: DavCollectionInfo[]; colorOf: (id: string) => string; onClose: () => void }) {
  const editing = state.kind === 'edit' ? state.event : null;
  const [f, setF] = useState(() => initialForm(state, calendars));
  const [error, setError] = useState<string | null>(null);
  const { create, update, remove } = useEventMutations();
  const { toast } = useToast();
  const confirm = useConfirm();
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));

  /** Moving the start carries the end along so the duration stays the same. */
  const setStart = (startDate: string, startTime: string) =>
    setF((p) => {
      if (!parseDayKey(startDate) || !parseDayKey(p.startDate)) return { ...p, startDate, startTime };
      if (p.allDay) {
        const shift = parseDayKey(startDate)!.getTime() - parseDayKey(p.startDate)!.getTime();
        return { ...p, startDate, endDate: dayKey(new Date(parseDayKey(p.endDate)!.getTime() + shift)) };
      }
      const delta = localMs(startDate, startTime || p.startTime) - localMs(p.startDate, p.startTime);
      if (!Number.isFinite(delta)) return { ...p, startDate, startTime };
      const end = new Date(localMs(p.endDate, p.endTime) + delta);
      return { ...p, startDate, startTime, endDate: dayKey(end), endTime: timeKey(end) };
    });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    let input: EventInput;
    if (f.allDay) {
      const s = parseDayKey(f.startDate), en = parseDayKey(f.endDate);
      if (!s || !en) return setError('Choose a start and end date');
      if (en < s) return setError('The end is before the start');
      input = { summary: f.title.trim(), allDay: true, start: dayKey(s), end: dayKey(addDays(en, 1)), location: f.location.trim(), description: f.description, rrule: null };
    } else {
      const s = localMs(f.startDate, f.startTime), en = localMs(f.endDate, f.endTime);
      if (!Number.isFinite(s) || !Number.isFinite(en)) return setError('Choose a start and end time');
      if (en < s) return setError('The end is before the start');
      input = { summary: f.title.trim(), allDay: false, start: isoInstant(s), end: isoInstant(en), location: f.location.trim(), description: f.description, rrule: null };
    }
    // A custom rule is kept exactly as it was stored; the others map to a bare FREQ.
    input.rrule = f.repeat === 'none' ? null : f.repeat === 'custom' ? (editing?.rrule ?? null) : `FREQ=${f.repeat}`;
    const fail = (e: unknown) => toast({ tone: 'error', title: "Couldn't save the event", description: errorMessage(e) });
    if (editing) update.mutate({ id: editing.id, ...input }, { onError: fail });
    else create.mutate({ ...input, calendarId: f.calendarId || undefined }, { onError: fail });
    onClose();
  };

  const del = async () => {
    if (!editing) return;
    const ok = await confirm({ title: 'Delete this event?', body: editing.rrule ? 'This deletes every occurrence of the repeating event.' : undefined, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    remove.mutate(editing.id, { onError: (e) => toast({ tone: 'error', title: "Couldn't delete the event", description: errorMessage(e) }) });
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? 'Edit event' : 'New event'}
      width={520}
      description={editing?.rrule ? `Changes apply to the whole series, which starts ${fmt.dayShort(new Date(editing.start))}.` : undefined}
      footer={
        <>
          {editing && <Button variant="ghost" className="mr-auto text-danger hover:text-danger" onClick={() => void del()}>Delete</Button>}
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="event-form" variant="primary">Save</Button>
        </>
      }
    >
      <form id="event-form" onSubmit={submit} className="space-y-4">
        <Field label="Title" error={error}>
          {(id, d) => <Input id={id} aria-describedby={d} value={f.title} onChange={(e) => { set('title', e.target.value); setError(null); }} maxLength={500} placeholder="Add a title" data-autofocus />}
        </Field>
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium">All day</span>
          <Switch checked={f.allDay} label="All day" onChange={(v) => set('allDay', v)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts">{(id) => <Input id={id} type="date" required value={f.startDate} onChange={(e) => setStart(e.target.value, f.startTime)} />}</Field>
          {f.allDay ? (
            <Field label="Ends">{(id) => <Input id={id} type="date" required value={f.endDate} min={f.startDate} onChange={(e) => set('endDate', e.target.value)} />}</Field>
          ) : (
            <Field label="Start time">{(id) => <Input id={id} type="time" required value={f.startTime} onChange={(e) => setStart(f.startDate, e.target.value)} />}</Field>
          )}
          {!f.allDay && (
            <>
              <Field label="Ends">{(id) => <Input id={id} type="date" required value={f.endDate} min={f.startDate} onChange={(e) => set('endDate', e.target.value)} />}</Field>
              <Field label="End time">{(id) => <Input id={id} type="time" required value={f.endTime} onChange={(e) => set('endTime', e.target.value)} />}</Field>
            </>
          )}
        </div>
        <Field label="Repeat" hint={f.repeat === 'custom' && editing?.rrule && !isExpandable(editing.rrule) ? 'Only the first occurrence is shown on the calendar. The rule is kept as it is.' : f.repeat === 'custom' ? 'This rule was set elsewhere and is kept as it is.' : undefined}>
          {(id, d) => (
            <Select id={id} aria-describedby={d} value={f.repeat} disabled={f.repeat === 'custom'} onChange={(e) => set('repeat', e.target.value as Repeat)}>
              <option value="none">Does not repeat</option>
              <option value="DAILY">Daily</option>
              <option value="WEEKLY">Weekly</option>
              <option value="MONTHLY">Monthly</option>
              <option value="YEARLY">Yearly</option>
              {f.repeat === 'custom' && <option value="custom">Repeats (custom)</option>}
            </Select>
          )}
        </Field>
        <Field label="Calendar" hint={editing ? 'To move an event to another calendar, use your calendar app.' : undefined}>
          {(id, d) => (
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="size-3 shrink-0 rounded-full" style={{ backgroundColor: colorOf(f.calendarId) }} />
              <Select id={id} aria-describedby={d} value={f.calendarId} disabled={!!editing} onChange={(e) => set('calendarId', e.target.value)}>
                {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </div>
          )}
        </Field>
        <Field label="Location">{(id) => <Input id={id} value={f.location} onChange={(e) => set('location', e.target.value)} maxLength={500} />}</Field>
        <Field label="Description">{(id) => <Textarea id={id} value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={20_000} className="min-h-20" />}</Field>
      </form>
    </Dialog>
  );
}
