import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';

export type MenuItem =
  | { kind?: 'item'; label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string }
  | { kind: 'separator' }
  | { kind: 'heading'; label: string };

interface TriggerProps {
  ref: (el: HTMLButtonElement | null) => void;
  onClick: () => void;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string;
}

interface MenuProps {
  trigger: (p: TriggerProps) => ReactNode;
  items: MenuItem[];
  align?: 'start' | 'end';
  label: string;
  width?: number;
}

/** Accessible dropdown rendered in a portal (so scroll containers never clip it). */
export function Menu({ trigger, items, align = 'end', label, width = 220 }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerEl = useRef<HTMLButtonElement | null>(null);
  const menuEl = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerEl.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || !triggerEl.current) return;
    const r = triggerEl.current.getBoundingClientRect();
    const h = menuEl.current?.offsetHeight ?? 0;
    let top = r.bottom + 4;
    if (top + h > innerHeight - 8 && r.top - h - 4 > 8) top = r.top - h - 4;
    let left = align === 'end' ? r.right - width : r.left;
    left = Math.max(8, Math.min(left, innerWidth - width - 8));
    setPos({ top, left });
    menuEl.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [open, align, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menuEl.current?.contains(t) && !triggerEl.current?.contains(t)) close(false);
    };
    const onScroll = (e: Event) => {
      if (!menuEl.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    const onResize = () => close(false);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const els = Array.from(menuEl.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') els[(i + 1) % els.length]?.focus();
    else if (e.key === 'ArrowUp') els[(i - 1 + els.length) % els.length]?.focus();
    else if (e.key === 'Home') els[0]?.focus();
    else if (e.key === 'End') els[els.length - 1]?.focus();
    else if (e.key === 'Escape') close();
    else if (e.key === 'Tab') close(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const host = triggerEl.current?.closest('dialog') ?? document.body;

  return (
    <>
      {trigger({
        ref: (el) => {
          triggerEl.current = el;
        },
        onClick: () => setOpen((o) => !o),
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': id,
      })}
      {open &&
        createPortal(
          <div
            ref={menuEl}
            id={id}
            role="menu"
            aria-label={label}
            onKeyDown={onKeyDown}
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width }}
            className="fixed z-[70] max-h-[60vh] overflow-y-auto rounded-xl border border-border bg-elevated p-1 shadow-pop animate-fade-in"
          >
            {items.map((it, i) => {
              if (it.kind === 'separator') return <div key={i} role="separator" className="my-1 h-px bg-border" />;
              if (it.kind === 'heading')
                return (
                  <div key={i} className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">
                    {it.label}
                  </div>
                );
              return (
                <button
                  key={i}
                  type="button"
                  role="menuitem"
                  disabled={it.disabled}
                  onClick={() => {
                    close();
                    it.onSelect();
                  }}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13.5px] outline-none',
                    'hover:bg-hover focus-visible:bg-hover disabled:opacity-40',
                    it.danger ? 'text-danger' : 'text-fg',
                  )}
                >
                  {it.icon && <span className="shrink-0 text-muted [&>svg]:size-4">{it.icon}</span>}
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {it.hint && <span className="text-xs text-faint">{it.hint}</span>}
                </button>
              );
            })}
          </div>,
          host,
        )}
    </>
  );
}
