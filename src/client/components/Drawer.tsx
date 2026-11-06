import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type ReactNode, type Ref } from 'react';
import { committed, settle, trackHorizontalDrag } from './gestures';

/** Lets an edge swipe drive the drawer while it opens: `drag` follows the finger, `release` settles it. */
export interface DrawerHandle {
  drag: (dx: number) => void;
  release: (open: boolean) => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  /** Opened by an edge swipe: start off-screen and let `handle.drag` position it. */
  dragging?: boolean;
  handle?: Ref<DrawerHandle>;
}

/**
 * Left slide-over built on native <dialog> (inert background, focus contained, Esc to close).
 * Tapping the scrim closes it; on touch screens it can also be swiped closed.
 */
export function Drawer({ open, ...rest }: Props) {
  if (!open) return null;
  return <DrawerInner {...rest} />;
}

function DrawerInner({ onClose, label, children, dragging, handle }: Omit<Props, 'open'>) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Only a press that starts and ends on the scrim closes it (not a drag out of the panel).
  const pressedScrim = useRef(false);

  useImperativeHandle(handle, () => ({
    drag: (dx) => {
      const el = ref.current;
      if (!el) return;
      const w = el.offsetWidth;
      const x = Math.min(0, dx - w);
      el.style.transform = `translate3d(${x}px,0,0)`;
      el.style.setProperty('--drawer-p', String(1 + x / w));
    },
    release: (open) => {
      const el = ref.current;
      if (!el) return;
      el.style.removeProperty('--drawer-p');
      if (open) settle(el, 0);
      else settle(el, -el.offsetWidth, () => onCloseRef.current());
    },
  }), []);

  useLayoutEffect(() => {
    const el = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (el && dragging) {
      el.style.transform = 'translate3d(-100%,0,0)';
      el.style.setProperty('--drawer-p', '0');
    }
    if (el && !el.open) {
      el.showModal();
      // Focus the panel itself (it is named), not the first control, so a touch open shows no focus ring.
      el.focus();
    }
    return () => {
      if (el?.open) el.close();
      if (opener?.isConnected) opener.focus();
    };
    // `dragging` only matters for the first frame.
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      onCloseRef.current();
    };
    el.addEventListener('cancel', onCancel);
    // Swipe left to close.
    const stop = trackHorizontalDrag(el, {
      move: (dx) => {
        el.style.transform = `translate3d(${Math.min(0, dx)}px,0,0)`;
      },
      end: (dx, vx) => {
        if (dx < 0 && committed(dx, vx, el.offsetWidth)) settle(el, -el.offsetWidth, () => onCloseRef.current());
        else settle(el, 0);
      },
      cancel: () => settle(el, 0),
    });
    return () => {
      el.removeEventListener('cancel', onCancel);
      stop();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      tabIndex={-1}
      className="cm-drawer outline-none"
      data-dragging={dragging ? '' : undefined}
      onPointerDown={(e) => {
        pressedScrim.current = e.target === ref.current;
      }}
      onClick={(e) => {
        if (e.target === ref.current && pressedScrim.current) onCloseRef.current();
        pressedScrim.current = false;
      }}
    >
      {children}
    </dialog>
  );
}
