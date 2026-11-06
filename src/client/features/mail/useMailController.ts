import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { Folder, ThreadAction, ThreadDetail, ThreadSummary } from '@shared/api';
import { api } from '../../lib/api';
import { useHotkeys } from '../../lib/hotkeys';
import { qk } from '../../lib/queries/keys';
import { useCategoryTabsOn } from '../../lib/queries/ai';
import { prefetchThread, useThreads } from '../../lib/queries/mail';
import { OPEN_LABEL_PICKER_EVENT } from './labelMeta';
import { useCompose } from '../compose/ComposeProvider';
import { MUTE_EVENT, SNOOZE_EVENT } from '../palette/events';
import { useCategoryTab } from './categoryTab';
import type { ResolvedView } from './folderMeta';
import { useMailRoute } from './useMailRoute';
import { useThreadActions } from './useThreadActions';

const MOVES: ThreadAction[] = ['archive', 'trash', 'spam', 'not_spam', 'move', 'delete_forever'];


/** List state, selection, navigation and the list-level keyboard shortcuts for the mail view. */
export function useMailController(view: ResolvedView | null, folders: Folder[] | undefined) {
  const route = useMailRoute();
  const { mailboxId: mb, threadId } = route;
  const navigate = useNavigate();
  const compose = useCompose();
  const qc = useQueryClient();
  // Inbox tabs (optional AI triage): only the Inbox, and only while an admin has AI on and the user keeps tabs on.
  const tabsOn = useCategoryTabsOn() && view?.role === 'inbox';
  const tab = useCategoryTab();
  const category = tabsOn ? tab : undefined;
  const query = useThreads(mb, view?.listKey ?? '', route.q, !!view, category);
  const threads = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const [focusIndex, setFocusIndex] = useState(0);
  // The keyboard cursor ring only shows once j/k has been used, and hides again on a pointer open.
  const [cursorVisible, setCursorVisible] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [snoozeIds, setSnoozeIds] = useState<string[] | null>(null);
  const anchor = useRef<number | null>(null);
  const runAction = useThreadActions(mb, view?.listKey ?? null, folders);
  // Threads the label picker is open for (null = closed).
  const [labelTargets, setLabelTargets] = useState<string[] | null>(null);

  useEffect(() => {
    setSelected(new Set());
    setFocusIndex(0);
    setCursorVisible(false);
    setLabelTargets(null);
    anchor.current = null;
  }, [mb, view?.listKey, route.q, category]);

  // Keep the keyboard cursor on the open thread.
  useEffect(() => {
    if (!threadId) return;
    const i = threads.findIndex((t) => t.id === threadId);
    if (i >= 0) setFocusIndex(i);
  }, [threadId, threads]);

  // With a thread open, warm its neighbours so j/k and the reader's arrows open from cache.
  useEffect(() => {
    if (!threadId) return;
    const i = threads.findIndex((t) => t.id === threadId);
    if (i < 0) return;
    const ids = [threads[i + 1]?.id, threads[i - 1]?.id].filter((x): x is string => !!x);
    const timer = setTimeout(() => ids.forEach((id) => prefetchThread(qc, mb, id)), 150);
    return () => clearTimeout(timer);
  }, [threadId, threads, qc, mb]);

  const prefetch = useCallback((id: string) => prefetchThread(qc, mb, id), [qc, mb]);
  const hideCursor = useCallback(() => setCursorVisible(false), []);

  const openThread = useCallback(
    async (t: ThreadSummary, i: number) => {
      setFocusIndex(i);
      if (view?.role === 'drafts') {
        try {
          const d = await qc.fetchQuery({
            queryKey: qk.thread(mb, t.id),
            queryFn: () => api.get<ThreadDetail>(`/api/mailboxes/${mb}/threads/${t.id}`),
          });
          const draft = [...d.messages].reverse().find((m) => m.status === 'draft' || m.status === 'failed');
          if (draft) {
            compose.open({ mailboxId: mb, mode: 'draft', draft });
            return;
          }
        } catch {
          /* fall through to the reader */
        }
      }
      navigate(route.threadUrl(t.id));
    },
    [view?.role, qc, mb, compose, navigate, route],
  );

  const toggle = useCallback(
    (id: string, i: number, range: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (range && anchor.current !== null) {
          const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
          threads.slice(a, b + 1).forEach((t) => next.add(t.id));
        } else if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      anchor.current = i;
    },
    [threads],
  );

  const selectAll = useCallback(
    (on: boolean) => setSelected(on ? new Set(threads.map((t) => t.id)) : new Set()),
    [threads],
  );

  const targets = useCallback((): string[] => {
    if (selected.size) return [...selected];
    if (threadId) return [threadId];
    const t = threads[focusIndex];
    return t ? [t.id] : [];
  }, [selected, threadId, threads, focusIndex]);

  const act = useCallback(
    async (action: ThreadAction, ids?: string[], folderId?: string, until?: number) => {
      const list = ids ?? targets();
      if (!list.length) return;
      let next: ThreadSummary | undefined;
      const leaves = MOVES.includes(action) || (action === 'snooze' && view?.role === 'inbox') || (action === 'unsnooze' && view?.role === 'snoozed');
      const closesOpen = !!threadId && list.includes(threadId) && leaves;
      if (closesOpen) {
        const i = threads.findIndex((t) => t.id === threadId);
        next = threads.slice(i + 1).find((t) => !list.includes(t.id)) ?? threads.slice(0, Math.max(0, i)).reverse().find((t) => !list.includes(t.id));
      }
      const ok = await runAction(action, list, folderId, until);
      if (!ok) return;
      if (!ids && selected.size) setSelected(new Set());
      if (closesOpen) navigate(next ? route.threadUrl(next.id) : route.listUrl, { replace: true });
    },
    [targets, threadId, threads, runAction, selected.size, navigate, route, view?.role],
  );

  const starToggle = useCallback(() => {
    const list = targets();
    if (!list.length) return;
    const detail = threadId ? qc.getQueryData<ThreadDetail>(qk.thread(mb, threadId)) : undefined;
    const allStarred = list.every((id) => (threads.find((t) => t.id === id) ?? (detail?.thread.id === id ? detail.thread : undefined))?.isStarred);
    void act(allStarred ? 'unstar' : 'star', list);
  }, [targets, threadId, qc, mb, threads, act]);

  const openSnooze = useCallback(
    (ids?: string[]) => {
      const list = ids ?? targets();
      if (list.length) setSnoozeIds(list);
    },
    [targets],
  );
  const closeSnooze = useCallback(() => setSnoozeIds(null), []);

  const muteToggle = useCallback(() => {
    const list = targets();
    if (!list.length) return;
    const detail = threadId ? qc.getQueryData<ThreadDetail>(qk.thread(mb, threadId)) : undefined;
    const allMuted = list.every((id) => (threads.find((t) => t.id === id) ?? (detail?.thread.id === id ? detail.thread : undefined))?.muted);
    void act(allMuted ? 'unmute' : 'mute', list);
  }, [targets, threadId, qc, mb, threads, act]);

  const palette = useRef({ openSnooze, muteToggle });
  palette.current = { openSnooze, muteToggle };
  useEffect(() => {
    const snooze = () => palette.current.openSnooze();
    const mute = () => palette.current.muteToggle();
    window.addEventListener(SNOOZE_EVENT, snooze);
    window.addEventListener(MUTE_EVENT, mute);
    return () => {
      window.removeEventListener(SNOOZE_EVENT, snooze);
      window.removeEventListener(MUTE_EVENT, mute);
    };
  }, []);
  const openLabels = useCallback(
    (ids?: string[]) => {
      const list = ids ?? targets();
      if (list.length) setLabelTargets(list);
    },
    [targets],
  );
  const closeLabels = useCallback(() => setLabelTargets(null), []);
  // The palette (and anything else) opens the picker through a window event.
  useEffect(() => {
    const on = () => openLabels();
    window.addEventListener(OPEN_LABEL_PICKER_EVENT, on);
    return () => window.removeEventListener(OPEN_LABEL_PICKER_EVENT, on);
  }, [openLabels]);
  // What the client knows about the targets, so the picker can show which labels they carry.
  const labelThreads = useMemo(
    () => (labelTargets ?? []).flatMap((id) => {
      const t = threads.find((x) => x.id === id) ?? qc.getQueryData<ThreadDetail>(qk.thread(mb, id))?.thread;
      return t ? [t] : [];
    }),
    [labelTargets, threads, qc, mb],
  );

  const step = (delta: number) => {
    if (!threads.length) return;
    if (threadId) {
      const i = threads.findIndex((t) => t.id === threadId);
      const n = threads[Math.max(0, Math.min(threads.length - 1, (i < 0 ? focusIndex : i) + delta))];
      if (n && n.id !== threadId) navigate(route.threadUrl(n.id), { replace: true });
    } else {
      const next = cursorVisible ? Math.max(0, Math.min(threads.length - 1, focusIndex + delta)) : focusIndex;
      setCursorVisible(true);
      setFocusIndex(next);
      const t = threads[next];
      if (t) prefetch(t.id);
      if (next >= threads.length - 5 && query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    }
  };

  const role = view?.role;
  const openFocused = () => {
    const t = threads[focusIndex];
    if (t && !threadId) void openThread(t, focusIndex);
  };
  useHotkeys({
    c: () => compose.open({ mailboxId: mb, mode: 'new' }),
    '/': () => document.getElementById('cirrus-search')?.focus(),
    j: () => step(1),
    k: () => step(-1),
    o: openFocused,
    Enter: openFocused,
    u: () => threadId && navigate(route.listUrl),
    e: () => role !== 'archive' && void act('archive'),
    '#': () => void act(role === 'trash' || role === 'spam' ? 'delete_forever' : 'trash'),
    s: starToggle,
    b: () => openSnooze(),
    m: muteToggle,
    l: () => openLabels(),
    I: () => void act('read'),
    U: () => void act('unread'),
    Escape: () => selected.size && setSelected(new Set()),
  });

  return {
    query, tabsOn, category, threads, focusIndex, cursorVisible, selected, toggle, selectAll, openThread, act, prefetch, hideCursor,
    labelTargets, labelThreads, snoozeIds, openSnooze, closeSnooze, openLabels, closeLabels,
  };
}

export type MailController = ReturnType<typeof useMailController>;
