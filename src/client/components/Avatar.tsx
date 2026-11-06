import type { Address } from '@shared/api';
import { avatarHue, initials } from '../lib/format';
import { cn } from '../lib/cn';

export function Avatar({ address, size = 32, className }: { address: Address; size?: number; className?: string }) {
  const hue = avatarHue(address.email.toLowerCase());
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold select-none', className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.38),
        background: `hsl(${hue} 70% 92%)`,
        color: `hsl(${hue} 45% 32%)`,
      }}
    >
      {initials(address)}
    </span>
  );
}
