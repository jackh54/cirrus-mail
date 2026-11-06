import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { cn } from '../lib/cn';

export interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
}

/** Shell for Settings and Admin: a left nav on desktop, scrollable tabs on mobile. */
export function PageShell({ title, nav, children }: { title: string; nav: NavItem[]; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-bg md:flex-row">
      <aside className="shrink-0 border-border bg-sidebar max-md:border-b md:w-56 md:border-r">
        <div className="px-2 pt-2.5 md:pt-3">
          <NavLink to="/" className="flex h-7 items-center gap-2 rounded-md px-2 text-[13px] text-muted hover:bg-hover hover:text-fg">
            <ArrowLeft size={16} strokeWidth={1.75} /> Back to mail
          </NavLink>
        </div>
        <h2 className="px-4 pt-4 pb-1 text-[12px] font-medium text-faint max-md:hidden">{title}</h2>
        <nav aria-label={title} className="flex gap-0.5 overflow-x-auto px-2 pt-1 pb-2 md:flex-col md:overflow-visible md:pt-0">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cn(
                  'flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-[13px] whitespace-nowrap [&_svg]:size-4 [&_svg]:stroke-[1.75]',
                  isActive ? 'bg-hover font-medium text-fg [&_svg]:text-fg' : 'text-muted hover:bg-hover hover:text-fg',
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
        <div className="mx-auto max-w-[720px] px-4 py-6 sm:px-10 sm:py-10">{children}</div>
      </main>
    </div>
  );
}

export function PageTitle({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[20px] leading-7 font-semibold tracking-[-0.015em]">{title}</h1>
        {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** A settings group: hairline above, title and description, then the controls. No card chrome. */
export function Section({ title, description, children, footer, id }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode; id?: string }) {
  return (
    <section id={id} className="border-t border-border py-7 first-of-type:border-t-0 first-of-type:pt-0">
      <div className="mb-4">
        <h2 className="text-[14px] leading-5 font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      <div>{children}</div>
      {footer && <div className="mt-5 flex items-center justify-end gap-2">{footer}</div>}
    </section>
  );
}
