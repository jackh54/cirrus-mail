import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { cn } from '../lib/cn';
import { Logo } from './Logo';

export interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
}

/** Shell for Settings and Admin: side nav on desktop, scrollable tabs on mobile. */
export function PageShell({ title, nav, children }: { title: string; nav: NavItem[]; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-bg md:flex-row">
      <aside className="shrink-0 border-border bg-surface md:w-60 md:border-r">
        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2 md:block md:px-3">
          <Logo className="px-1.5" />
          <NavLink to="/" className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] text-muted hover:bg-hover hover:text-fg md:mt-4">
            <ArrowLeft size={15} /> Back to mail
          </NavLink>
        </div>
        <h2 className="px-5 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase max-md:hidden">{title}</h2>
        <nav aria-label={title} className="flex gap-1 overflow-x-auto px-3 pb-2 md:flex-col md:gap-0.5 md:overflow-visible">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cn(
                  'flex h-8 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] whitespace-nowrap transition-colors duration-150',
                  isActive ? 'bg-selected font-medium text-selected-fg' : 'text-muted hover:bg-hover hover:text-fg',
                )
              }
            >
              {n.icon}
              {n.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-10">{children}</div>
      </main>
    </div>
  );
}

export function PageTitle({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Section({ title, description, children, footer, id }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode; id?: string }) {
  return (
    <section id={id} className="mb-6 overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="px-5 pt-5">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {description && <p className="mt-1 text-[13px] leading-relaxed text-muted">{description}</p>}
      </div>
      <div className="px-5 py-5">{children}</div>
      {footer && <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-2/50 px-5 py-3">{footer}</div>}
    </section>
  );
}
