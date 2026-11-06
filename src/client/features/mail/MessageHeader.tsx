import { useState } from 'react';
import { useNavigate } from 'react-router';
import { AlarmClock, Ban, Bell, BellOff, ChevronDown, Code2, FolderInput, Forward, Mail, Moon, MoreHorizontal, Reply, ReplyAll, Star, Sun, UserPlus, UserRoundPen } from 'lucide-react';
import type { Address, Folder, MessageFull } from '@shared/api';
import { Avatar } from '../../components/Avatar';
import { IconButton } from '../../components/Button';
import { Menu, type MenuItem } from '../../components/Menu';
import { displayName, longDate, smartTime } from '../../lib/format';
import { useContacts } from '../../lib/queries/dav';
import { useDarkTheme } from '../../lib/theme';
import { setOverride, useRenderPref, wantsDark } from './renderPrefs';
import { AuthBadge } from './AuthBadge';
import { UnsubscribeDialog } from './UnsubscribeDialog';

interface Props {
  message: MessageFull;
  starred: boolean;
  muted: boolean;
  /** This is the latest message with an unsubscribe option: show the link. */
  unsubscribable: boolean;
  mailboxId: string;
  folders: Folder[];
  myEmails: Set<string>;
  onStar: () => void;
  onReply: (mode: 'reply' | 'reply_all' | 'forward') => void;
  onMove: (folderId: string) => void;
  onBlock: (email: string) => void;
  onMarkUnread: () => void;
  onMute: () => void;
  onSnooze: () => void;
  onCollapse: () => void;
}

function list(xs: Address[], mine: Set<string>): string {
  return xs.map((a) => (mine.has(a.email.toLowerCase()) ? 'me' : displayName(a))).join(', ');
}

