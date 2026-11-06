import { cn } from '../../lib/cn';

/** Sidebar item: 28px, 13px text, 16px icons at 1.75 stroke; active is a quiet fill, not cobalt. */
export function railLinkClass(active: boolean): string {
  return cn(
    'group flex h-7 items-center gap-2 rounded-md px-2 text-[13px] [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.75]',
    active
      ? 'bg-black/[0.055] font-medium text-fg dark:bg-white/[0.07] [&_svg]:text-fg'
      : 'text-muted hover:bg-black/[0.035] hover:text-fg dark:hover:bg-white/[0.04] [&_svg]:text-faint hover:[&_svg]:text-muted',
  );
}

/** Unread count: plain right-aligned tabular numbers. */
export function Badge({ n, strong }: { n: number; strong?: boolean }) {
  if (!n) return null;
  return <span className={cn('tnum ml-auto pl-2 text-[12px]', strong ? 'font-medium text-fg' : 'text-faint')}>{n > 999 ? '999+' : n}</span>;
}
