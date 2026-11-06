import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, Menu as MenuIcon, Plus } from 'lucide-react';
import { Button, IconButton } from '../../components/Button';
import { Drawer } from '../../components/Drawer';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useHotkeys } from '../../lib/hotkeys';
import { useCollections, useEventMutations, useEvents } from '../../lib/queries/dav';
import { useLayoutMode } from '../mail/useMailRoute';
import { AgendaView } from './AgendaView';
import { CalendarSidebar } from './CalendarSidebar';
import {
  addDays, addMonths, dayKey, fmt, localeWeekStart, monthGrid, parseDayKey, rangeTitle, startOfDay, startOfMonth, weekDays,
} from './dates';
import { EventDialog, type EventDialogState } from './EventDialog';
import { colorFor, inputWithTimes, occurrencesBetween, toCalEvent, type Occ } from './model';
import { MonthView } from './MonthView';
import { TimeGrid } from './TimeGrid';

type View = 'month' | 'week' | 'day' | 'agenda';
const DESKTOP_VIEWS: View[] = ['month', 'week', 'day'];
const PHONE_VIEWS: View[] = ['agenda', 'day'];
const VIEW_LABEL: Record<View, string> = { month: 'Month', week: 'Week', day: 'Day', agenda: 'Agenda' };
const AGENDA_DAYS = 30;
const HIDDEN_KEY = 'cirrus:hiddenCalendars';

function loadHidden(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** The next whole hour, on `day` if it is not today. */
function defaultSlot(day: Date, now = new Date()): Date {
  const sameDay = dayKey(day) === dayKey(now);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), sameDay ? Math.min(now.getHours() + 1, 22) : 9);
}

