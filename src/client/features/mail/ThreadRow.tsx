import { memo } from 'react';
import { Archive, Clock, Mail, MailOpen, Paperclip, Star, Trash2 } from 'lucide-react';
import type { ThreadAction, ThreadSummary } from '@shared/api';
import { Avatar } from '../../components/Avatar';
import { cn } from '../../lib/cn';
import { displayName, longDate, smartTime } from '../../lib/format';

/** ThreadSummary may carry `sendAt` for Scheduled items (not in the v0.1 contract yet). */
type Row = ThreadSummary & { sendAt?: number | null };

interface Props {
  thread: Row;
  index: number;
  active: boolean;
  focused: boolean;
  selected: boolean;
  selecting: boolean;
  myEmails: Set<string>;
  scheduled: boolean;
  onOpen: (t: ThreadSummary, index: number) => void;
  onToggle: (id: string, index: number, range: boolean) => void;
  onAction: (action: ThreadAction, ids: string[]) => void;
}

function senders(t: ThreadSummary, mine: Set<string>): string {
  const names = t.participants.map((p) => (mine.has(p.email.toLowerCase()) ? 'me' : displayName(p).split(' ')[0]));
  const unique = [...new Set(names)];
  if (!unique.length) return '(no sender)';
  if (unique.length === 1) return t.participants.length === 1 ? displayName(t.participants[0]) : unique[0];
  return unique.length > 3 ? `${unique.slice(0, 2).join(', ')} … ${unique[unique.length - 1]}` : unique.join(', ');
}

export const ThreadRow = memo(function ThreadRow({
  thread: t, index, active, focused, selected, selecting, myEmails, scheduled, onOpen, onToggle, onAction,
}: Props) {
  const unread = t.unreadCount > 0;
  const first = t.participants.find((p) => !myEmails.has(p.email.toLowerCase())) ?? t.participants[0] ?? { email: '?' };

  return (
    <div
      role="listitem"
      aria-current={active ? 'true' : undefined}
      aria-label={`${unread ? 'Unread, ' : ''}${senders(t, myEmails)}: ${t.subject || '(no subject)'}`}
      tabIndex={focused ? 0 : -1}
      data-index={index}
      id={`thread-${t.id}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) {
          e.preventDefault();
          onOpen(t, index);
        }
      }}
      onClick={(e) => {
        if (e.shiftKey || e.metaKey || e.ctrlKey) onToggle(t.id, index, e.shiftKey);
        else onOpen(t, index);
      }}
      className={cn(
        'group relative flex cursor-pointer gap-3 border-b border-border/70 px-3 py-2.5 transition-colors duration-100 select-none compact:py-1.5',
        active ? 'bg-selected' : selected ? 'bg-primary-soft' : 'hover:bg-hover',
        focused && !active && 'shadow-[inset_2px_0_0_var(--c-primary)]',
      )}
    >
      <div className="relative mt-0.5 size-8 shrink-0 compact:size-6">
        <span className={cn('absolute inset-0 transition-opacity duration-100', (selecting || selected) ? 'opacity-0' : 'group-hover:opacity-0')}>
          <Avatar address={first} size={32} className="compact:hidden" />
          <Avatar address={first} size={24} className="hidden compact:inline-flex" />
        </span>
        <label
          className={cn(
            'absolute inset-0 flex items-center justify-center rounded-full transition-opacity duration-100',
            selecting || selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onToggle(t.id, index, (e.nativeEvent as MouseEvent).shiftKey === true)}
            aria-label={`Select conversation: ${t.subject || '(no subject)'}`}
            className="size-4 cursor-pointer accent-[var(--c-primary)]"
          />
        </label>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {unread && <span className="size-1.5 shrink-0 translate-y-[-2px] rounded-full bg-primary" aria-hidden="true" />}
          <span className={cn('min-w-0 flex-1 truncate text-[13.5px]', unread ? 'font-semibold text-fg' : 'text-fg/85')}>
            {senders(t, myEmails)}
            {t.messageCount > 1 && <span className="ml-1.5 text-xs font-normal text-faint">{t.messageCount}</span>}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-faint group-hover:invisible group-focus-within:invisible">
            {t.hasAttachments && <Paperclip size={13} aria-label="Has attachments" />}
            {t.isStarred && <Star size={13} className="fill-amber-400 text-amber-400" aria-label="Starred" />}
            <time dateTime={new Date(t.lastMessageAt).toISOString()} title={longDate(t.lastMessageAt)} className={cn('text-xs tabular-nums', unread && 'font-semibold text-fg')}>
              {smartTime(t.lastMessageAt)}
            </time>
          </span>
        </div>
        <div className="mt-0.5 flex items-baseline gap-1.5 compact:mt-0">
          <span className={cn('truncate text-[13px] compact:shrink-0 compact:max-w-[60%]', unread ? 'font-medium text-fg' : 'text-fg/80')}>
            {t.subject || '(no subject)'}
          </span>
          <span className="hidden min-w-0 truncate text-[13px] text-faint compact:inline">— {t.snippet}</span>
        </div>
        {scheduled ? (
          <p className="mt-0.5 flex items-center gap-1 text-[12.5px] text-primary">
            <Clock size={12} /> {t.sendAt ? `Scheduled for ${longDate(t.sendAt)}` : 'Scheduled'}
          </p>
        ) : (
          <p className="mt-0.5 line-clamp-1 text-[12.5px] text-muted compact:hidden">{t.snippet}</p>
        )}
      </div>

      <div
        className="absolute top-1/2 right-2 hidden -translate-y-1/2 items-center gap-0.5 rounded-lg border border-border bg-elevated p-0.5 shadow-sm group-hover:flex group-focus-within:flex"
        onClick={(e) => e.stopPropagation()}
      >
        <RowAction label="Archive" onClick={() => onAction('archive', [t.id])}><Archive size={15} /></RowAction>
        <RowAction label="Move to Trash" onClick={() => onAction('trash', [t.id])}><Trash2 size={15} /></RowAction>
        <RowAction label={unread ? 'Mark as read' : 'Mark as unread'} onClick={() => onAction(unread ? 'read' : 'unread', [t.id])}>
          {unread ? <MailOpen size={15} /> : <Mail size={15} />}
        </RowAction>
        <RowAction label={t.isStarred ? 'Unstar' : 'Star'} onClick={() => onAction(t.isStarred ? 'unstar' : 'star', [t.id])}>
          <Star size={15} className={t.isStarred ? 'fill-amber-400 text-amber-400' : undefined} />
        </RowAction>
      </div>
    </div>
  );
});

function RowAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
    >
      {children}
    </button>
  );
}
