import { Link, useLocation } from 'react-router';
import { CalendarDays, Mail, Users } from 'lucide-react';
import { cn } from '../lib/cn';

const APPS = [
  { id: 'mail', to: '/', label: 'Mail', icon: Mail },
  { id: 'calendar', to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'contacts', to: '/contacts', label: 'Contacts', icon: Users },
] as const;

/** Mail / Calendar / Contacts, at the top of every sidebar and phone drawer. */
export function AppSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const section = useLocation().pathname.split('/')[1];
  const current = section === 'calendar' || section === 'contacts' ? section : 'mail';
  return (
    <nav aria-label="Apps" className="mx-2 mb-2 grid grid-cols-3 gap-0.5 rounded-md bg-surface-2 p-0.5">
      {APPS.map((a) => (
        <Link
          key={a.id}
          to={a.to}
          onClick={onNavigate}
          aria-current={current === a.id ? 'page' : undefined}
          className={cn(
            'flex h-7 items-center justify-center gap-1.5 rounded-[5px] text-[12px] font-medium pointer-coarse:h-10 pointer-coarse:text-[14px] [&_svg]:size-3.5 [&_svg]:stroke-[1.75]',
            current === a.id ? 'bg-bg text-fg shadow-[0_1px_1px_rgb(0_0_0/0.06)] dark:bg-hover' : 'text-muted hover:text-fg',
          )}
        >
          <a.icon aria-hidden="true" />
          {a.label}
        </Link>
      ))}
    </nav>
  );
}
