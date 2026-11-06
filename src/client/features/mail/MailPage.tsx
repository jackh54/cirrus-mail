import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router';
import { PenLine } from 'lucide-react';
import { Drawer, type DrawerHandle } from '../../components/Drawer';
import { committed, EDGE_PX, trackHorizontalDrag } from '../../components/gestures';
import { FullScreenSpinner } from '../../components/Spinner';
import { useFolders } from '../../lib/queries/mail';
import { useMeData } from '../../lib/queries/me';
import { setLastMailbox } from '../../lib/storage';
import { useCompose } from '../compose/ComposeProvider';
import { resolveView } from './folderMeta';
import { Rail } from './Rail';
import { ReaderEmpty } from './ReaderEmpty';
import { ReaderPane } from './ReaderPane';
import { SnoozeDialog } from './SnoozeDialog';
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
  const mobile = layout === 'mobile';
  // 'swipe' when an edge swipe is opening it, so the finger drives the slide-in.
  const [drawer, setDrawer] = useState<false | 'tap' | 'swipe'>(false);
  const drawerRef = useRef<DrawerHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
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

  // Phone list: a swipe in from the left edge pulls the folders drawer open under the finger.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !mobile || threadId) return;
    const width = () => Math.min(288, innerWidth * 0.86);
    const release = (open: boolean) => {
      if (drawerRef.current) drawerRef.current.release(open);
      else requestAnimationFrame(() => drawerRef.current?.release(open));
    };
    return trackHorizontalDrag(el, {
      start: (x) => x < EDGE_PX,
      lock: () => setDrawer('swipe'),
      move: (dx) => drawerRef.current?.drag(dx),
      end: (dx, vx) => release(dx > 0 && committed(dx, vx, width())),
      cancel: () => release(false),
    });
  }, [mobile, threadId]);

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

  const rail = <Rail mailbox={mailbox} folders={folders.data} onNavigate={mobile ? () => setDrawer(false) : undefined} />;
  // On phones the list stays mounted under the open reader, so going back keeps its scroll position
  // and the back swipe reveals it under the finger.
  const showList = layout !== 'medium' || !threadId;
  const showReader = layout === 'wide' || !!threadId;

  return (
    <div ref={rootRef} className="relative flex h-full bg-bg">
      {mobile ? (
        <Drawer open={!!drawer} dragging={drawer === 'swipe'} handle={drawerRef} onClose={() => setDrawer(false)} label="Folders">
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
            onOpenMenu={mobile ? () => setDrawer('tap') : undefined}
            mobile={mobile}
            inert={mobile && !!threadId}
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
            mobile={mobile}
            className={mobile ? 'absolute inset-0 z-10' : undefined}
          />
        ) : (
          <ReaderEmpty />
        ))}
      <SnoozeDialog
        open={!!ctl.snoozeIds}
        onClose={ctl.closeSnooze}
        onPick={(at) => {
          const ids = ctl.snoozeIds;
          ctl.closeSnooze();
          if (!ids) return;
          void ctl.act('snooze', ids, undefined, at);
          ctl.selectAll(false);
        }}
      />
      {mobile && !threadId && !compose.isOpen && (
        <button
          type="button"
          aria-label="Compose"
          onClick={() => compose.open({ mailboxId: mailbox.id, mode: 'new' })}
          className="fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 flex size-14 items-center justify-center rounded-full bg-primary-fill text-primary-fg shadow-[0_2px_6px_rgb(0_0_0/0.16),0_8px_24px_rgb(0_0_0/0.14)] transition-transform duration-100 active:scale-95 active:bg-primary-fill-hover"
        >
          <PenLine size={22} strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}
