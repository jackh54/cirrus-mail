import { CalendarDays } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';
import { Button } from '../../components/Button';
import { addDays, dayKey, fmt, isSameDay, startOfDay } from './dates';
import { onDay, type Occ } from './model';
import { eventTitle, type ColorOf } from './parts';

interface Props {
  from: Date;
  days: number;
  occs: Occ[];
  colorOf: ColorOf;
  today: Date;
  onOpen: (o: Occ) => void;
  onCreate: () => void;
}

/** Upcoming events grouped by day; days without events are left out. */
export function AgendaView({ from, days, occs, colorOf, today, onOpen, onCreate }: Props) {
  const groups = Array.from({ length: days }, (_, i) => addDays(startOfDay(from), i))
    .map((d) => ({ d, list: onDay(occs, d) }))
    .filter((g) => g.list.length > 0);
  if (!groups.length) {
    return (
      <div className="min-h-0 flex-1">
        <EmptyState icon={<CalendarDays />} title="Nothing scheduled" body="No events in the next 30 days." action={<Button variant="primary" onClick={onCreate}>New event</Button>} />
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {groups.map(({ d, list }) => (
        <section key={dayKey(d)} aria-labelledby={`ag-${dayKey(d)}`}>
          <h2 id={`ag-${dayKey(d)}`} className="sticky top-0 z-10 flex h-8 items-center gap-2 border-b border-border bg-sidebar px-4 text-[12px] font-medium text-muted">
            <span className={isSameDay(d, today) ? 'text-selected-fg' : undefined}>{isSameDay(d, today) ? 'Today' : fmt.dayShort(d)}</span>
            {isSameDay(d, today) && <span className="font-normal text-faint">{fmt.dayShort(d)}</span>}
          </h2>
          <ul>
            {list.map((o) => (
              <li key={o.key}>
                <button type="button" onClick={() => onOpen(o)} className="flex min-h-14 w-full items-stretch gap-3 border-b border-border px-4 py-2 text-left hover:bg-hover">
                  <span aria-hidden="true" className="w-1 shrink-0 rounded-full" style={{ backgroundColor: colorOf(o.event.calendarId) }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] leading-5 font-medium text-fg">{eventTitle(o)}</span>
                    <span className="tnum block truncate text-[12px] leading-4 text-muted">
                      {o.event.allDay ? 'All day' : `${fmt.time(new Date(o.start))} – ${fmt.time(new Date(o.end))}`}
                      {o.event.location && ` · ${o.event.location}`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
