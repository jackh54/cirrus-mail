import { useEffect, useRef, type ReactNode } from 'react';
import { Archive, Mail, MailOpen } from 'lucide-react';
import type { ThreadSummary } from '@shared/api';
import { committed, EDGE_PX, haptic, settle, trackHorizontalDrag } from '../../components/gestures';

export type SwipeAction = 'archive' | 'read' | 'unread';

interface Props {
  thread: ThreadSummary;
  /** Swipe gestures on (touch, motion allowed, a folder where they make sense). */
  swipe: boolean;
  canArchive: boolean;
  onSwipe: (action: SwipeAction, t: ThreadSummary) => void;
  onLongPress: (t: ThreadSummary) => void;
  children: ReactNode;
}

const ARM_SHARE = 0.3;
const LONG_PRESS_MS = 500;

/**
 * Touch wrapper for a thread row. Swipe left archives (cobalt), swipe right toggles read (graphite);
 * past 30% of the width, or on a fling, the action commits. A long press opens the row's action sheet.
 * The row moves by direct style writes from passive listeners, so a drag never re-renders React.
 */
export function SwipeRow({ thread: t, swipe, canArchive, onSwipe, onLongPress, children }: Props) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const bg = useRef<HTMLDivElement>(null);
  // Set after a swipe or long press so the click that follows the touch does not open the thread.
  const swallowClick = useRef(false);
  const latest = useRef({ t, canArchive, onSwipe, onLongPress });
  latest.current = { t, canArchive, onSwipe, onLongPress };

  useEffect(() => {
    const el = outer.current;
    const row = inner.current;
    const back = bg.current;
    if (!el || !row) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reset: ReturnType<typeof setTimeout> | null = null;
    let armed = false;
    let pressed = false;
    let x0 = 0;
    let y0 = 0;
    const cancelPress = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const hide = () => {
      back?.removeAttribute('data-dir');
      back?.removeAttribute('data-armed');
      armed = false;
    };

    // Long press: hold still for 500ms.
    const onStart = (e: TouchEvent) => {
      cancelPress();
      pressed = false;
      if (e.touches.length !== 1) return;
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      timer = setTimeout(() => {
        timer = null;
        pressed = true;
        swallowClick.current = true;
        haptic();
        latest.current.onLongPress(latest.current.t);
      }, LONG_PRESS_MS);
    };
    const onMove = (e: TouchEvent) => {
      const p = e.touches[0];
      if (timer && p && Math.hypot(p.clientX - x0, p.clientY - y0) > 10) cancelPress();
    };
    const opts = { passive: true } as const;
    el.addEventListener('touchstart', onStart, opts);
    el.addEventListener('touchmove', onMove, opts);
    el.addEventListener('touchend', cancelPress, opts);
    el.addEventListener('touchcancel', cancelPress, opts);

    const stopDrag = swipe && back
      ? trackHorizontalDrag(el, {
          // The left edge belongs to the drawer swipe.
          start: (x) => x >= EDGE_PX,
          lock: () => {
            cancelPress();
            if (reset) clearTimeout(reset);
            swallowClick.current = true;
          },
          move: (dx) => {
            if (pressed) return;
            const allowed = dx > 0 || latest.current.canArchive;
            // A blocked direction only gives a little, like a rubber band.
            const x = allowed ? dx : dx * 0.15;
            row.style.transition = '';
            row.style.transform = `translate3d(${x}px,0,0)`;
            if (!allowed) return hide();
            back.dataset.dir = dx < 0 ? 'archive' : 'read';
            const now = Math.abs(dx) > el.offsetWidth * ARM_SHARE;
            if (now !== armed) {
              armed = now;
              if (now) {
                back.setAttribute('data-armed', '');
                haptic();
              } else back.removeAttribute('data-armed');
            }
          },
          end: (dx, vx) => {
            if (pressed) return settle(row, 0, hide);
            const { t: cur, canArchive: archivable } = latest.current;
            const w = el.offsetWidth;
            const go = committed(dx, vx, w, ARM_SHARE) && (dx > 0 || archivable);
            if (go && dx < 0) {
              if (!armed) haptic();
              settle(row, -w, () => {
                latest.current.onSwipe('archive', cur);
                // The row normally leaves the list optimistically; if it stays (e.g. Starred), bring it back.
                reset = setTimeout(() => {
                  row.style.transform = '';
                  hide();
                }, 400);
              });
            } else {
              if (go) {
                if (!armed) haptic();
                latest.current.onSwipe(cur.unreadCount > 0 ? 'read' : 'unread', cur);
              }
              settle(row, 0, hide);
            }
          },
          cancel: () => settle(row, 0, hide),
        })
      : undefined;

    return () => {
      cancelPress();
      if (reset) clearTimeout(reset);
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', cancelPress);
      el.removeEventListener('touchcancel', cancelPress);
      stopDrag?.();
    };
  }, [swipe]);

  const unread = t.unreadCount > 0;
  return (
    <div
      ref={outer}
      className={swipe ? 'relative overflow-hidden [touch-action:pan-y_pinch-zoom]' : 'relative'}
      onClickCapture={(e) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
      onTouchStart={() => {
        swallowClick.current = false;
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {swipe && (
        <div
          ref={bg}
          aria-hidden="true"
          className={
            'group/sw absolute inset-0 hidden items-center px-6 text-[13px] font-medium text-white ' +
            'data-[dir=archive]:flex data-[dir=archive]:justify-end data-[dir=archive]:bg-primary-fill ' +
            'data-[dir=read]:flex data-[dir=read]:justify-start data-[dir=read]:bg-graphite-600'
          }
        >
          <span className="hidden flex-col items-center gap-1 opacity-70 transition-[opacity,scale] duration-100 group-data-armed/sw:scale-110 group-data-armed/sw:opacity-100 group-data-[dir=read]/sw:flex">
            {unread ? <MailOpen size={20} strokeWidth={1.75} /> : <Mail size={20} strokeWidth={1.75} />}
            {unread ? 'Read' : 'Unread'}
          </span>
          <span className="hidden flex-col items-center gap-1 opacity-70 transition-[opacity,scale] duration-100 group-data-armed/sw:scale-110 group-data-armed/sw:opacity-100 group-data-[dir=archive]/sw:flex">
            <Archive size={20} strokeWidth={1.75} />
            Archive
          </span>
        </div>
      )}
      <div ref={inner}>{children}</div>
    </div>
  );
}
