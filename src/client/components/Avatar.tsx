import type { Address } from '@shared/api';
import { initials } from '../lib/format';
import { cn } from '../lib/cn';

/** Small monochrome initials avatar (reader header only). */
export function Avatar({ address, size = 32, className }: { address: Address; size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full bg-surface-2 font-medium text-muted select-none', className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {initials(address)}
    </span>
  );
}
