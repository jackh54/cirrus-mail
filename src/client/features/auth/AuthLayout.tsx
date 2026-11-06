import type { ReactNode } from 'react';
import { LogoMark } from '../../components/Logo';

/** Centered, minimal frame used by Setup and Login: a small mark, a title and the form. */
export function AuthLayout({ title, subtitle, children, wide }: { title: string; subtitle?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-bg px-4 py-12">
      <main className={`w-full ${wide ? 'max-w-[440px]' : 'max-w-[340px]'}`}>
        <div className="mb-7 flex flex-col items-center text-center">
          <LogoMark size={32} />
          <h1 className="mt-5 text-[18px] leading-6 font-semibold tracking-[-0.01em]">{title}</h1>
          {subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
        </div>
        {children}
      </main>
      <p className="mt-10 text-center text-[12px] text-faint">Cirrus Mail runs on your own Cloudflare account.</p>
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
      {message}
    </div>
  );
}
