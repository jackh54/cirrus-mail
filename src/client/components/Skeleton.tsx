import { cn } from '../lib/cn';

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-shimmer rounded-md bg-surface-2', className)} aria-hidden="true" />;
}

export function ThreadRowSkeleton() {
  return (
    <div className="flex gap-3 border-b border-border/60 px-4 py-3">
      <Skeleton className="size-8 shrink-0 rounded-full" />
      <div className="flex-1 space-y-2 pt-0.5">
        <div className="flex justify-between gap-6">
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="h-3 w-10" />
        </div>
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}
