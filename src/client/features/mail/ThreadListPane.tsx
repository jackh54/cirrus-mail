import { useCallback, useMemo, useRef, useState } from 'react';
import { useLatest } from '../../lib/useLatest';
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
import { identitiesOf } from '../compose/identities';
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
  const { query, threads, focusIndex, cursorVisible, selected, toggle, selectAll, openThread, act, prefetch, hideCursor } = ctl;
  const meta = VIEW_META[view.role];
  const selecting = selected.size > 0;

  // Stable callbacks (read the latest closures through a ref) so memoised rows never re-render on hover or open.
  const latest = useLatest({ act, openThread, toggle, prefetch, hideCursor });
  const onAction = useCallback((a: ThreadAction, ids: string[]) => void latest.current.act(a, ids), [latest]);
  const onOpen = useCallback(
    (t: ThreadSummary, i: number, viaPointer: boolean) => {
      if (viaPointer) latest.current.hideCursor();
      void latest.current.openThread(t, i);
    },
    [latest],
  );
  const onToggle = useCallback((id: string, i: number, range: boolean) => latest.current.toggle(id, i, range), [latest]);
  const onPrefetch = useCallback((id: string) => latest.current.prefetch(id), [latest]);
  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query]);

  const renderRow = (t: ThreadSummary, i: number) => (
    <ThreadRow
      thread={t}
      index={i}
      active={t.id === threadId}
      focused={cursorVisible && i === focusIndex}
      selected={selected.has(t.id)}
      selecting={selecting}
      myEmails={myEmails}
      scheduled={view.role === 'scheduled'}
      onOpen={onOpen}
      onToggle={onToggle}
      onAction={onAction}
      onPrefetch={onPrefetch}
    />
  );

  const allChecked = threads.length > 0 && selected.size === threads.length;

  return (
    <section aria-label={`${view.label} conversations`} className={cn('flex min-w-0 flex-col bg-bg', className)}>
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
        <header className="relative flex h-12 shrink-0 items-center gap-2 border-b border-border pr-3 pl-7">
          {onOpenMenu ? (
            <IconButton label="Open folders" size="md" noTip onClick={onOpenMenu} className="absolute left-1">
              <MenuIcon size={18} />
            </IconButton>
          ) : (
            <span className="absolute inset-y-0 left-0 flex w-7 items-center justify-center">
              <input
                type="checkbox"
                aria-label="Select all"
                checked={allChecked}
                disabled={!threads.length}
                onChange={(e) => selectAll(e.target.checked)}
                className="size-3.5 cursor-pointer disabled:opacity-40"
              />
            </span>
          )}
          <h1 className={cn('min-w-0 shrink truncate text-[14px] font-semibold tracking-[-0.01em]', onOpenMenu && 'pl-4')}>
            {view.role === 'search' ? <>Results for “{q}”</> : view.label}
          </h1>
          {view.folder && view.folder.unread > 0 && <span className="tnum shrink-0 text-[12px] text-faint">{view.folder.unread}</span>}
          <span className="flex-1" />
          {(view.role === 'trash' || view.role === 'spam') && view.folder && threads.length > 0 && (
            <EmptyFolderButton mailboxId={mailbox.id} folder={view.folder} />
          )}
          <SearchBox mailboxId={mailbox.id} q={q} />
          <IconButton label="Refresh" tipAlign="end" onClick={() => void query.refetch()} disabled={query.isFetching}>
            <RefreshCw size={15} className={query.isFetching && !query.isFetchingNextPage ? 'animate-spin' : undefined} />
          </IconButton>
        </header>
      )}

      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
        {query.isPending ? (
          Array.from({ length: 12 }, (_, i) => <ThreadRowSkeleton key={i} />)
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
              <div className="flex h-12 items-center justify-center text-faint"><Spinner size={14} /></div>
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
    <Button size="sm" variant="ghost" icon={<Trash size={14} strokeWidth={1.75} />} loading={busy} onClick={() => void run()} className="text-danger hover:text-danger">
      Empty
    </Button>
  );
}
