import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { Settings } from 'lucide-react';
import { railLinkClass } from '../features/mail/railStyles';
import { LogoMark } from './Logo';
import { AppSwitcher } from './AppSwitcher';

/** The left column of the Calendar and Contacts pages (a drawer on phones): app switcher, page tools, Settings. */
export function AppSidebar({ label, children, onNavigate }: { label: string; children?: ReactNode; onNavigate?: () => void }) {
  return (
    <nav aria-label={label} className="flex h-full w-full flex-col bg-sidebar md:w-60 md:shrink-0 md:border-r md:border-border">
      <div className="flex h-12 shrink-0 items-center gap-2 px-4 pointer-coarse:h-14">
        <LogoMark size={18} className="shrink-0" />
        <span className="text-[13px] font-semibold text-fg">Cirrus</span>
      </div>
      <AppSwitcher onNavigate={onNavigate} />
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pt-1 pb-3">{children}</div>
      <div className="border-t border-border p-2">
        <NavLink to="/settings/profile" onClick={onNavigate} className={({ isActive }) => railLinkClass(isActive)}>
          <Settings /> Settings
        </NavLink>
      </div>
    </nav>
  );
}
