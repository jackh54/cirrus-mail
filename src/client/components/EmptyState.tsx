import type { ReactNode } from 'react';

export function EmptyState({
  icon, title, body, action,
}: { icon: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center px-8 py-12 text-center">
      <div className="mb-3 text-faint [&_svg]:size-6 [&_svg]:stroke-[1.5]">{icon}</div>
      <h3 className="text-[14px] font-medium text-fg">{title}</h3>
      {body && <p className="mt-1 max-w-72 text-[13px] text-muted">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
