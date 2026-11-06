import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from './Button';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** Hide the title visually (still announced). */
  bare?: boolean;
}

/**
 * Modal built on native <dialog>.showModal(): the rest of the page becomes inert (focus is
 * contained), Esc fires `cancel`, and focus returns to the opener when it closes.
 */
export function Dialog(props: DialogProps) {
  if (!props.open) return null;
  return <DialogInner {...props} />;
}

function DialogInner({ onClose, title, description, children, footer, width = 480, bare }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (el && !el.open) {
      el.showModal();
      // showModal focuses the first focusable (the close button); prefer the form's first field.
      const target =
        el.querySelector<HTMLElement>('[data-autofocus]') ??
        el.querySelector<HTMLElement>('[data-dialog-body] :is(input:not([type="hidden"]):not([type="checkbox"]):not([disabled]), textarea, select)');
      target?.focus();
    }
    return () => {
      if (el?.open) el.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      onCloseRef.current();
    };
    el.addEventListener('cancel', onCancel);
    return () => el.removeEventListener('cancel', onCancel);
  }, []);

  return (
    <dialog
      ref={ref}
      className="cm-dialog"
      style={{ ['--dialog-w' as string]: `${width}px` }}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onMouseDown={(e) => {
        if (e.target === ref.current) onCloseRef.current();
      }}
    >
      <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-1">
        <div className="min-w-0 pt-0.5">
          <h2 id={titleId} className={bare ? 'sr-only' : 'text-[15px] leading-6 font-semibold tracking-[-0.01em]'}>
            {title}
          </h2>
          {description && (
            <div id={descId} className="mt-1 text-[13px] leading-5 text-muted">
              {description}
            </div>
          )}
        </div>
        <IconButton label="Close" shortcut="Esc" tipAlign="end" onClick={() => onCloseRef.current()} className="-mr-2">
          <X size={16} />
        </IconButton>
      </div>
      {children && <div data-dialog-body className="px-5 py-4">{children}</div>}
      {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
    </dialog>
  );
}
