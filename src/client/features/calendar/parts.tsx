import { useEffect, type CSSProperties, type RefObject } from 'react';
import { addDays, dayKey, type Weekday } from './dates';
import type { Occ } from './model';

export type ColorOf = (calendarId: string) => string;

/** Tint from the calendar colour that works on both themes: a translucent fill and a solid left edge. */
export function tint(color: string, strength = 18): CSSProperties {
  return { backgroundColor: `color-mix(in srgb, ${color} ${strength}%, transparent)`, borderLeft: `3px solid ${color}` };
}

export const eventTitle = (o: Occ): string => o.event.title || '(No title)';

/**
 * Arrow keys move the focused day (left/right by a day, up/down by `rowStep`), Home/End jump within the week row.
 * When focus is inside the grid it follows the focused day, so the roving tabindex always has a target.
 */
export function useGridFocus(grid: RefObject<HTMLElement | null>, focus: Date, setFocus: (d: Date) => void, rowStep: number, weekStart: Weekday) {
  const key = dayKey(focus);
  useEffect(() => {
    const el = grid.current;
    if (el && el.contains(document.activeElement)) el.querySelector<HTMLElement>(`[data-day="${key}"]`)?.focus();
  }, [key, grid]);
  return (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -rowStep, ArrowDown: rowStep };
    if (e.key in step) {
      e.preventDefault();
      setFocus(addDays(focus, step[e.key]));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const offset = (focus.getDay() - weekStart + 7) % 7;
      setFocus(addDays(focus, e.key === 'Home' ? -offset : 6 - offset));
    }
  };
}
