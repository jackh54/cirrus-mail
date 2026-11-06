import { useEffect, useRef, type RefObject } from 'react';
import { haptic } from '../../components/gestures';

/** Pull distance (after damping) that triggers a refresh, and the furthest the spinner travels. */
const TRIGGER_PX = 64;
const MAX_PX = 96;
/** Keep the spinner up at least this long so a fast refetch does not flash. */
const MIN_SPIN_MS = 450;

/**
 * Pull to refresh for a scroll container (the list scrolls, not the page, so the browser's own
 * gesture never applies). Listeners are passive: the native overscroll bounce still happens on iOS,
 * and the spinner in `indicator` follows the finger through direct style writes.
 */
export function usePullToRefresh(
  scrollRef: RefObject<HTMLElement | null>,
  indicator: RefObject<HTMLElement | null>,
  onRefresh: () => Promise<unknown>,
  enabled: boolean,
) {
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;

  useEffect(() => {
    const el = scrollRef.current;
    const ind = indicator.current;
    if (!enabled || !el || !ind) return;
    const icon = ind.firstElementChild as HTMLElement | null;
    let y0 = 0;
    let x0 = 0;
    let state: 'off' | 'maybe' | 'pull' = 'off';
    let dist = 0;
    let busy = false;

    const place = (d: number, animate: boolean) => {
      ind.style.transition = animate ? 'transform 120ms var(--ease-out-soft), opacity 120ms' : '';
      ind.style.transform = `translate3d(0,${d - 40}px,0)`;
      ind.style.opacity = String(Math.min(1, d / TRIGGER_PX));
      if (icon && !busy) icon.style.transform = `rotate(${d * 4}deg)`;
    };
    const onStart = (e: TouchEvent) => {
      state = !busy && e.touches.length === 1 && el.scrollTop <= 0 ? 'maybe' : 'off';
      if (state === 'off') return;
      y0 = e.touches[0].clientY;
      x0 = e.touches[0].clientX;
      dist = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (state === 'off') return;
      const p = e.touches[0];
      const dy = p.clientY - y0;
      if (state === 'maybe') {
        if (Math.abs(dy) < 10 && Math.abs(p.clientX - x0) < 10) return;
        // Only a downward, mostly vertical drag that starts at the top is a pull.
        state = dy > 0 && Math.abs(dy) > Math.abs(p.clientX - x0) ? 'pull' : 'off';
        if (state === 'off') return;
      }
      if (el.scrollTop > 0) {
        state = 'off';
        place(0, true);
        return;
      }
      const prev = dist;
      dist = Math.min(MAX_PX, Math.max(0, dy) * 0.5);
      if (prev < TRIGGER_PX && dist >= TRIGGER_PX) haptic();
      place(dist, false);
    };
    const onEnd = () => {
      if (state !== 'pull') return;
      state = 'off';
      if (dist < TRIGGER_PX) return place(0, true);
      busy = true;
      place(TRIGGER_PX * 0.75, true);
      ind.style.opacity = '1';
      icon?.classList.add('animate-spin');
      if (icon) icon.style.transform = '';
      const started = Date.now();
      void refresh
        .current()
        .catch(() => undefined)
        .then(() => new Promise((r) => setTimeout(r, Math.max(0, MIN_SPIN_MS - (Date.now() - started)))))
        .then(() => {
          busy = false;
          icon?.classList.remove('animate-spin');
          place(0, true);
        });
    };

    const onCancel = () => {
      if (state === 'pull') place(0, true);
      state = 'off';
    };

    const opts = { passive: true } as const;
    el.addEventListener('touchstart', onStart, opts);
    el.addEventListener('touchmove', onMove, opts);
    el.addEventListener('touchend', onEnd, opts);
    el.addEventListener('touchcancel', onCancel, opts);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onCancel);
    };
  }, [enabled, scrollRef, indicator]);
}
