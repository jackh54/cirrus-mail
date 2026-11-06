import { memo, useRef, type ReactNode } from 'react';
import { AlarmClock, Archive, BellOff, Clock, Mail, MailOpen, Paperclip, Star, Trash2 } from 'lucide-react';
import type { ThreadAction, ThreadSummary } from '@shared/api';
import { IconButton } from '../../components/Button';
import { cn } from '../../lib/cn';
import { displayName, longDate, smartTime } from '../../lib/format';
import { snoozeLabel } from '../../lib/snooze';
import { RowLabels } from './labelMeta';

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
  /** Phone layout: three lines (sender, subject, snippet) in larger type; two lines when compact. */
  mobile?: boolean;
  /** Coarse pointer: no hover affordances; while selecting, a tap toggles the row. */
  touch?: boolean;
  onOpen: (t: ThreadSummary, index: number, viaPointer: boolean) => void;
  onToggle: (id: string, index: number, range: boolean) => void;
  onAction: (action: ThreadAction, ids: string[]) => void;
  onPrefetch: (id: string) => void;
}

/** Hover intent before warming the thread detail, so sweeping the pointer across the list stays cheap. */
const PREFETCH_DELAY_MS = 80;

function senders(t: ThreadSummary, mine: Set<string>): string {
  const names = t.participants.map((p) => (mine.has(p.email.toLowerCase()) ? 'me' : displayName(p).split(' ')[0]));
  const unique = [...new Set(names)];
  if (!unique.length) return '(no sender)';
  if (unique.length === 1) return t.participants.length === 1 ? displayName(t.participants[0]) : unique[0];
  return unique.length > 3 ? `${unique.slice(0, 2).join(', ')} … ${unique[unique.length - 1]}` : unique.join(', ');
}

/** Fixed row heights (px), shared with the virtualizer. */
export function rowHeight(compact: boolean, mobile: boolean): number {
  if (mobile) return compact ? 60 : 80;
  return compact ? 40 : 58;
}

/**
 * Two-line row at a fixed height (58px, 40px compact): sender and time, then subject and snippet.
 * Unread is a 6px cobalt dot in the left gutter; the gutter swaps to a checkbox on hover or while selecting.
 * On phones it is three lines (80px; 60px compact) in larger type.
 */
