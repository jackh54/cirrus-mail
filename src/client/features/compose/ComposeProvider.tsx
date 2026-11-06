import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Address, MailboxSettings, MessageFull } from '@shared/api';
import { LIMITS } from '@shared/api';
import { useToast } from '../../components/Toast';
import { api, errorMessage } from '../../lib/api';
import { longDate } from '../../lib/format';
import { qk } from '../../lib/queries/keys';
import { useMeData } from '../../lib/queries/me';
import { draftApi } from './draftApi';
import type { ComposeDraft } from './types';

export type OpenInit =
  | { mailboxId: string; mode: 'new'; to?: Address[] }
  | { mailboxId: string; mode: 'reply' | 'reply_all' | 'forward'; parent: MessageFull }
  | { mailboxId: string; mode: 'draft'; draft: MessageFull };

interface ComposeApi {
  open: (init: OpenInit) => void;
  isOpen: boolean;
  /** Called by the sheet once the draft is saved; handles undo-send and scheduling. */
  queueSend: (d: ComposeDraft, sendAt?: number) => void;
  close: () => void;
  reopen: (d: ComposeDraft) => void;
}

const Ctx = createContext<ComposeApi | null>(null);

// The editor (TipTap/ProseMirror) is the heaviest dependency; load it on first compose.
const ComposeSheet = lazy(() => import('./ComposeSheet').then((m) => ({ default: m.ComposeSheet })));

// Prefill (quoting, signatures) needs DOMPurify, so it loads with compose rather than with the app.
const loadPrefill = () => import('./prefill');

/** Warm the compose chunks once the app is idle so the first open is instant. */
function prefetchCompose() {
  void import('./ComposeSheet');
  void loadPrefill();
}

export function ComposeProvider({ children }: { children: ReactNode }) {
  const { mailboxes } = useMeData();
  const qc = useQueryClient();
  const { toast, dismiss } = useToast();
  const [current, setCurrent] = useState<ComposeDraft | null>(null);
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const signatureFor = useCallback(
    async (mb: string): Promise<string> => {
      try {
        const s = await qc.fetchQuery({
          queryKey: qk.mailboxSettings(mb),
          queryFn: () => api.get<MailboxSettings>(`/api/mailboxes/${mb}/settings`),
          staleTime: 60_000,
        });
        return s.signatureHtml ?? '';
      } catch {
        return '';
      }
    },
    [qc],
  );

  const open = useCallback(
    (init: OpenInit) => {
      const mb = mailboxes.find((m) => m.id === init.mailboxId) ?? mailboxes[0];
      if (!mb) return;
      if (init.mode === 'draft') {
        void loadPrefill().then((p) => setCurrent(p.fromExistingDraft(init.draft, mb.id)));
        return;
      }
      void Promise.all([loadPrefill(), signatureFor(mb.id)]).then(([p, sig]) => {
        setCurrent(init.mode === 'new' ? p.buildNew(mb, sig, init.to) : p.buildReply(mb, sig, init.parent, init.mode));
      });
    },
    [mailboxes, signatureFor],
  );

  const refreshMail = useCallback(
    (mb: string) => {
      void qc.invalidateQueries({ queryKey: qk.threadsAll(mb) });
      void qc.invalidateQueries({ queryKey: qk.folders(mb) });
      void qc.invalidateQueries({ queryKey: ['thread', mb] });
    },
    [qc],
  );

  const failed = useCallback(
    (d: ComposeDraft, e: unknown) => {
      toast({
        tone: 'error',
        title: 'Message not sent',
        description: errorMessage(e),
        duration: 0,
        action: { label: 'Open draft', onClick: () => setCurrent({ ...d, key: `${d.key}r` }) },
      });
      refreshMail(d.mailboxId);
    },
    [toast, refreshMail],
  );

  const queueSend = useCallback(
    (d: ComposeDraft, sendAt?: number) => {
      const id = d.draftId;
      if (!id) return;
      setCurrent(null);

      if (sendAt) {
        draftApi
          .send(d.mailboxId, id, sendAt)
          .then(() => {
            refreshMail(d.mailboxId);
            toast({
              tone: 'success',
              title: `Scheduled for ${longDate(sendAt)}`,
              action: {
                label: 'Undo',
                onClick: () =>
                  void draftApi.cancelSchedule(d.mailboxId, id).then(() => {
                    refreshMail(d.mailboxId);
                    setCurrent({ ...d, key: `${d.key}u` });
                  }),
              },
            });
          })
          .catch((e: unknown) => failed(d, e));
        return;
      }

      let toastId = 0;
      const timer = setTimeout(() => {
        pending.current.delete(d.key);
        dismiss(toastId);
        draftApi
          .send(d.mailboxId, id)
          .then((res) => {
            refreshMail(d.mailboxId);
            toast({ tone: 'success', title: res.status === 'scheduled' ? 'Message scheduled' : 'Message sent' });
          })
          .catch((e: unknown) => failed(d, e));
      }, LIMITS.undoSendMs);
      pending.current.set(d.key, timer);
      toastId = toast({
        title: 'Sending…',
        duration: LIMITS.undoSendMs + 400,
        progress: true,
        action: {
          label: 'Undo',
          onClick: () => {
            clearTimeout(timer);
            pending.current.delete(d.key);
            setCurrent({ ...d, key: `${d.key}u` });
          },
        },
      });
    },
    [toast, dismiss, refreshMail, failed],
  );

  useEffect(() => {
    const id = 'requestIdleCallback' in window ? requestIdleCallback(prefetchCompose) : setTimeout(prefetchCompose, 2000);
    return () => {
      if ('cancelIdleCallback' in window) cancelIdleCallback(id);
      else clearTimeout(id);
    };
  }, []);

  // Warn before closing the tab while an undo window is still open.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pending.current.size) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const close = useCallback(() => setCurrent(null), []);
  const reopen = useCallback((d: ComposeDraft) => setCurrent(d), []);

  const value = useMemo<ComposeApi>(
    () => ({ open, isOpen: !!current, queueSend, close, reopen }),
    [open, current, queueSend, close, reopen],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {current && (
        <Suspense fallback={null}>
          <ComposeSheet key={current.key} initial={current} />
        </Suspense>
      )}
    </Ctx.Provider>
  );
}

export function useCompose(): ComposeApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCompose outside ComposeProvider');
  return v;
}
