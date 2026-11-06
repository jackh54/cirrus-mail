import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Forward, MailX, Reply, ReplyAll } from 'lucide-react';
import type { Folder, MailboxSummary, MessageFull, ThreadAction } from '@shared/api';
import { Button, tipText } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Skeleton } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { api, errorMessage } from '../../lib/api';
import { useHotkeys } from '../../lib/hotkeys';
import { qk } from '../../lib/queries/keys';
import { useThread } from '../../lib/queries/mail';
import { useCompose } from '../compose/ComposeProvider';
import { draftApi } from '../compose/draftApi';
import { identitiesOf } from '../compose/identities';
import type { ResolvedView } from './folderMeta';
import { MessageCard } from './MessageCard';
import { ReaderToolbar } from './ReaderToolbar';
import type { MailController } from './useMailController';
import { useMailRoute } from './useMailRoute';

interface Props {
  mailbox: MailboxSummary;
  threadId: string;
  view: ResolvedView | null;
  folders: Folder[];
  ctl: MailController;
  showBack: boolean;
}

export function ReaderPane({ mailbox, threadId, view, folders, ctl, showBack }: Props) {
  const mb = mailbox.id;
  const { data, isPending, isError, error } = useThread(mb, threadId);
  const route = useMailRoute();
  const navigate = useNavigate();
  const compose = useCompose();
  const qc = useQueryClient();
  const { toast } = useToast();
  const myEmails = useMemo(() => new Set(identitiesOf(mailbox).map((i) => i.email.toLowerCase())), [mailbox]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const markedRead = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);

  const messages = data?.messages ?? [];
  const sent = messages.filter((m) => m.status !== 'draft');
  const latest: MessageFull | undefined = sent[sent.length - 1];

  // Latest message and unread ones start expanded.
  useEffect(() => {
    if (!data) return;
    setExpanded((prev) => {
      if (prev.size) return prev;
      const s = new Set<string>();
      data.messages.forEach((m, i) => (i === data.messages.length - 1 || !m.isRead) && s.add(m.id));
      if (latest) s.add(latest.id);
      return s;
    });
    if (!markedRead.current && data.thread.unreadCount > 0) {
      markedRead.current = true;
      void ctl.act('read', [threadId]);
    }
  }, [data, latest, ctl, threadId]);

  useEffect(() => {
    scroller.current?.focus({ preventScroll: true });
  }, [threadId]);

  const reply = (mode: 'reply' | 'reply_all' | 'forward', m: MessageFull | undefined = latest) => {
    if (m) compose.open({ mailboxId: mb, mode, parent: m });
  };
  useHotkeys({ r: () => reply('reply'), a: () => reply('reply_all'), f: () => reply('forward') });

  const act = (a: ThreadAction, folderId?: string) => void ctl.act(a, [threadId], folderId);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.thread(mb, threadId) });
    void qc.invalidateQueries({ queryKey: qk.threadsAll(mb) });
    void qc.invalidateQueries({ queryKey: qk.folders(mb) });
  };
  const block = async (email: string) => {
    try {
      await api.post(`/api/mailboxes/${mb}/blocked`, { pattern: email });
      void qc.invalidateQueries({ queryKey: qk.blocked(mb) });
      toast({ tone: 'success', title: `Blocked ${email}`, description: 'Future messages from this sender go to Spam.', action: { label: 'Move this to Spam', onClick: () => act('spam') } });
    } catch (e) {
      toast({ tone: 'error', title: 'Could not block sender', description: errorMessage(e) });
    }
  };
  const cancelSchedule = async (m: MessageFull) => {
    try {
      await draftApi.cancelSchedule(mb, m.id);
      refresh();
      toast({ title: 'Send cancelled', description: 'The message is back in Drafts.', action: { label: 'Edit', onClick: () => compose.open({ mailboxId: mb, mode: 'draft', draft: { ...m, status: 'draft' } }) } });
    } catch (e) {
      toast({ tone: 'error', title: "Couldn't cancel", description: errorMessage(e) });
    }
  };
  const step = (delta: number) => {
    const i = ctl.threads.findIndex((t) => t.id === threadId);
    const n = ctl.threads[i + delta];
    if (n) navigate(route.threadUrl(n.id), { replace: true });
  };

  return (
    <section aria-label="Conversation" className="flex min-w-0 flex-1 flex-col bg-bg">
      <ReaderToolbar
        role={view?.role}
        starred={!!data?.thread.isStarred}
        folders={folders}
        showBack={showBack}
        onBack={() => navigate(route.listUrl)}
        onAction={act}
        onStep={ctl.threads.length > 1 ? step : undefined}
      />
      <div ref={scroller} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
        {isPending ? (
          <ReaderSkeleton />
        ) : isError ? (
          <EmptyState icon={<MailX size={24} />} title="Couldn't open this conversation" body={errorMessage(error)} />
        ) : (
          <div className="mx-auto max-w-[800px] px-4 pt-6 pb-16 sm:px-8">
            <h1 className="mb-4 text-[18px] leading-7 font-semibold tracking-[-0.01em] text-balance text-fg">{data.thread.subject || '(no subject)'}</h1>
            <div className="divide-y divide-border border-y border-border">
              {messages.map((m) => (
                <MessageCard
                  key={m.id}
                  message={m}
                  expanded={expanded.has(m.id)}
                  starred={data.thread.isStarred}
                  mailboxId={mb}
                  folders={folders}
                  myEmails={myEmails}
                  onToggle={() =>
                    setExpanded((s) => {
                      const n = new Set(s);
                      if (n.has(m.id)) n.delete(m.id);
                      else n.add(m.id);
                      return n;
                    })
                  }
                  onStar={() => act(data.thread.isStarred ? 'unstar' : 'star')}
                  onReply={(mode) => reply(mode, m)}
                  onMove={(folderId) => act('move', folderId)}
                  onBlock={(email) => void block(email)}
                  onMarkUnread={() => act('unread')}
                  onEditDraft={() => compose.open({ mailboxId: mb, mode: 'draft', draft: m })}
                  onCancelSchedule={() => void cancelSchedule(m)}
                />
              ))}
            </div>
            {latest && <ReplyBar onReply={(mode) => reply(mode)} />}
          </div>
        )}
      </div>
    </section>
  );
}

