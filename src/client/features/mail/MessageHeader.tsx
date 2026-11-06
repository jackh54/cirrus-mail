import { useState } from 'react';
import { Ban, Code2, FolderInput, Forward, Mail, MoreHorizontal, Reply, ReplyAll, Star } from 'lucide-react';
import type { Address, Folder, MessageFull } from '@shared/api';
import { Avatar } from '../../components/Avatar';
import { IconButton } from '../../components/Button';
import { Menu, type MenuItem } from '../../components/Menu';
import { displayName, longDate, smartTime } from '../../lib/format';
import { AuthBadge } from './AuthBadge';

interface Props {
  message: MessageFull;
  starred: boolean;
  mailboxId: string;
  folders: Folder[];
  myEmails: Set<string>;
  onStar: () => void;
  onReply: (mode: 'reply' | 'reply_all' | 'forward') => void;
  onMove: (folderId: string) => void;
  onBlock: (email: string) => void;
  onMarkUnread: () => void;
  onCollapse: () => void;
}

function list(xs: Address[], mine: Set<string>): string {
  return xs.map((a) => (mine.has(a.email.toLowerCase()) ? 'me' : displayName(a))).join(', ');
}

export function MessageHeader({ message: m, starred, mailboxId, folders, myEmails, onStar, onReply, onMove, onBlock, onMarkUnread, onCollapse }: Props) {
  const [details, setDetails] = useState(false);
  const recipients = list([...m.to, ...m.cc], myEmails);
  const movable = folders.filter((f) => f.role === 'inbox' || f.role === 'archive' || !f.role);
  const items: MenuItem[] = [
    { label: 'Reply', icon: <Reply />, onSelect: () => onReply('reply'), hint: 'r' },
    { label: 'Reply all', icon: <ReplyAll />, onSelect: () => onReply('reply_all'), hint: 'a' },
    { label: 'Forward', icon: <Forward />, onSelect: () => onReply('forward'), hint: 'f' },
    { kind: 'separator' },
    { label: 'Mark as unread', icon: <Mail />, onSelect: onMarkUnread },
    {
      label: 'Show original',
      icon: <Code2 />,
      onSelect: () => window.open(`/api/mailboxes/${mailboxId}/messages/${m.id}/raw`, '_blank', 'noopener,noreferrer'),
    },
    ...(m.direction === 'in' ? [{ label: `Block ${m.from.email}`, icon: <Ban />, danger: true, onSelect: () => onBlock(m.from.email) }] : []),
    { kind: 'separator' },
    { kind: 'heading', label: 'Move to' },
    ...movable.map((f) => ({ label: f.name, icon: <FolderInput />, onSelect: () => onMove(f.id) })),
  ];

  return (
    <div className="flex items-start gap-3">
      <button type="button" onClick={onCollapse} aria-label="Collapse message" className="mt-0.5 shrink-0 rounded-full">
        <Avatar address={m.from} size={36} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5">
          <span className="truncate text-[14px] font-semibold text-fg">{displayName(m.from)}</span>
          <span className="truncate text-[13px] text-muted">&lt;{m.from.email}&gt;</span>
          <AuthBadge auth={m.auth} />
        </div>
        <button
          type="button"
          onClick={() => setDetails((d) => !d)}
          aria-expanded={details}
          className="mt-0.5 max-w-full truncate text-left text-[12.5px] text-muted hover:text-fg"
        >
          to {recipients || '(undisclosed recipients)'} ▾
        </button>
        {details && (
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-surface-2 p-3 text-[12.5px] animate-fade-in">
            <Detail label="From" value={`${m.from.name ? `${m.from.name} ` : ''}<${m.from.email}>`} />
            {m.replyTo && <Detail label="Reply-To" value={m.replyTo} />}
            <Detail label="To" value={m.to.map((a) => a.email).join(', ')} />
            {m.cc.length > 0 && <Detail label="Cc" value={m.cc.map((a) => a.email).join(', ')} />}
            {m.bcc.length > 0 && <Detail label="Bcc" value={m.bcc.map((a) => a.email).join(', ')} />}
            <Detail label="Date" value={longDate(m.date)} />
            {m.auth && <Detail label="Security" value={`SPF ${m.auth.spf ?? 'none'} · DKIM ${m.auth.dkim ?? 'none'} · DMARC ${m.auth.dmarc ?? 'none'}`} />}
            {m.listId && <Detail label="List" value={m.listId} />}
          </dl>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <time dateTime={new Date(m.date).toISOString()} title={longDate(m.date)} className="mr-1 text-xs text-faint tabular-nums max-sm:hidden">
          {smartTime(m.date)}
        </time>
        <IconButton label={starred ? 'Unstar' : 'Star'} size="sm" onClick={onStar}>
          <Star size={15} className={starred ? 'fill-amber-400 text-amber-400' : undefined} />
        </IconButton>
        <IconButton label="Reply" size="sm" onClick={() => onReply('reply')} className="max-sm:hidden">
          <Reply size={15} />
        </IconButton>
        <Menu
          label="Message actions"
          width={240}
          items={items}
          trigger={(p) => (
            <IconButton {...p} label="More actions" size="sm">
              <MoreHorizontal size={15} />
            </IconButton>
          )}
        />
      </div>
    </div>
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
