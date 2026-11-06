import { useEffect, useState } from 'react';
import { Navigate } from 'react-router';
import { PenLine } from 'lucide-react';
import { Drawer } from '../../components/Drawer';
import { FullScreenSpinner } from '../../components/Spinner';
import { useFolders } from '../../lib/queries/mail';
import { useMeData } from '../../lib/queries/me';
import { setLastMailbox } from '../../lib/storage';
import { useCompose } from '../compose/ComposeProvider';
import { resolveView } from './folderMeta';
import { Rail } from './Rail';
import { ReaderEmpty } from './ReaderEmpty';
import { ReaderPane } from './ReaderPane';
import { ThreadListPane } from './ThreadListPane';
import { useLayoutMode, useMailRoute } from './useMailRoute';
import { useMailController } from './useMailController';
import { usePolling } from './usePolling';

export function MailPage() {
  const { mailboxId, folder, threadId, q } = useMailRoute();
  const { mailboxes } = useMeData();
  const mailbox = mailboxes.find((m) => m.id === mailboxId);
  const folders = useFolders(mailbox?.id);
  const view = resolveView(folders.data, folder);
  const layout = useLayoutMode();
  const [drawer, setDrawer] = useState(false);
  const ctl = useMailController(view, folders.data);
  const compose = useCompose();

  usePolling(mailbox?.id ?? '');

  // Warm the reader's HTML renderer (DOMPurify) once idle, so the first open does not wait on a chunk.
  useEffect(() => {
    const warm = () => void import('./HtmlBody');
    const id = 'requestIdleCallback' in window ? requestIdleCallback(warm) : setTimeout(warm, 1500);
    return () => {
      if ('cancelIdleCallback' in window) cancelIdleCallback(id);
      else clearTimeout(id);
    };
  }, []);

  useEffect(() => {
    if (mailbox) setLastMailbox(mailbox.id);
  }, [mailbox]);

  useEffect(() => {
    const unread = view?.folder?.unread ?? 0;
    const label = view?.label ?? 'Mail';
    document.title = `${unread > 0 ? `(${unread}) ` : ''}${label} - Cirrus Mail`;
    return () => {
      document.title = 'Cirrus Mail';
    };
  }, [view?.folder?.unread, view?.label]);

  if (!mailbox) return <Navigate to="/" replace />;
  if (folder === 'search' && !q.trim()) return <Navigate to={`/mail/${mailbox.id}/inbox`} replace />;
  if (folders.data && !view) {
    return folder === 'inbox' ? <FullScreenSpinner /> : <Navigate to={`/mail/${mailbox.id}/inbox`} replace />;
  }

  const rail = <Rail mailbox={mailbox} folders={folders.data} onNavigate={layout === 'mobile' ? () => setDrawer(false) : undefined} />;
  const showList = layout === 'wide' || !threadId;
  const showReader = layout === 'wide' || !!threadId;

  return (
    <div className="flex h-full bg-bg">
      {layout === 'mobile' ? (
        <Drawer open={drawer} onClose={() => setDrawer(false)} label="Folders">
          {rail}
        </Drawer>
      ) : (
        rail
      )}
      {showList &&
        (view ? (
          <ThreadListPane
            mailbox={mailbox}
            view={view}
            folders={folders.data ?? []}
            ctl={ctl}
            onOpenMenu={layout === 'mobile' ? () => setDrawer(true) : undefined}
            className={layout === 'wide' ? 'w-[420px] shrink-0 border-r border-border 2xl:w-[480px]' : 'flex-1'}
          />
        ) : (
          <div className="flex-1"><FullScreenSpinner /></div>
        ))}
      {showReader &&
        (threadId ? (
          <ReaderPane
            key={threadId}
            mailbox={mailbox}
            threadId={threadId}
            view={view}
            folders={folders.data ?? []}
            ctl={ctl}
            showBack={layout !== 'wide'}
          />
        ) : (
          <ReaderEmpty />
        ))}
      {layout === 'mobile' && !threadId && !compose.isOpen && (
        <button
          type="button"
          aria-label="Compose"
          onClick={() => compose.open({ mailboxId: mailbox.id, mode: 'new' })}
          className="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 flex size-12 items-center justify-center rounded-full bg-primary-fill text-primary-fg shadow-[0_2px_6px_rgb(0_0_0/0.16),0_8px_24px_rgb(0_0_0/0.14)] active:bg-primary-fill-hover"
        >
          <PenLine size={20} strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}
