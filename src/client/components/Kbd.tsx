import { cn } from '../lib/cn';

/** Key hint. `tone="onPrimary"` sits on a cobalt button. */
export function Kbd({ children, tone, className }: { children: string; tone?: 'onPrimary'; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] px-1 font-sans text-[11px] leading-none font-medium',
        tone === 'onPrimary' ? 'bg-white/18 text-white/90' : 'border border-border bg-bg text-muted',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
