import { cn } from '../../lib/cn';

export function railLinkClass(active: boolean): string {
  return cn(
    'group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors duration-150',
    active ? 'bg-selected font-medium text-selected-fg' : 'text-muted hover:bg-hover hover:text-fg',
  );
}

export function Badge({ n, strong }: { n: number; strong?: boolean }) {
  if (!n) return null;
  return (
    <span className={cn('ml-auto text-xs tabular-nums', strong ? 'font-semibold text-fg' : 'text-faint')}>{n > 999 ? '999+' : n}</span>
  );
}
