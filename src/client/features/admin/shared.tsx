import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function genPassword(len = 16): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-surface">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead className="border-b border-border bg-surface-2/60 text-[12px] text-muted">
          <tr>{head.map((h, i) => <th key={i} scope="col" className={cn('px-4 py-2.5 font-medium', !h && 'w-10')}>{h ? h : <span className="sr-only">Actions</span>}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'primary' | 'danger' | 'success' }) {
  const cls = {
    neutral: 'bg-surface-2 text-muted',
    primary: 'bg-primary-soft text-selected-fg',
    danger: 'bg-danger-soft text-danger',
    success: 'bg-success-soft text-success',
  }[tone];
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium', cls)}>{children}</span>;
}