export function CalendarPage() {
  const layout = useLayoutMode();
  const mobile = layout === 'mobile';
  const [sp, setSp] = useSearchParams();
  const { toast } = useToast();
  const [drawer, setDrawer] = useState(false);
  const [dialog, setDialog] = useState<EventDialogState | null>(null);
  const [hidden, setHidden] = useState(loadHidden);
  const [today, setToday] = useState(() => startOfDay(new Date()));
  const weekStart = useMemo(() => localeWeekStart(), []);

  const allowed = mobile ? PHONE_VIEWS : DESKTOP_VIEWS;
  const asked = sp.get('v') as View | null;
  const view: View = asked && allowed.includes(asked) ? asked : allowed[0];
  const focus = useMemo(() => parseDayKey(sp.get('d') ?? '') ?? today, [sp, today]);

  const go = useCallback((d: Date, v: View = view) => setSp({ d: dayKey(d), v }, { replace: true }), [setSp, view]);
  const goToday = useCallback(() => go(startOfDay(new Date())), [go]);

  // The date rolls over while the tab stays open.
  useEffect(() => {
    const id = setInterval(() => setToday((t) => (dayKey(t) === dayKey(new Date()) ? t : startOfDay(new Date()))), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    document.title = 'Calendar - Cirrus Mail';
    return () => {
      document.title = 'Cirrus Mail';
    };
  }, []);

  // ---------- data ----------
  const collections = useCollections();
  const calendars = useMemo(() => (collections.data ?? []).filter((c) => c.kind === 'calendar'), [collections.data]);
  const colorOf = useCallback(
    (id: string) => {
      const i = calendars.findIndex((c) => c.id === id);
      return colorFor(calendars[i]?.color, Math.max(i, 0));
    },
    [calendars],
  );
  // One window of three months either side of the focus month's start is fetched; navigating inside it is instant.
  const winFrom = startOfMonth(addMonths(focus, -1));
  const winTo = startOfMonth(addMonths(focus, 3));
  const events = useEvents(winFrom.toISOString(), winTo.toISOString());
  const { update } = useEventMutations();

  const [rangeFrom, rangeTo] = useMemo((): [Date, Date] => {
    if (view === 'month') {
      const g = monthGrid(focus, weekStart);
      return [g[0], addDays(g[41], 1)];
    }
    if (view === 'week') {
      const w = weekDays(focus, weekStart);
      return [w[0], addDays(w[6], 1)];
    }
    if (view === 'day') return [startOfDay(focus), addDays(startOfDay(focus), 1)];
    return [startOfDay(focus), addDays(startOfDay(focus), AGENDA_DAYS)];
  }, [view, focus, weekStart]);

  const occs = useMemo(() => {
    const calEvents = (events.data ?? []).filter((e) => !hidden.has(e.calendarId)).map(toCalEvent).filter((e) => e !== null);
    return occurrencesBetween(calEvents, rangeFrom, rangeTo);
  }, [events.data, hidden, rangeFrom, rangeTo]);

  // ---------- actions ----------
  const openNew = useCallback((start: Date, allDay = false) => setDialog({ kind: 'new', start, allDay }), []);
  const openOcc = useCallback((o: Occ) => setDialog({ kind: 'edit', event: o.event }), []);
  const newOnFocus = useCallback(() => openNew(defaultSlot(focus)), [openNew, focus]);

  // "New event" from the command palette arrives as ?new=1.
  useEffect(() => {
    if (sp.get('new') !== '1') return;
    setDialog({ kind: 'new', start: defaultSlot(focus), allDay: false });
    const next = new URLSearchParams(sp);
    next.delete('new');
    setSp(next, { replace: true });
  }, [sp, setSp, focus]);

  const toggle = (id: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (!next.delete(id)) next.add(id);
      try {
        localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
      } catch {
        /* a preference only */
      }
      return next;
    });

  const move = (o: Occ, start: number, end: number) =>
    update.mutate({ id: o.event.id, ...inputWithTimes(o.event, start, end) }, { onError: (e) => toast({ tone: 'error', title: "Couldn't move the event", description: errorMessage(e) }) });

  const step = (dir: 1 | -1) => {
    if (view === 'month') go(addMonths(focus, dir));
    else if (view === 'day') go(addDays(focus, dir));
    else go(addDays(focus, 7 * dir));
  };

  useHotkeys({
    t: goToday,
    n: newOnFocus,
    ...(mobile ? {} : { m: () => go(focus, 'month'), w: () => go(focus, 'week'), d: () => go(focus, 'day') }),
  });

  const title =
    view === 'month' ? fmt.monthYear(focus) : view === 'week' ? rangeTitle(rangeFrom, addDays(rangeTo, -1)) : view === 'day' ? fmt.dayLong(focus) : fmt.monthYear(focus);

  const sidebar = (
    <CalendarSidebar calendars={calendars} colorOf={colorOf} hidden={hidden} onToggle={toggle} onNewEvent={newOnFocus} onNavigate={mobile ? () => setDrawer(false) : undefined} />
  );
  const days = view === 'week' ? weekDays(focus, weekStart) : [startOfDay(focus)];

  return (
    <div className="relative flex h-full bg-bg">
      {mobile ? <Drawer open={drawer} onClose={() => setDrawer(false)} label="Calendars">{sidebar}</Drawer> : sidebar}
      <main className="flex min-w-0 flex-1 flex-col" aria-label="Calendar">
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-3 pointer-coarse:h-14">
          {mobile && <IconButton label="Menu" size="md" onClick={() => setDrawer(true)}><MenuIcon size={18} /></IconButton>}
          <Button size="sm" onClick={goToday} aria-keyshortcuts="T" className="max-sm:px-2">Today</Button>
          <IconButton label={`Previous ${view === 'month' ? 'month' : view === 'day' ? 'day' : 'week'}`} size="md" onClick={() => step(-1)}><ChevronLeft size={18} /></IconButton>
          <IconButton label={`Next ${view === 'month' ? 'month' : view === 'day' ? 'day' : 'week'}`} size="md" onClick={() => step(1)}><ChevronRight size={18} /></IconButton>
          <h1 aria-live="polite" className="min-w-0 flex-1 truncate px-1.5 text-[15px] font-semibold tracking-[-0.01em]">{title}</h1>
          <div role="radiogroup" aria-label="View" className="flex gap-0.5 rounded-md bg-surface-2 p-0.5">
            {allowed.map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={v === view}
                onClick={() => go(focus, v)}
                className={cn('h-6 rounded-[5px] px-2.5 text-[12px] font-medium pointer-coarse:h-8', v === view ? 'bg-bg text-fg shadow-[0_1px_1px_rgb(0_0_0/0.06)] dark:bg-hover' : 'text-muted hover:text-fg')}
              >
                {VIEW_LABEL[v]}
              </button>
            ))}
          </div>
        </div>
        {events.isError && !events.data ? (
          <p role="alert" className="p-6 text-[13px] text-danger">Couldn't load events: {errorMessage(events.error)}</p>
        ) : view === 'month' ? (
          <MonthView focus={focus} weekStart={weekStart} occs={occs} colorOf={colorOf} today={today} onFocus={(d) => go(d)} onCreate={(d) => openNew(defaultSlot(d))} onOpen={openOcc} onOpenDay={(d) => go(d, 'day')} />
        ) : view === 'agenda' ? (
          <AgendaView from={focus} days={AGENDA_DAYS} occs={occs} colorOf={colorOf} today={today} onOpen={openOcc} onCreate={newOnFocus} />
        ) : (
          <TimeGrid
            days={days}
            focus={focus}
            weekStart={weekStart}
            occs={occs}
            colorOf={colorOf}
            today={today}
            onFocus={(d) => go(d)}
            onCreate={(start, allDay) => openNew(start, allDay)}
            onOpen={openOcc}
            onOpenDay={(d) => go(d, 'day')}
            onMove={move}
          />
        )}
      </main>
      {mobile && (
        <button
          type="button"
          aria-label="New event"
          onClick={newOnFocus}
          className="fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 flex size-14 items-center justify-center rounded-full bg-primary-fill text-primary-fg shadow-[0_2px_6px_rgb(0_0_0/0.16),0_8px_24px_rgb(0_0_0/0.14)] transition-transform duration-100 active:scale-95 active:bg-primary-fill-hover"
        >
          <Plus size={22} strokeWidth={1.75} />
        </button>
      )}
      <EventDialog state={dialog} calendars={calendars} colorOf={colorOf} onClose={() => setDialog(null)} />
    </div>
  );
}
