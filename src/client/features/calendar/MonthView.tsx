import { useMemo, useRef } from 'react';
import { cn } from '../../lib/cn';
import { dayKey, fmt, isSameDay, monthGrid, type Weekday } from './dates';
import { onDay, type Occ } from './model';
import { eventTitle, tint, useGridFocus, type ColorOf } from './parts';

const MAX_CHIPS = 3;

interface Props {
  focus: Date;
  weekStart: Weekday;
  occs: Occ[];
  colorOf: ColorOf;
  today: Date;
  onFocus: (d: Date) => void;
  onCreate: (d: Date) => void;
  onOpen: (o: Occ) => void;
  onOpenDay: (d: Date) => void;
}

export function MonthView({ focus, weekStart, occs, colorOf, today, onFocus, onCreate, onOpen, onOpenDay }: Props) {
  const grid = useRef<HTMLDivElement>(null);
  const days = useMemo(() => monthGrid(focus, weekStart), [focus, weekStart]);
  const onKeyDown = useGridFocus(grid, focus, onFocus, 7, weekStart);
  const byDay = useMemo(() => new Map(days.map((d) => [dayKey(d), onDay(occs, d)])), [days, occs]);
  const heads = days.slice(0, 7);

  return (
    <div ref={grid} role="grid" aria-label={fmt.monthYear(focus)} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
      <div role="row" className="grid shrink-0 grid-cols-7 border-b border-border">
        {heads.map((d) => (
          <div key={d.getDay()} role="columnheader" className="px-2 py-1.5 text-[12px] font-medium text-muted">{fmt.weekday(d)}</div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        {days.map((d, i) => {
          const key = dayKey(d);
          const list = byDay.get(key) ?? [];
          const focused = isSameDay(d, focus);
          const inMonth = d.getMonth() === focus.getMonth();
          const isToday = isSameDay(d, today);
          const extra = list.length - MAX_CHIPS;
          return (
            <div
              key={key}
              role="gridcell"
              data-day={key}
              tabIndex={focused ? 0 : -1}
              aria-selected={focused}
              aria-label={`${fmt.dayLong(d)}, ${list.length} ${list.length === 1 ? 'event' : 'events'}`}
              onFocus={() => !focused && onFocus(d)}
              onClick={() => onCreate(d)}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && e.key === 'Enter') onCreate(d);
              }}
              className={cn(
                'min-h-0 min-w-0 overflow-hidden border-b border-border p-1 outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-inset',
                i % 7 !== 6 && 'border-r',
                !inMonth && 'bg-sidebar/60',
                focused && 'bg-primary-soft/50',
              )}
            >
              <div className="mb-0.5 flex h-5 items-center">
                <span className={cn('tnum inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[12px]', isToday ? 'bg-primary-fill font-semibold text-primary-fg' : inMonth ? 'text-fg' : 'text-faint')}>
                  {d.getDate()}
                </span>
              </div>
              <ul className="space-y-px">
                {list.slice(0, extra > 0 ? MAX_CHIPS - 1 : MAX_CHIPS).map((o) => (
                  <li key={o.key}>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onOpen(o); }}
                      style={tint(colorOf(o.event.calendarId), o.event.allDay ? 30 : 14)}
                      className="flex h-[18px] w-full items-center gap-1 truncate rounded-[3px] px-1 text-left text-[12px] leading-[18px] text-fg hover:brightness-95 dark:hover:brightness-125"
                    >
                      {!o.event.allDay && <span className="tnum shrink-0 text-muted">{fmt.time(new Date(o.start))}</span>}
                      <span className="truncate">{eventTitle(o)}</span>
                    </button>
                  </li>
                ))}
                {extra > 0 && (
                  <li>
                    <button type="button" onClick={(e) => { e.stopPropagation(); onOpenDay(d); }} className="h-[18px] w-full truncate rounded-[3px] px-1 text-left text-[12px] leading-[18px] text-muted hover:bg-hover hover:text-fg">
                      {extra + 1} more
                    </button>
                  </li>
                )}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
