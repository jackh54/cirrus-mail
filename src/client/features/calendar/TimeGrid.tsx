import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { addDays, dayKey, fmt, isSameDay, MINUTE, startOfDay, type Weekday } from './dates';
import { layoutColumns, snapMinutes } from './layout';
import { onDay, type Occ } from './model';
import { eventTitle, tint, useGridFocus, type ColorOf } from './parts';

export const HOUR_PX = 48;
const MIN_BLOCK_MIN = 25;
const GUTTER = 'w-12 shrink-0 sm:w-14';

interface Props {
  days: Date[];
  focus: Date;
  weekStart: Weekday;
  occs: Occ[];
  colorOf: ColorOf;
  today: Date;
  onFocus: (d: Date) => void;
  onCreate: (start: Date, allDay: boolean) => void;
  onOpen: (o: Occ) => void;
  onOpenDay: (d: Date) => void;
  onMove: (o: Occ, start: number, end: number) => void;
}

interface Drag { key: string; dx: number; dy: number; moved: boolean }

export function TimeGrid({ days, focus, weekStart, occs, colorOf, today, onFocus, onCreate, onOpen, onOpenDay, onMove }: Props) {
  const head = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const cols = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const justDragged = useRef(false); // the click that ends a drag must not open the event
  const onKeyDown = useGridFocus(head, focus, onFocus, days.length > 1 ? 7 : 1, weekStart);
  const now = useNow();

  // Open at 7am (or at the current time when that is later in the day) without a visible jump.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX - 4;
  }, []);

  const perDay = useMemo(
    () =>
      days.map((d) => {
        const dayStart = startOfDay(d).getTime();
        const dayEnd = addDays(startOfDay(d), 1).getTime();
        const here = onDay(occs, d);
        const blocks = here.filter((o) => !o.event.allDay).map((o) => {
          const start = Math.max(0, (o.start - dayStart) / MINUTE);
          const end = Math.min(1440, (Math.min(o.end, dayEnd) - dayStart) / MINUTE);
          return { id: o.key, start, end: Math.max(end, start + MIN_BLOCK_MIN) };
        });
        return { day: d, allDay: here.filter((o) => o.event.allDay), placed: layoutColumns(blocks), byKey: new Map(here.map((o) => [o.key, o])) };
      }),
    [days, occs],
  );

  const startDrag = (e: React.PointerEvent, o: Occ) => {
    if (e.button !== 0 || o.event.rrule) return; // series are moved from the dialog
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ key: o.key, dx: 0, dy: 0, moved: false });
    const x0 = e.clientX, y0 = e.clientY;
    const el = e.currentTarget as HTMLElement;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      setDrag((d) => d && { ...d, dx, dy, moved: d.moved || Math.abs(dx) + Math.abs(dy) > 5 });
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      setDrag(null);
      if (ev.type === 'pointercancel' || Math.abs(dx) + Math.abs(dy) <= 5) return;
      justDragged.current = true;
      setTimeout(() => { justDragged.current = false; }, 0);
      const colW = (cols.current?.getBoundingClientRect().width ?? 0) / days.length;
      const dayDelta = colW ? Math.round(dx / colW) : 0;
      const minDelta = snapMinutes((dy / HOUR_PX) * 60 + 720, 15) - 720; // 15-minute steps, signed
      if (!dayDelta && !minDelta) return;
      const s = addDays(new Date(o.start + minDelta * MINUTE), dayDelta).getTime();
      onMove(o, s, s + (o.end - o.start));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const slotClick = (e: React.MouseEvent<HTMLDivElement>, d: Date) => {
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mins = Math.floor((e.clientY - rect.top) / HOUR_PX * 2) * 30;
    onCreate(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, mins), false);
  };

  const showAllDay = perDay.some((p) => p.allDay.length > 0);
  const gridCols = { gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 border-b border-border">
        <div className={GUTTER} />
        <div ref={head} role="row" aria-label="Days" onKeyDown={onKeyDown} className="grid min-w-0 flex-1" style={gridCols}>
          {days.map((d) => {
            const focused = isSameDay(d, focus);
            const isToday = isSameDay(d, today);
            return (
              <button
                key={dayKey(d)}
                type="button"
                role="columnheader"
                data-day={dayKey(d)}
                tabIndex={focused ? 0 : -1}
                aria-label={fmt.dayLong(d)}
                onFocus={() => !focused && onFocus(d)}
                onClick={() => (days.length > 1 ? onOpenDay(d) : onFocus(d))}
                className="flex h-12 min-w-0 flex-col items-center justify-center gap-0.5 border-l border-border outline-none first:border-l-0 hover:bg-hover focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-inset"
              >
                <span className="text-[12px] leading-4 text-muted">{fmt.weekday(d)}</span>
                <span className={cn('tnum inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[14px] leading-6', isToday ? 'bg-primary-fill font-semibold text-primary-fg' : 'text-fg')}>{d.getDate()}</span>
              </button>
            );
          })}
        </div>
      </div>
      {showAllDay && (
        <div className="flex max-h-24 shrink-0 overflow-y-auto border-b border-border">
          <div className={cn(GUTTER, 'px-1 py-1 text-right text-[11px] leading-5 text-faint')}>all-day</div>
          <ul className="grid min-w-0 flex-1" style={gridCols}>
            {perDay.map((p) => (
              <li key={dayKey(p.day)} className="min-w-0 space-y-px border-l border-border p-0.5 first:border-l-0">
                {p.allDay.map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    onClick={() => onOpen(o)}
                    style={tint(colorOf(o.event.calendarId), 30)}
                    className="block h-5 w-full truncate rounded-[3px] px-1 text-left text-[12px] leading-5 text-fg hover:brightness-95 dark:hover:brightness-125"
                  >
                    {eventTitle(o)}
                  </button>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="relative flex" style={{ height: 24 * HOUR_PX }}>
          <div className={cn(GUTTER, 'relative')} aria-hidden="true">
            {Array.from({ length: 23 }, (_, i) => (
              <span key={i} className="tnum absolute right-2 -translate-y-1/2 text-[11px] leading-none text-faint" style={{ top: (i + 1) * HOUR_PX }}>{fmt.hour(i + 1)}</span>
            ))}
          </div>
          <div
            ref={cols}
            className="relative grid min-w-0 flex-1"
            style={{ ...gridCols, backgroundImage: 'linear-gradient(to bottom, var(--color-border) 1px, transparent 1px)', backgroundSize: `100% ${HOUR_PX}px` }}
          >
            {perDay.map((p) => {
              const isToday = isSameDay(p.day, today);
              return (
                <div key={dayKey(p.day)} className="relative min-w-0 border-l border-border first:border-l-0" onClick={(e) => slotClick(e, p.day)}>
                  {isToday && (
                    <div aria-hidden="true" className="pointer-events-none absolute right-0 left-0 z-20 flex items-center" style={{ top: ((now - startOfDay(p.day).getTime()) / 3_600_000) * HOUR_PX }}>
                      <span className="-ml-1 size-2 rounded-full bg-danger" />
                      <span className="h-px flex-1 bg-danger" />
                    </div>
                  )}
                  {p.placed.map((pl) => {
                    const o = p.byKey.get(pl.id)!;
                    const dragging = drag?.key === pl.id;
                    return (
                      <button
                        key={pl.id}
                        type="button"
                        onClick={() => !justDragged.current && onOpen(o)}
                        onPointerDown={(e) => startDrag(e, o)}
                        style={{
                          ...tint(colorOf(o.event.calendarId), dragging ? 34 : 20),
                          top: (pl.start / 60) * HOUR_PX,
                          height: ((pl.end - pl.start) / 60) * HOUR_PX - 1,
                          left: `calc(${(pl.col / pl.cols) * 100}% + 1px)`,
                          width: `calc(${100 / pl.cols}% - 3px)`,
                          transform: dragging ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
                          touchAction: o.event.rrule ? undefined : 'none',
                        }}
                        className={cn(
                          'absolute z-10 overflow-hidden rounded-[4px] px-1.5 py-0.5 text-left text-[12px] leading-4 text-fg hover:brightness-95 dark:hover:brightness-125',
                          dragging && drag.moved && 'z-30 cursor-grabbing shadow-md',
                        )}
                      >
                        <span className="block truncate font-medium">{eventTitle(o)}</span>
                        {pl.end - pl.start >= 40 && <span className="tnum block truncate text-muted">{fmt.time(new Date(o.start))} – {fmt.time(new Date(o.end))}</span>}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The current time in ms, refreshed every minute. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
