import { useId } from 'react';

/** In-app mark: a rounded envelope whose top flap is a soft cirrus-cloud stroke, iris to mint. */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="3" y1="5" x2="29" y2="27" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4F6BFF" />
          <stop offset="1" stopColor="#38D6C4" />
        </linearGradient>
      </defs>
      <rect x="3.5" y="7" width="25" height="18.5" rx="5" stroke={`url(#${id})`} strokeWidth="2.4" />
      <path
        d="M5.6 9.9C7.9 12.1 9.9 13.9 11.9 15.1C12.1 12.9 13.9 11.3 16 11.3C17.5 11.3 18.8 12.1 19.4 13.4C19.9 13.1 20.5 13 21.1 13C22.4 13 23.4 13.7 23.8 14.7C24.8 13.4 25.6 11.8 26.4 9.9"
        stroke={`url(#${id})`}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <LogoMark />
      <span className="text-[15px] font-semibold tracking-tight text-fg">
        Cirrus<span className="text-muted font-medium"> Mail</span>
      </span>
    </span>
  );
}
