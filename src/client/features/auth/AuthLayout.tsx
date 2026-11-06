import type { ReactNode } from 'react';
import { LogoMark } from '../../components/Logo';

/** Centered card on a soft gradient, used by Setup and Login. */
export function AuthLayout({ title, subtitle, children, wide }: { title: string; subtitle?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden px-4 py-12">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-70 dark:opacity-40"
        style={{
          background:
            'radial-gradient(60rem 30rem at 15% -10%, rgb(79 107 255 / 0.18), transparent 60%), radial-gradient(50rem 28rem at 110% 110%, rgb(56 214 196 / 0.16), transparent 60%)',
        }}
      />
      <main className={`relative w-full ${wide ? 'max-w-lg' : 'max-w-sm'} animate-rise-in`}>
        <div className="mb-7 flex flex-col items-center text-center">
          <LogoMark size={44} />
          <h1 className="mt-4 text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
        </div>
        <div className="rounded-2xl border border-border bg-surface p-6 shadow-pop">{children}</div>
        <p className="mt-6 text-center text-xs text-faint">Cirrus Mail runs on your own Cloudflare account.</p>
      </main>
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
      {message}
    </div>
  );
}
