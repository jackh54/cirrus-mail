/** Touch gesture helpers for the phone layout. Every listener is passive, so scrolling never waits on JS. */

/** Movement (px) before a touch commits to an axis. */
const AXIS_LOCK_PX = 10;
/** Touches starting this close to the left edge belong to edge gestures (drawer, back). */
export const EDGE_PX = 24;

export interface HorizontalDrag {
  /** Return false to ignore this touch (e.g. it did not start at the edge). */
  start?: (x: number, y: number) => boolean;
  /** Called once when the touch locks to the horizontal axis. */
  lock?: () => void;
  /** Horizontal offset since the touch started, only after the horizontal lock. */
  move: (dx: number) => void;
  /** `vx` is the release velocity in px/ms (positive is rightwards). */
  end: (dx: number, vx: number) => void;
  /** The touch was cancelled (e.g. the browser took it over for its own gesture). */
  cancel?: () => void;
}

/**
 * Tracks a one-finger horizontal drag on `el`. The axis locks after 10px: a vertical start is left to
 * native scrolling and ignored until the finger lifts. Pair it with `touch-action: pan-y` on the element
 * so the browser never scrolls horizontally underneath the drag. Returns a cleanup function.
 */
export function trackHorizontalDrag(el: HTMLElement, h: HorizontalDrag): () => void {
  let x0 = 0;
  let y0 = 0;
  let axis: 'none' | 'x' | 'y' | 'off' = 'off';
  let last = { x: 0, t: 0 };
  let prev = { x: 0, t: 0 };

  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) {
      if (axis === 'x') h.cancel?.();
      axis = 'off';
      return;
    }
    const t = e.touches[0];
    if (h.start && !h.start(t.clientX, t.clientY)) {
      axis = 'off';
      return;
    }
    x0 = t.clientX;
    y0 = t.clientY;
    axis = 'none';
    last = prev = { x: x0, t: e.timeStamp };
  };
  const onMove = (e: TouchEvent) => {
    if (axis === 'off' || axis === 'y') return;
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - x0;
    const dy = t.clientY - y0;
    if (axis === 'none') {
      if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
      axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (axis === 'y') return;
      h.lock?.();
    }
    prev = last;
    last = { x: t.clientX, t: e.timeStamp };
    h.move(dx);
  };
  const onEnd = (e: TouchEvent) => {
    if (axis === 'x') {
      const t = e.changedTouches[0];
      const x = t?.clientX ?? last.x;
      const dt = Math.max(1, last.t - prev.t);
      // A finger resting before release is not a fling.
      const vx = e.timeStamp - last.t > 80 ? 0 : (last.x - prev.x) / dt;
      h.end(x - x0, vx);
    }
    axis = 'off';
  };
  const onCancel = () => {
    if (axis === 'x') h.cancel?.();
    axis = 'off';
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
}

/** A drag past this share of the width, or a fling in the same direction, commits the gesture. */
export function committed(dx: number, vx: number, width: number, share = 0.3): boolean {
  const fling = Math.abs(vx) > 0.5 && Math.sign(vx) === Math.sign(dx) && Math.abs(dx) > 24;
  return Math.abs(dx) > width * share || fling;
}

/** A light tap of haptic feedback where the platform supports it (Android; iOS Safari ignores it). */
export function haptic(): void {
  try {
    navigator.vibrate?.(10);
  } catch {
    /* vibration blocked by the browser */
  }
}

/** Slide `el` to `x` px with the release curve, then run `done`. Motion stays within the 120ms budget. */
export function settle(el: HTMLElement, x: number, done?: () => void): void {
  el.style.transition = 'transform 120ms var(--ease-out-soft)';
  el.style.transform = x ? `translate3d(${x}px,0,0)` : '';
  let fired = false;
  const finish = () => {
    if (fired) return;
    fired = true;
    el.style.transition = '';
    done?.();
  };
  el.addEventListener('transitionend', finish, { once: true });
  setTimeout(finish, 160);
}