export function MessageHeader({ message: m, starred, muted, unsubscribable, mailboxId, folders, myEmails, onStar, onReply, onMove, onBlock, onMarkUnread, onMute, onSnooze, onCollapse }: Props) {
  const [details, setDetails] = useState(false);
  const [unsubscribing, setUnsubscribing] = useState(false);
  const recipients = list([...m.to, ...m.cc], myEmails);
  const navigate = useNavigate();
  // The address book is one cached query shared by every header in the thread.
  const contacts = useContacts();
  const known = m.direction === 'in' ? contacts.data?.find((c) => c.emails.some((e) => e.value.toLowerCase() === m.from.email.toLowerCase())) : undefined;
  const movable = folders.filter((f) => f.role === 'inbox' || f.role === 'archive' || !f.role);
  const items: MenuItem[] = [
    { label: 'Reply', icon: <Reply />, onSelect: () => onReply('reply'), hint: 'R' },
    { label: 'Reply all', icon: <ReplyAll />, onSelect: () => onReply('reply_all'), hint: 'A' },
    { label: 'Forward', icon: <Forward />, onSelect: () => onReply('forward'), hint: 'F' },
    { kind: 'separator' },
    { label: 'Mark as unread', icon: <Mail />, onSelect: onMarkUnread, hint: '⇧U' },
    { label: 'Snooze…', icon: <AlarmClock />, onSelect: onSnooze, hint: 'B' },
    { label: muted ? 'Unmute conversation' : 'Mute conversation', icon: muted ? <Bell /> : <BellOff />, onSelect: onMute, hint: 'M' },
    {
      label: 'Show original',
      icon: <Code2 />,
      onSelect: () => window.open(`/api/mailboxes/${mailboxId}/messages/${m.id}/raw`, '_blank', 'noopener,noreferrer'),
    },
    ...(m.direction === 'in' && contacts.data
      ? [known
          ? { label: 'Edit contact', icon: <UserRoundPen />, onSelect: () => navigate(`/contacts/${known.id}?edit=1`) }
          : { label: 'Add to contacts', icon: <UserPlus />, onSelect: () => navigate(`/contacts/new?${new URLSearchParams({ email: m.from.email, name: m.from.name ?? '' })}`) }]
      : []),
    ...(m.direction === 'in' ? [{ label: `Block ${m.from.email}`, icon: <Ban />, danger: true, onSelect: () => onBlock(m.from.email) }] : []),
    { kind: 'separator' },
    { kind: 'heading', label: 'Move to' },
    ...movable.map((f) => ({ label: f.name, icon: <FolderInput />, onSelect: () => onMove(f.id) })),
  ];

  return (
    <div className="flex items-start gap-3">
      <button type="button" onClick={onCollapse} aria-label="Collapse message" className="shrink-0 rounded-full">
        <Avatar address={m.from} size={32} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 leading-5">
          <span className="truncate text-[13px] font-semibold text-fg">{displayName(m.from)}</span>
          <span className="min-w-0 truncate text-[12px] text-muted max-sm:hidden">{m.from.email}</span>
          <AuthBadge auth={m.auth} />
          {unsubscribable && m.unsubscribe && (
            <button
              type="button"
              onClick={() => setUnsubscribing(true)}
              className="shrink-0 rounded px-1 text-[12px] text-selected-fg hover:underline pointer-coarse:min-h-11 pointer-coarse:px-2"
            >
              Unsubscribe
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setDetails((d) => !d)}
          aria-expanded={details}
          className="flex max-w-full items-center gap-0.5 rounded text-left text-[12px] leading-4 text-muted hover:text-fg"
        >
          <span className="truncate">to {recipients || '(undisclosed recipients)'}</span>
          <ChevronDown size={12} strokeWidth={1.75} className={details ? 'shrink-0 rotate-180' : 'shrink-0'} />
        </button>
        {details && (
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-surface-2 px-3 py-2.5 text-[12px]">
            <Detail label="From" value={`${m.from.name ? `${m.from.name} ` : ''}<${m.from.email}>`} />
            {m.replyTo && <Detail label="Reply-To" value={m.replyTo} />}
            <Detail label="To" value={m.to.map((a) => a.email).join(', ')} />
            {m.cc.length > 0 && <Detail label="Cc" value={m.cc.map((a) => a.email).join(', ')} />}
            {m.bcc.length > 0 && <Detail label="Bcc" value={m.bcc.map((a) => a.email).join(', ')} />}
            <Detail label="Date" value={longDate(m.date)} />
            {m.auth && <Detail label="Security" value={`SPF ${m.auth.spf ?? 'none'}, DKIM ${m.auth.dkim ?? 'none'}, DMARC ${m.auth.dmarc ?? 'none'}`} />}
            {m.listId && <Detail label="List" value={m.listId} />}
          </dl>
        )}
      </div>
      <div className="-mt-1 flex shrink-0 items-center gap-0.5">
        <time dateTime={new Date(m.date).toISOString()} title={longDate(m.date)} className="mr-1.5 text-[12px] text-faint">
          {smartTime(m.date)}
        </time>
        {m.html && <DarkToggle messageId={m.id} />}
        <IconButton label={starred ? 'Unstar' : 'Star'} shortcut="S" onClick={onStar} className="max-sm:hidden">
          <Star size={16} className={starred ? 'fill-amber-400 text-amber-400' : undefined} />
        </IconButton>
        <IconButton label="Reply" shortcut="R" onClick={() => onReply('reply')} className="max-sm:hidden">
          <Reply size={16} />
        </IconButton>
        <Menu
          label="Message actions"
          width={240}
          items={items}
          trigger={(p) => (
            <IconButton {...p} label="More actions" tipAlign="end">
              <MoreHorizontal size={16} />
            </IconButton>
          )}
        />
      </div>
      {unsubscribing && <UnsubscribeDialog mailboxId={mailboxId} message={m} onClose={() => setUnsubscribing(false)} />}
    </div>
  );
}

/** Dark theme only: switch this HTML message between dark rendering and the sender's original. */
function DarkToggle({ messageId }: { messageId: string }) {
  const dark = useDarkTheme();
  const pref = useRenderPref(messageId);
  if (!dark || pref.designed === undefined) return null;
  const showingDark = wantsDark(pref, pref.designed);
  return (
    <IconButton
      label={showingDark ? 'Show original' : 'Show in dark'}
      aria-pressed={showingDark}
      onClick={() => setOverride(messageId, showingDark ? 'original' : 'dark')}
    >
      {showingDark ? <Sun size={16} /> : <Moon size={16} />}
    </IconButton>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-faint">{label}</dt>
      <dd className="min-w-0 break-all text-fg">{value}</dd>
    </>
  );
}
