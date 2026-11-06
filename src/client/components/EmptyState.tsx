import type { ReactNode } from 'react';

export function EmptyState({
  icon, title, body, action,
}: { icon: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center px-8 py-12 text-center animate-fade-in">
      <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-primary-soft text-primary">{icon}</div>
      <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
      {body && <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-muted">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
