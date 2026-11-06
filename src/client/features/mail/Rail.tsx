import { NavLink, useNavigate } from 'react-router';
import { ChevronsUpDown, Keyboard, LogOut, PenLine, Settings, ShieldCheck } from 'lucide-react';
import type { Folder, MailboxSummary } from '@shared/api';
import { Button } from '../../components/Button';
import { Kbd } from '../../components/Kbd';
import { Logo } from '../../components/Logo';
import { Menu } from '../../components/Menu';
import { Skeleton } from '../../components/Skeleton';
import { cn } from '../../lib/cn';
import { useLogout, useMeData } from '../../lib/queries/me';
import { useCompose } from '../compose/ComposeProvider';
import { CustomFolders } from './CustomFolders';
import { SYSTEM_ORDER, VIEW_META } from './folderMeta';
import { OPEN_SHORTCUTS_EVENT } from './ShortcutsOverlay';
import { Badge, railLinkClass } from './railStyles';

interface Props {
  mailbox: MailboxSummary;
  folders: Folder[] | undefined;
  onNavigate?: () => void;
}

export function Rail({ mailbox, folders, onNavigate }: Props) {
  const compose = useCompose();
  return (
    <nav aria-label="Mailbox" className="flex h-full w-full flex-col bg-surface md:w-60 md:shrink-0 md:border-r md:border-border">
      <div className="px-3 pt-3.5 pb-2">
        <Logo className="px-1.5" />
        <MailboxSwitcher current={mailbox} onNavigate={onNavigate} />
      </div>
      <div className="px-3 pb-3">
        <Button
          variant="primary"
          className="w-full justify-between"
          onClick={() => {
            compose.open({ mailboxId: mailbox.id, mode: 'new' });
            onNavigate?.();
          }}
        >
          <span className="flex items-center gap-2"><PenLine size={15} /> Compose</span>
          <span className="rounded bg-white/20 px-1.5 font-mono text-[11px]">c</span>
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <ul className="space-y-0.5">
          {folders
            ? SYSTEM_ORDER.map((role) => {
                const f = role === 'starred' ? null : folders.find((x) => x.role === role);
                if (role !== 'starred' && !f) return null;
                const meta = VIEW_META[role];
                const count = !f ? 0 : role === 'drafts' || role === 'scheduled' ? f.total : role === 'sent' || role === 'trash' || role === 'archive' ? 0 : f.unread;
                return (
                  <li key={role}>
                    <NavLink to={`/mail/${mailbox.id}/${role}`} onClick={onNavigate} className={({ isActive }) => railLinkClass(isActive)}>
                      {meta.icon(16)}
                      <span className="truncate">{meta.label}</span>
                      <Badge n={count} strong={role === 'inbox'} />
                    </NavLink>
                  </li>
                );
              })
            : Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="my-1.5 h-5" />)}
        </ul>
        {folders && <CustomFolders mailboxId={mailbox.id} folders={folders.filter((f) => !f.role)} onNavigate={onNavigate} />}
      </div>
      <RailFooter onNavigate={onNavigate} />
    </nav>
  );
}

function MailboxSwitcher({ current, onNavigate }: { current: MailboxSummary; onNavigate?: () => void }) {
  const { mailboxes } = useMeData();
  const navigate = useNavigate();
  const label = (
    <span className="min-w-0 text-left">
      <span className="block truncate text-[13px] font-medium text-fg">{current.displayName || current.address}</span>
      <span className="block truncate text-xs text-faint">{current.address}</span>
    </span>
  );
  if (mailboxes.length < 2) return <div className="mt-3 rounded-lg px-2 py-1.5">{label}</div>;
  return (
    <Menu
      label="Switch mailbox"
      align="start"
      width={232}
      items={mailboxes.map((m) => ({
        label: m.address,
        hint: m.unread ? String(m.unread) : undefined,
        onSelect: () => {
          navigate(`/mail/${m.id}/inbox`);
          onNavigate?.();
        },
      }))}
      trigger={(p) => (
        <button {...p} type="button" className="mt-3 flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-hover">
          {label}
          <ChevronsUpDown size={14} className="shrink-0 text-faint" />
        </button>
      )}
    />
  );
}

function RailFooter({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useMeData();
  const logout = useLogout();
  const navigate = useNavigate();
  return (
    <div className="space-y-0.5 border-t border-border p-3">
      <NavLink to="/settings/profile" onClick={onNavigate} className={({ isActive }) => railLinkClass(isActive)}>
        <Settings size={16} /> Settings
      </NavLink>
      {user.role === 'admin' && (
        <NavLink to="/admin" onClick={onNavigate} className={({ isActive }) => railLinkClass(isActive)}>
          <ShieldCheck size={16} /> Admin
        </NavLink>
      )}
      <button type="button" onClick={() => window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT))} className={cn(railLinkClass(false), 'w-full max-md:hidden')}>
        <Keyboard size={16} /> Shortcuts <span className="ml-auto"><Kbd>?</Kbd></span>
      </button>
      <button
        type="button"
        onClick={() => logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) })}
        className={cn(railLinkClass(false), 'w-full')}
      >
        <LogOut size={16} />
        <span className="min-w-0 flex-1 truncate text-left">Sign out</span>
        <span className="max-w-24 truncate text-xs text-faint">{user.name}</span>
      </button>
    </div>
  );
}
