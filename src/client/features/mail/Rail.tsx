import { NavLink, useNavigate } from 'react-router';
import { ChevronsUpDown, Command, Keyboard, LogOut, MoreHorizontal, PenLine, Settings, ShieldCheck } from 'lucide-react';
import type { Folder, MailboxSummary } from '@shared/api';
import { IconButton, tipText } from '../../components/Button';
import { Kbd } from '../../components/Kbd';
import { LogoMark } from '../../components/Logo';
import { Menu } from '../../components/Menu';
import { Skeleton } from '../../components/Skeleton';
import { cn } from '../../lib/cn';
import { useLogout, useMeData } from '../../lib/queries/me';
import { useCompose } from '../compose/ComposeProvider';
import { MOD_KEY, OPEN_PALETTE_EVENT } from '../palette/events';
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
    <nav aria-label="Mailbox" className="flex h-full w-full flex-col bg-sidebar md:w-60 md:shrink-0 md:border-r md:border-border">
      <div className="flex h-12 shrink-0 items-center gap-1 px-2">
        <MailboxSwitcher current={mailbox} onNavigate={onNavigate} />
      </div>
      <div className="flex gap-1.5 px-2 pb-3">
        <button
          type="button"
          aria-keyshortcuts="C"
          onClick={() => {
            compose.open({ mailboxId: mailbox.id, mode: 'new' });
            onNavigate?.();
          }}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-bg px-2.5 text-[13px] font-medium text-fg shadow-[0_1px_1px_rgb(0_0_0/0.04)] hover:bg-hover dark:bg-surface-2 dark:hover:bg-hover"
        >
          <PenLine size={15} strokeWidth={1.75} className="text-primary" />
          <span className="flex-1 text-left">Compose</span>
          <Kbd className="max-md:hidden">C</Kbd>
        </button>
        <button
          type="button"
          aria-label="Command menu"
          data-tip={tipText('Command menu', `${MOD_KEY}K`)}
          data-tip-align="end"
          onClick={() => {
            onNavigate?.();
            window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));
          }}
          className="cm-tip inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-bg text-muted shadow-[0_1px_1px_rgb(0_0_0/0.04)] hover:bg-hover hover:text-fg dark:bg-surface-2 dark:hover:bg-hover"
        >
          <Command size={15} strokeWidth={1.75} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <ul className="space-y-px">
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
            : Array.from({ length: 8 }, (_, i) => (
                <li key={i} className="flex h-7 items-center gap-2 px-2"><Skeleton className="size-4" /><Skeleton className="h-3 w-20" /></li>
              ))}
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
    <>
      <LogoMark size={18} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold text-fg">{current.displayName || current.address}</span>
    </>
  );
  if (mailboxes.length < 2) {
    return <div className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2" title={current.address}>{label}</div>;
  }
  return (
    <Menu
      label="Switch mailbox"
      align="start"
      width={248}
      items={[
        { kind: 'heading', label: 'Switch mailbox' },
        ...mailboxes.map((m) => ({
          label: m.address,
          hint: m.unread ? String(m.unread) : undefined,
          onSelect: () => {
            navigate(`/mail/${m.id}/inbox`);
            onNavigate?.();
          },
        })),
      ]}
      trigger={(p) => (
        <button {...p} type="button" title={current.address} className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 hover:bg-black/[0.035] dark:hover:bg-white/[0.04]">
          {label}
          <ChevronsUpDown size={14} strokeWidth={1.75} className="shrink-0 text-faint" />
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
    <div className="space-y-px border-t border-border p-2">
      <NavLink to="/settings/profile" onClick={onNavigate} className={({ isActive }) => railLinkClass(isActive)}>
        <Settings /> Settings
      </NavLink>
      {user.role === 'admin' && (
        <NavLink to="/admin" onClick={onNavigate} className={({ isActive }) => railLinkClass(isActive)}>
          <ShieldCheck /> Admin
        </NavLink>
      )}
      <div className="flex items-center gap-1">
        <span className={cn(railLinkClass(false), 'min-w-0 flex-1 hover:bg-transparent dark:hover:bg-transparent')}>
          <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-black/[0.08] text-[9px] font-semibold text-muted dark:bg-white/10">
            {(user.name || user.email).slice(0, 1).toUpperCase()}
          </span>
          <span className="truncate text-fg">{user.name || user.email}</span>
        </span>
        <Menu
          label="Account"
          width={220}
          items={[
            { label: 'Keyboard shortcuts', icon: <Keyboard />, hint: '?', onSelect: () => window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT)) },
            { label: 'Command menu', icon: <Command />, hint: `${MOD_KEY}K`, onSelect: () => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT)) },
            { kind: 'separator' },
            { label: 'Sign out', icon: <LogOut />, onSelect: () => logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) }) },
          ]}
          trigger={(p) => (
            <IconButton {...p} label="Account" tipSide="top">
              <MoreHorizontal size={16} />
            </IconButton>
          )}
        />
      </div>
    </div>
  );
}
