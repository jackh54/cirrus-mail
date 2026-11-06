import { lazy, Suspense } from 'react';
import { AlertTriangle, Clock, FileText } from 'lucide-react';
import type { MessageFull } from '@shared/api';
import { Button } from '../../components/Button';
import { cn } from '../../lib/cn';
import { displayName, longDate, smartTime } from '../../lib/format';
import { Attachments } from './Attachments';
import { InviteCard } from './InviteCard';
import { MessageHeader } from './MessageHeader';
import { TextBody } from './TextBody';

// DOMPurify and the sandboxed iframe renderer load on demand (and are warmed at idle by MailPage).
const HtmlBody = lazy(() => import('./HtmlBody').then((m) => ({ default: m.HtmlBody })));

type HeaderProps = Omit<React.ComponentProps<typeof MessageHeader>, 'message' | 'onCollapse'>;

interface Props extends HeaderProps {
  message: MessageFull;
  expanded: boolean;
  onToggle: () => void;
  onEditDraft: () => void;
  onCancelSchedule: () => void;
}

/** One message in the conversation: a hairline-separated section, or a single 40px row when collapsed. */
export function MessageCard(props: Props) {
  const { message: m, expanded, onToggle, onEditDraft, onCancelSchedule, ...header } = props;

  if (m.status === 'draft') {
    return (
      <div className="flex h-10 items-center gap-3">
        <FileText size={15} strokeWidth={1.75} className="shrink-0 text-danger" />
        <span className="shrink-0 text-[13px] font-medium text-danger">Draft</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{m.snippet || '(empty)'}</span>
        <Button size="sm" variant="ghost" onClick={onEditDraft}>Continue editing</Button>
      </div>
    );
  }

  if (!expanded) {
    return (
      <div>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={false}
          className="-mx-3 flex h-10 w-[calc(100%+1.5rem)] items-center gap-3 rounded-md px-3 text-left hover:bg-hover"
        >
          <span className={cn('w-28 shrink-0 truncate text-[13px] text-fg sm:w-40', !m.isRead && 'font-semibold')}>{displayName(m.from)}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{m.snippet}</span>
          <time className="shrink-0 text-[12px] text-faint" title={longDate(m.date)}>{smartTime(m.date)}</time>
        </button>
      </div>
    );
  }

  return (
    <article className="py-4" aria-label={`Message from ${displayName(m.from)}`}>
      <MessageHeader message={m} onCollapse={onToggle} {...header} />

      {m.status === 'scheduled' && m.sendAt && (
        <Banner icon={<Clock size={15} strokeWidth={1.75} />} tone="primary" text={`Scheduled for ${longDate(m.sendAt)}`}>
          <Button size="sm" variant="ghost" onClick={onCancelSchedule}>Cancel send</Button>
        </Banner>
      )}
      {m.status === 'sending' && <Banner icon={<Clock size={15} strokeWidth={1.75} />} tone="primary" text="Sending…" />}
      {m.status === 'failed' && (
        <Banner icon={<AlertTriangle size={15} strokeWidth={1.75} />} tone="danger" text={`Not sent: ${m.errorMessage ?? m.errorCode ?? 'unknown error'}`}>
          <Button size="sm" variant="ghost" onClick={onEditDraft}>Edit and retry</Button>
        </Banner>
      )}
      {m.spamScore >= 5 && m.direction === 'in' && (
        <Banner icon={<AlertTriangle size={15} strokeWidth={1.75} />} tone="warning" text="This message looks like spam. Be careful with links and attachments." />
      )}

      <InviteCard message={m} mailboxId={header.mailboxId} myEmails={header.myEmails} />

      <div className="mt-4">
        {m.html ? (
          <Suspense fallback={<div className="h-40" aria-hidden="true" />}>
            <HtmlBody html={m.html} messageId={m.id} />
          </Suspense>
        ) : (
          <TextBody text={m.text ?? ''} />
        )}
        <Attachments items={m.attachments} />
      </div>
    </article>
  );
}

function Banner({ icon, text, tone, children }: { icon: React.ReactNode; text: string; tone: 'primary' | 'danger' | 'warning'; children?: React.ReactNode }) {
  const cls = { primary: 'bg-primary-soft text-selected-fg', danger: 'bg-danger-soft text-danger', warning: 'bg-warning-soft text-warning' }[tone];
  return (
    <div className={cn('mt-3 flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-1 text-[13px]', cls)}>
      {icon}
      <span className="min-w-0 flex-1">{text}</span>
      {children}
    </div>
  );
}
