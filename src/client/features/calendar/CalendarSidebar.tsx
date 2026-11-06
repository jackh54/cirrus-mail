import { useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import type { DavCollectionInfo } from '@shared/api';
import { AppSidebar } from '../../components/AppSidebar';
import { Button, IconButton } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Field, Input } from '../../components/Field';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useCollectionMutations } from '../../lib/queries/dav';
import { CAL_COLORS } from './model';

interface Props {
  calendars: DavCollectionInfo[];
  colorOf: (id: string) => string;
  hidden: Set<string>;
  onToggle: (id: string) => void;
  onNewEvent: () => void;
  onNavigate?: () => void;
}

export function CalendarSidebar({ calendars, colorOf, hidden, onToggle, onNewEvent, onNavigate }: Props) {
  const [dialog, setDialog] = useState<DavCollectionInfo | 'new' | null>(null);
  return (
    <AppSidebar label="Calendar" onNavigate={onNavigate}>
      <Button variant="secondary" className="mb-3 w-full justify-start px-2.5" icon={<Plus size={15} className="text-primary" />} onClick={() => { onNavigate?.(); onNewEvent(); }}>
        New event
      </Button>
      <div className="flex h-7 items-center justify-between pl-2">
        <h2 className="text-[12px] font-medium text-faint">Calendars</h2>
        <IconButton label="New calendar" onClick={() => setDialog('new')}><Plus size={14} /></IconButton>
      </div>
      <ul className="space-y-px">
        {calendars.map((c) => (
          <li key={c.id} className="group flex items-center rounded-md hover:bg-black/[0.035] dark:hover:bg-white/[0.04]">
            <label className="flex min-h-7 min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-2 text-[13px] pointer-coarse:min-h-11 pointer-coarse:text-[15px]">
              <input
                type="checkbox"
                checked={!hidden.has(c.id)}
                onChange={() => onToggle(c.id)}
                style={{ accentColor: colorOf(c.id) }}
                className="size-3.5 shrink-0 cursor-pointer pointer-coarse:size-5"
              />
              <span className="truncate text-fg">{c.name}</span>
            </label>
            <IconButton label={`Edit ${c.name}`} noTip onClick={() => setDialog(c)} className="mr-0.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
              <Pencil size={13} />
            </IconButton>
          </li>
        ))}
      </ul>
      {dialog && <CalendarDialog key={dialog === 'new' ? 'new' : dialog.id} calendar={dialog === 'new' ? null : dialog} count={calendars.length} onClose={() => setDialog(null)} />}
    </AppSidebar>
  );
}

function CalendarDialog({ calendar, count, onClose }: { calendar: DavCollectionInfo | null; count: number; onClose: () => void }) {
  const { create, update } = useCollectionMutations();
  const { toast } = useToast();
  const [name, setName] = useState(calendar?.name ?? '');
  const [color, setColor] = useState((calendar?.color ?? CAL_COLORS[count % CAL_COLORS.length]).slice(0, 7).toUpperCase());
  const swatches = CAL_COLORS.includes(color) ? CAL_COLORS : [color, ...CAL_COLORS];
  const fail = (e: unknown) => toast({ tone: 'error', title: "Couldn't save the calendar", description: errorMessage(e) });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    if (calendar) update.mutate({ id: calendar.id, name: n, color }, { onError: fail });
    else create.mutate({ kind: 'calendar', name: n, color }, { onError: fail });
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={calendar ? 'Edit calendar' : 'New calendar'}
      width={400}
      footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" form="calendar-form" variant="primary" disabled={!name.trim()}>Save</Button></>}
    >
      <form id="calendar-form" onSubmit={submit} className="space-y-4">
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} data-autofocus />}</Field>
        <fieldset>
          <legend className="mb-1.5 text-[13px] leading-5 font-medium">Colour</legend>
          <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-2">
            {swatches.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={c === color}
                aria-label={c}
                onClick={() => setColor(c)}
                style={{ backgroundColor: c }}
                className={cn('size-7 rounded-full ring-offset-2 ring-offset-elevated pointer-coarse:size-9', c === color && 'ring-2 ring-fg')}
              />
            ))}
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}
