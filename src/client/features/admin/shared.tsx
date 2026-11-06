import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function genPassword(len = 16): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-b border-border text-left text-[13px] [&_td]:h-12 [&_td]:px-3 [&_td]:py-1.5 [&_td:first-child]:pl-0 [&_td:last-child]:pr-0">
        <thead className="border-b border-border text-[12px] text-muted">
          <tr>{head.map((h, i) => <th key={i} scope="col" className={cn('h-8 px-3 font-medium first:pl-0 last:pr-0', !h && 'w-10')}>{h ? h : <span className="sr-only">Actions</span>}</th>)}</tr>
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
  return <span className={cn('inline-flex h-5 items-center rounded-[4px] px-1.5 text-[12px] font-medium', cls)}>{children}</span>;
}
