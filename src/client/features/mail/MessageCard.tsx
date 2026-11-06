import { AlertTriangle, Clock, FileText, Forward, Reply, ReplyAll } from 'lucide-react';
import type { MessageFull } from '@shared/api';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { cn } from '../../lib/cn';
import { displayName, longDate, smartTime } from '../../lib/format';
import { Attachments } from './Attachments';
import { HtmlBody } from './HtmlBody';
import { MessageHeader } from './MessageHeader';
import { TextBody } from './TextBody';

type HeaderProps = Omit<React.ComponentProps<typeof MessageHeader>, 'message' | 'onCollapse'>;

interface Props extends HeaderProps {
  message: MessageFull;
  expanded: boolean;
  isLast: boolean;
  onToggle: () => void;
  onEditDraft: () => void;
  onCancelSchedule: () => void;
}

export function MessageCard(props: Props) {
  const { message: m, expanded, isLast, onToggle, onEditDraft, onCancelSchedule, ...header } = props;

  if (m.status === 'draft') {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-dashed border-border-strong bg-surface px-4 py-3">
        <FileText size={16} className="text-danger" />
        <span className="text-[13px] font-medium text-danger">Draft</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{m.snippet || '(empty)'}</span>
        <Button size="sm" onClick={onEditDraft}>Continue editing</Button>
      </div>
    );
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={false}
        className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-4 py-2.5 text-left transition-colors hover:bg-hover"
      >
        <Avatar address={m.from} size={26} />
        <span className={cn('w-36 shrink-0 truncate text-[13.5px]', m.isRead ? 'text-fg' : 'font-semibold text-fg')}>{displayName(m.from)}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{m.snippet}</span>
        <time className="shrink-0 text-xs text-faint tabular-nums" title={longDate(m.date)}>{smartTime(m.date)}</time>
      </button>
    );
  }

  return (
    <article className="rounded-xl border border-border bg-surface px-4 py-4 sm:px-5 animate-fade-in" aria-label={`Message from ${displayName(m.from)}`}>
      <MessageHeader message={m} onCollapse={onToggle} {...header} />

      {m.status === 'scheduled' && m.sendAt && (
        <Banner icon={<Clock size={15} />} tone="primary" text={`Scheduled for ${longDate(m.sendAt)}`}>
          <Button size="sm" onClick={onCancelSchedule}>Cancel send</Button>
        </Banner>
      )}
      {m.status === 'sending' && <Banner icon={<Clock size={15} />} tone="primary" text="Sending…" />}
      {m.status === 'failed' && (
        <Banner icon={<AlertTriangle size={15} />} tone="danger" text={`Not sent: ${m.errorMessage ?? m.errorCode ?? 'unknown error'}`}>
          <Button size="sm" onClick={onEditDraft}>Edit and retry</Button>
        </Banner>
      )}
      {m.spamScore >= 5 && m.direction === 'in' && (
        <Banner icon={<AlertTriangle size={15} />} tone="warning" text="This message looks like spam. Be careful with links and attachments." />
      )}

      <div className="mt-4 sm:pl-12">
        {m.html ? <HtmlBody html={m.html} /> : <TextBody text={m.text ?? ''} />}
        <Attachments items={m.attachments} />
        {isLast && (
          <div className="mt-5 flex flex-wrap gap-2">
            <Button icon={<Reply size={15} />} onClick={() => header.onReply('reply')}>Reply</Button>
            <Button icon={<ReplyAll size={15} />} onClick={() => header.onReply('reply_all')}>Reply all</Button>
            <Button icon={<Forward size={15} />} onClick={() => header.onReply('forward')}>Forward</Button>
          </div>
        )}
      </div>
    </article>
  );
}

function Banner({ icon, text, tone, children }: { icon: React.ReactNode; text: string; tone: 'primary' | 'danger' | 'warning'; children?: React.ReactNode }) {
  const cls = { primary: 'bg-primary-soft text-primary', danger: 'bg-danger-soft text-danger', warning: 'bg-warning-soft text-warning' }[tone];
  return (
    <div className={cn('mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3 py-2 text-[13px] sm:ml-12', cls)}>
      {icon}
      <span className="min-w-0 flex-1 font-medium">{text}</span>
      {children}
    </div>
  );
}