export const ThreadRow = memo(function ThreadRow({
  thread: t, index, active, focused, selected, selecting, myEmails, scheduled, mobile, touch, onOpen, onToggle, onAction, onPrefetch,
}: Props) {
  const unread = t.unreadCount > 0;
  const who = senders(t, myEmails);
  const subject = t.subject || '(no subject)';
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPrefetch = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const time = (
    <time dateTime={new Date(t.lastMessageAt).toISOString()} title={longDate(t.lastMessageAt)} className={cn('text-[12px]', unread ? 'font-medium text-fg' : 'text-muted')}>
      {smartTime(t.lastMessageAt)}
    </time>
  );
  const marks = (
    <>
      {t.muted && <BellOff size={13} strokeWidth={1.75} className="text-faint" aria-label="Muted" />}
      {t.hasAttachments && <Paperclip size={13} strokeWidth={1.75} className="text-faint" aria-label="Has attachments" />}
      {t.isStarred && <Star size={13} strokeWidth={1.75} className="fill-amber-400 text-amber-400" aria-label="Starred" />}
    </>
  );
  const line2 = scheduled ? (
    <span className="flex min-w-0 items-center gap-1 truncate text-selected-fg">
      <Clock size={12} strokeWidth={1.75} className="shrink-0" /> {t.sendAt ? `Scheduled for ${longDate(t.sendAt)}` : 'Scheduled'}
    </span>
  ) : (
    <>
      {t.labels.length > 0 && <RowLabels ids={t.labels} className="mr-1.5 self-center" />}
      <span className="min-w-0 truncate">
        {t.snoozedUntil && (
          <span className="mr-1.5 inline-flex items-center gap-1 text-selected-fg" title={longDate(t.snoozedUntil)}>
            <AlarmClock size={12} strokeWidth={1.75} className="shrink-0" /> until {snoozeLabel(t.snoozedUntil)}
          </span>
        )}
        <span className={cn('text-fg', unread && 'font-medium')}>{subject}</span>
        {t.snippet && <span className="text-muted"> — {t.snippet}</span>}
      </span>
    </>
  );

  return (
    <div
      role="listitem"
      aria-current={active ? 'true' : undefined}
      aria-label={`${unread ? 'Unread, ' : ''}${who}: ${subject}`}
      tabIndex={focused || (active && !selecting) ? 0 : -1}
      data-index={index}
      id={`thread-${t.id}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) {
          e.preventDefault();
          onOpen(t, index, false);
        }
      }}
      onClick={(e) => {
        if (e.shiftKey || e.metaKey || e.ctrlKey || (touch && selecting)) onToggle(t.id, index, e.shiftKey);
        else onOpen(t, index, true);
      }}
      onMouseEnter={() => {
        cancelPrefetch();
        timer.current = setTimeout(() => onPrefetch(t.id), PREFETCH_DELAY_MS);
      }}
      onMouseLeave={cancelPrefetch}
      className={cn(
        'group relative flex cursor-default flex-col justify-center border-b border-border pr-4 pl-7 select-none',
        mobile ? 'h-20 compact:h-[60px] [-webkit-touch-callout:none]' : 'h-[58px] compact:h-10',
        '[--row-bg:var(--c-bg)] hover:[--row-bg:var(--c-hover)] bg-(--row-bg)',
        touch && 'active:[--row-bg:var(--c-hover)]',
        (active || selected) && '[--row-bg:var(--c-primary-soft)] hover:[--row-bg:var(--c-primary-soft)]',
        active && 'shadow-[inset_2px_0_0_var(--c-primary)]',
        focused && !active && 'outline-1 -outline-offset-1 outline-primary/60',
      )}
    >
      <div className="absolute inset-y-0 left-0 flex w-7 items-center justify-center">
        {unread && (
          <span
            aria-hidden="true"
            className={cn(
              'absolute left-[11px] size-1.5 rounded-full bg-primary',
              mobile ? 'top-4' : 'top-[17px] compact:top-[17px]',
              (selecting || selected) ? 'hidden' : !touch && 'group-hover:hidden group-focus-within:hidden',
            )}
          />
        )}
        <label
          className={cn(
            'absolute inset-0 flex items-center justify-center',
            selecting || selected ? 'flex' : touch ? 'hidden' : 'hidden group-hover:flex group-focus-within:flex',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onToggle(t.id, index, (e.nativeEvent as MouseEvent).shiftKey === true)}
            aria-label={`Select conversation: ${subject}`}
            className="size-3.5 cursor-pointer"
          />
        </label>
      </div>

      {mobile ? (
        <>
          <div className="flex items-center gap-2">
            <span className={cn('min-w-0 flex-1 truncate text-[15px] leading-5', unread ? 'font-semibold text-fg' : 'text-fg')}>
              {who}
              {t.messageCount > 1 && <span className="tnum ml-1.5 text-[13px] font-normal text-faint">{t.messageCount}</span>}
            </span>
            <span className="flex shrink-0 items-center gap-1.5 [&_time]:text-[13px]">{marks}{time}</span>
          </div>
          {scheduled ? (
            <div className="mt-0.5 flex text-[14px] leading-5">{line2}</div>
          ) : (
            <>
              <div className={cn('mt-0.5 flex items-center gap-1.5 text-[14px] leading-5 text-fg', unread && 'font-medium')}>
                {t.labels.length > 0 && <RowLabels ids={t.labels} />}
                {t.snoozedUntil && (
                  <span className="inline-flex shrink-0 items-center gap-1 font-normal text-selected-fg">
                    <AlarmClock size={13} strokeWidth={1.75} className="shrink-0" /> until {snoozeLabel(t.snoozedUntil)}
                  </span>
                )}
                <span className="min-w-0 truncate">{subject}</span>
              </div>
              {t.snippet && <div className="truncate text-[14px] leading-5 text-muted compact:hidden">{t.snippet}</div>}
            </>
          )}
        </>
      ) : (
        <>
          {/* Comfortable: two lines. Compact: one line with a fixed sender column. */}
          <div className="flex items-center gap-2 compact:hidden">
            <span className={cn('min-w-0 flex-1 truncate text-[13px]', unread ? 'font-semibold text-fg' : 'text-fg')}>
              {who}
              {t.messageCount > 1 && <span className="tnum ml-1.5 text-[12px] font-normal text-faint">{t.messageCount}</span>}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">{marks}{time}</span>
          </div>
          <div className="mt-0.5 flex text-[13px] leading-5 compact:hidden">{line2}</div>

          <div className="hidden items-center gap-3 text-[13px] compact:flex">
            <span className={cn('w-36 shrink-0 truncate', unread ? 'font-semibold text-fg' : 'text-fg')}>
              {who}
              {t.messageCount > 1 && <span className="tnum ml-1 text-[12px] font-normal text-faint">{t.messageCount}</span>}
            </span>
            <span className="flex min-w-0 flex-1">{line2}</span>
            <span className="flex shrink-0 items-center gap-1.5">{marks}{time}</span>
          </div>
        </>
      )}

      {!touch && (
        <div
          className={cn(
            'invisible absolute inset-y-0 right-0 flex items-center gap-0.5 pr-3 pl-10 opacity-0 transition-opacity duration-100',
            'bg-[linear-gradient(to_right,transparent,var(--row-bg)_32px)]',
            'group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <RowAction label="Archive" shortcut="E" onClick={() => onAction('archive', [t.id])}><Archive size={16} /></RowAction>
          <RowAction label="Move to Trash" shortcut="#" onClick={() => onAction('trash', [t.id])}><Trash2 size={16} /></RowAction>
          <RowAction label={unread ? 'Mark as read' : 'Mark as unread'} shortcut={unread ? '⇧I' : '⇧U'} onClick={() => onAction(unread ? 'read' : 'unread', [t.id])}>
            {unread ? <MailOpen size={16} /> : <Mail size={16} />}
          </RowAction>
          <RowAction label={t.isStarred ? 'Unstar' : 'Star'} shortcut="S" align="end" onClick={() => onAction(t.isStarred ? 'unstar' : 'star', [t.id])}>
            <Star size={16} className={t.isStarred ? 'fill-amber-400 text-amber-400' : undefined} />
          </RowAction>
        </div>
      )}
    </div>
  );
});

function RowAction({ label, shortcut, align, onClick, children }: { label: string; shortcut: string; align?: 'end'; onClick: () => void; children: ReactNode }) {
  return (
    <IconButton label={label} shortcut={shortcut} tipAlign={align} tabIndex={-1} onClick={onClick} className="hover:bg-black/5 dark:hover:bg-white/8">
      {children}
    </IconButton>
  );
}
