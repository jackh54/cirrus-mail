import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface SheetAction {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Shown above the actions and used as the sheet's accessible name. */
  title: string;
  actions: SheetAction[];
}

/** iOS-style bottom action sheet on native <dialog> (focus contained, Esc and scrim tap close it). */
export function ActionSheet(props: Props) {
  if (!props.open) return null;
  return <SheetInner {...props} />;
}

function SheetInner({ onClose, title, actions }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Only a press that starts on the scrim closes it: the long press that opened the sheet ends
  // with a click that lands on the scrim, and must not close it again.
  const pressedScrim = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (el && !el.open) el.showModal();
    return () => {
      if (el?.open) el.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
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

  const item = 'flex h-12 w-full items-center justify-center gap-2.5 text-[16px] active:bg-hover [&_svg]:size-[18px] [&_svg]:stroke-[1.75]';
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className="cm-sheet"
      onPointerDown={(e) => {
        pressedScrim.current = e.target === ref.current;
      }}
      onClick={(e) => {
        if (e.target === ref.current && pressedScrim.current) onCloseRef.current();
        pressedScrim.current = false;
      }}
    >
      <div className="overflow-hidden rounded-[10px] bg-elevated shadow-pop">
        <p className="truncate border-b border-border px-4 py-2.5 text-center text-[13px] text-muted">{title}</p>
        <div className="divide-y divide-border">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={() => {
                onCloseRef.current();
                a.onSelect();
              }}
              className={cn(item, a.danger ? 'text-danger' : 'text-fg')}
            >
              {a.icon && <span className={a.danger ? 'text-danger' : 'text-muted'}>{a.icon}</span>}
              {a.label}
            </button>
          ))}
        </div>
      </div>
      <button type="button" onClick={() => onCloseRef.current()} className={cn(item, 'mt-2 rounded-[10px] bg-elevated font-semibold text-selected-fg shadow-pop')}>
        Cancel
      </button>
    </dialog>
  );
}
