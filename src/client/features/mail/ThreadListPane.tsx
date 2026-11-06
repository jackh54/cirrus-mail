import { useCallback, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Menu as MenuIcon, RefreshCw, Trash } from 'lucide-react';
import type { Folder, MailboxSummary, ThreadAction, ThreadSummary } from '@shared/api';
import { Button, IconButton } from '../../components/Button';
import { useConfirm } from '../../components/Confirm';
import { EmptyState } from '../../components/EmptyState';
import { ThreadRowSkeleton } from '../../components/Skeleton';
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/api';
import { qk } from '../../lib/queries/keys';
import { emptyFolder } from '../../lib/queries/mail';
import { identitiesOf } from '../compose/prefill';
import { BulkBar } from './BulkBar';
import { VIEW_META, type ResolvedView } from './folderMeta';
import { SearchBox } from './SearchBox';
import { ThreadRow } from './ThreadRow';
import { ThreadRows } from './ThreadRows';
import type { MailController } from './useMailController';
import { useMailRoute } from './useMailRoute';

interface Props {
  mailbox: MailboxSummary;
  view: ResolvedView;
  folders: Folder[];
  ctl: MailController;
  onOpenMenu?: () => void;
  className?: string;
}

export function ThreadListPane({ mailbox, view, folders, ctl, onOpenMenu, className }: Props) {
  const { threadId, q } = useMailRoute();
  const scrollRef = useRef<HTMLDivElement>(null);
  const myEmails = useMemo(() => new Set(identitiesOf(mailbox).map((i) => i.email.toLowerCase())), [mailbox]);
  const { query, threads, focusIndex, selected, toggle, selectAll, openThread, act } = ctl;
  const meta = VIEW_META[view.role];
  const selecting = selected.size > 0;

  const onAction = useCallback((a: ThreadAction, ids: string[]) => void act(a, ids), [act]);
  const onOpen = useCallback((t: ThreadSummary, i: number) => void openThread(t, i), [openThread]);
  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query]);

  const renderRow = (t: ThreadSummary, i: number) => (
    <ThreadRow
      thread={t}
      index={i}
      active={t.id === threadId}
      focused={i === focusIndex}
      selected={selected.has(t.id)}
      selecting={selecting}
      myEmails={myEmails}
      scheduled={view.role === 'scheduled'}
      onOpen={onOpen}
      onToggle={toggle}
      onAction={onAction}
    />
  );

  const allChecked = threads.length > 0 && selected.size === threads.length;

  return (
    <section aria-label={`${view.label} conversations`} className={cn('flex min-w-0 flex-col bg-surface', className)}>
      <header className="flex h-13 shrink-0 items-center gap-2 border-b border-border px-3">
        {onOpenMenu && (
          <IconButton label="Open folders" onClick={onOpenMenu} className="-ml-1">
            <MenuIcon size={18} />
          </IconButton>
        )}
        <SearchBox mailboxId={mailbox.id} q={q} />
        <IconButton label="Refresh" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
          <RefreshCw size={14} className={query.isFetching && !query.isFetchingNextPage ? 'animate-spin' : undefined} />
        </IconButton>
      </header>

      {selecting ? (
        <BulkBar
          count={selected.size}
          total={threads.length}
          role={view.role}
          folders={folders}
          onSelectAll={selectAll}
          onAction={(a, folderId) => void act(a, [...selected], folderId)}
        />
      ) : (
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/70 px-3">
          <input
            type="checkbox"
            aria-label="Select all"
            checked={allChecked}
            disabled={!threads.length}
            onChange={(e) => selectAll(e.target.checked)}
            className="ml-2 size-4 cursor-pointer accent-[var(--c-primary)] disabled:opacity-40"
          />
          <h1 className="ml-2 min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight">
            {view.role === 'search' ? <>Results for <span className="text-primary">“{q}”</span></> : view.label}
          </h1>
          {view.folder && view.folder.unread > 0 && <span className="text-xs text-faint">{view.folder.unread} unread</span>}
          {(view.role === 'trash' || view.role === 'spam') && view.folder && threads.length > 0 && (
            <EmptyFolderButton mailboxId={mailbox.id} folder={view.folder} />
          )}
        </div>
      )}

      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {query.isPending ? (
          Array.from({ length: 9 }, (_, i) => <ThreadRowSkeleton key={i} />)
        ) : query.isError ? (
          <EmptyState
            icon={meta.icon(24)}
            title="Couldn't load conversations"
            body={errorMessage(query.error)}
            action={<Button onClick={() => void query.refetch()}>Try again</Button>}
          />
        ) : !threads.length ? (
          <EmptyState icon={meta.icon(24)} title={meta.emptyTitle} body={meta.emptyBody} />
        ) : (
          <>
            <ThreadRows
              threads={threads}
              scrollRef={scrollRef}
              focusIndex={focusIndex}
              renderRow={renderRow}
              hasMore={!!query.hasNextPage}
              loadMore={loadMore}
            />
            {query.isFetchingNextPage && (
              <div className="flex justify-center py-4 text-faint"><Spinner /></div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function EmptyFolderButton({ mailboxId, folder }: { mailboxId: string; folder: Folder }) {
  const confirm = useConfirm();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const name = folder.role === 'spam' ? 'Spam' : 'Trash';
  const run = async () => {
    const ok = await confirm({
      title: `Empty ${name}?`,
      body: `Every conversation in ${name} will be permanently deleted. This cannot be undone.`,
      confirmLabel: `Empty ${name}`,
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const n = await emptyFolder(mailboxId, folder.id);
      toast({ tone: 'success', title: `${name} emptied`, description: `${n} conversation${n === 1 ? '' : 's'} deleted.` });
    } catch (e) {
      toast({ tone: 'error', title: `Couldn't empty ${name}`, description: errorMessage(e) });
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: qk.threadsAll(mailboxId) });
      void qc.invalidateQueries({ queryKey: qk.folders(mailboxId) });
    }
  };
  return (
    <Button size="sm" variant="ghost" icon={<Trash size={13} />} loading={busy} onClick={() => void run()} className="text-danger">
      Empty {name.toLowerCase()}
    </Button>
  );
}
