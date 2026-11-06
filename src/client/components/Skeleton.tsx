import { cn } from '../lib/cn';

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-skeleton rounded bg-surface-2', className)} aria-hidden="true" />;
}

/** Same fixed height as a real row so the list does not shift when data arrives. */
export function ThreadRowSkeleton() {
  return (
    <div className="flex h-[58px] flex-col justify-center gap-2 border-b border-border px-4 pl-7 compact:h-10 compact:gap-0" aria-hidden="true">
      <div className="flex justify-between gap-6">
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="h-3 w-9" />
      </div>
      <Skeleton className="h-3 w-3/4 compact:hidden" />
    </div>
  );
}
