import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

/** Left slide-over built on native <dialog> (inert background, Esc to close). */
export function Drawer({ open, onClose, label, children }: { open: boolean; onClose: () => void; label: string; children: ReactNode }) {
  if (!open) return null;
  return <DrawerInner onClose={onClose} label={label}>{children}</DrawerInner>;
}

function DrawerInner({ onClose, label, children }: { onClose: () => void; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (el && !el.open) el.showModal();
    return () => {
      if (el?.open) el.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    const onCancel = (e: Event) => {
      e.preventDefault();
      onCloseRef.current();
    };
    el?.addEventListener('cancel', onCancel);
    return () => el?.removeEventListener('cancel', onCancel);
  }, []);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      className="cm-drawer"
      onMouseDown={(e) => {
        if (e.target === ref.current) onCloseRef.current();
      }}
    >
      {children}
    </dialog>
  );
}