/** Quiet reply actions at the end of the conversation. */
function ReplyBar({ onReply }: { onReply: (mode: 'reply' | 'reply_all' | 'forward') => void }) {
  const items = [
    { mode: 'reply', label: 'Reply', key: 'R', icon: <Reply size={15} strokeWidth={1.75} /> },
    { mode: 'reply_all', label: 'Reply all', key: 'A', icon: <ReplyAll size={15} strokeWidth={1.75} /> },
    { mode: 'forward', label: 'Forward', key: 'F', icon: <Forward size={15} strokeWidth={1.75} /> },
  ] as const;
  return (
    <div className="mt-5 flex flex-wrap gap-2">
      {items.map((it) => (
        <Button
          key={it.mode}
          variant="ghost"
          icon={it.icon}
          onClick={() => onReply(it.mode)}
          aria-keyshortcuts={it.key}
          data-tip={tipText(it.label, it.key)}
          data-tip-side="top"
          className="cm-tip border border-border"
        >
          {it.label}
        </Button>
      ))}
    </div>
  );
}

function ReaderSkeleton() {
  return (
    <div className="mx-auto max-w-[800px] px-4 pt-6 sm:px-8" aria-hidden="true">
      <Skeleton className="mb-6 h-5 w-2/3" />
      <div className="flex items-center gap-3 border-t border-border pt-4">
        <Skeleton className="size-8 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-3 w-1/4" />
        </div>
      </div>
      <div className="mt-5 space-y-2.5">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-4/5" />
      </div>
    </div>
  );
}
