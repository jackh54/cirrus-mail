import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import type {
  Contact, Folder, Page, ThreadAction, ThreadActionInput, ThreadCategory, ThreadDetail, ThreadSummary,
} from '@shared/api';
import { api, asList, asPage } from '../api';
import { qk } from './keys';

export type ThreadsData = InfiniteData<Page<ThreadSummary>, string | null>;

/** List key for a view: a folder id, `starred`, or `search`. */
export type ListKey = string;

export function useFolders(mb: string | undefined) {
  return useQuery({
    queryKey: qk.folders(mb ?? ''),
    enabled: !!mb,
    queryFn: async () => asList(await api.get<Folder[] | Page<Folder>>(`/api/mailboxes/${mb}/folders`)),
  });
}

export function useThreads(mb: string, listKey: ListKey, q: string, enabled = true, category?: ThreadCategory) {
  return useInfiniteQuery({
    queryKey: category ? [...qk.threads(mb, listKey, q), category] : qk.threads(mb, listKey, q),
    enabled: enabled && !!mb && !!listKey,
    // Switching folders keeps the previous list on screen until the next one arrives (no empty flash).
    placeholderData: keepPreviousData,
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page<ThreadSummary>) => last.nextCursor,
    queryFn: async ({ pageParam, signal }) =>
      asPage(
        await api.get<Page<ThreadSummary> | ThreadSummary[]>(
          `/api/mailboxes/${mb}/threads`,
          { folder: listKey === 'search' ? undefined : listKey, q: q || undefined, category, cursor: pageParam, limit: 50 },
          signal,
        ),
      ),
  });
}

/** Thread detail stays fresh for 30 s, so a prefetched thread opens straight from the cache. */
const THREAD_STALE_MS = 30_000;

function fetchThread(mb: string, tid: string, signal?: AbortSignal): Promise<ThreadDetail> {
  return api.get<ThreadDetail>(`/api/mailboxes/${mb}/threads/${tid}`, undefined, signal);
}

export function useThread(mb: string, tid: string | undefined) {
  return useQuery({
    queryKey: qk.thread(mb, tid ?? ''),
    enabled: !!tid,
    staleTime: THREAD_STALE_MS,
    queryFn: ({ signal }) => fetchThread(mb, tid ?? '', signal),
  });
}

/** Warm a thread's detail (row hover intent, j/k, neighbours of the open thread). No-op while fresh. */
export function prefetchThread(qc: QueryClient, mb: string, tid: string): void {
  if (!mb || !tid) return;
  void qc.prefetchQuery({
    queryKey: qk.thread(mb, tid),
    staleTime: THREAD_STALE_MS,
    queryFn: ({ signal }) => fetchThread(mb, tid, signal),
  });
}

const MOVES: ThreadAction[] = ['archive', 'trash', 'spam', 'not_spam', 'move', 'delete_forever'];

function patchThread(t: ThreadSummary, action: ThreadAction): ThreadSummary {
  switch (action) {
    case 'read': return { ...t, unreadCount: 0 };
    case 'unread': return { ...t, unreadCount: Math.max(1, t.unreadCount) };
    case 'star': return { ...t, isStarred: true };
    case 'unstar': return { ...t, isStarred: false };
    default: return t;
  }
}

function patchList(data: ThreadsData, ids: Set<string>, input: ThreadActionInput, listKey: string): ThreadsData {
  const { action } = input;
  const removes =
    action === 'delete_forever' ||
    (action === 'unstar' && listKey === 'starred') ||
    (MOVES.includes(action) && listKey !== 'starred' && listKey !== 'search' && input.folderId !== listKey);
  return {
    ...data,
    pages: data.pages.map((p) => ({
      ...p,
      items: removes
        ? p.items.filter((t) => !ids.has(t.id))
        : p.items.map((t) => (ids.has(t.id) ? patchThread(t, action) : t)),
    })),
  };
}

function unreadDelta(t: ThreadSummary, action: ThreadAction): number {
  if (action === 'read') return -t.unreadCount;
  if (action === 'unread' && t.unreadCount === 0) return 1;
  return 0;
}

/** Thread actions with optimistic list, detail and unread-count updates; rolled back on error. */
export function useThreadAction(mb: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ThreadActionInput) => api.post<{ ok: boolean }>(`/api/mailboxes/${mb}/threads/actions`, input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: qk.threadsAll(mb) });
      const ids = new Set(input.threadIds);
      const lists = qc.getQueriesData<ThreadsData>({ queryKey: qk.threadsAll(mb) });
      const details = input.threadIds.map((id) => [id, qc.getQueryData<ThreadDetail>(qk.thread(mb, id))] as const);
      const folders = qc.getQueryData<Folder[]>(qk.folders(mb));

      // Unread counts per folder, computed from whichever cached copy of each thread we have.
      const seen = new Map<string, ThreadSummary>();
      for (const [, data] of lists) {
        data?.pages.forEach((p) => p.items.forEach((t) => ids.has(t.id) && seen.set(t.id, t)));
      }
      for (const [id, d] of details) if (d && !seen.has(id)) seen.set(id, d.thread);
      if (folders && (input.action === 'read' || input.action === 'unread')) {
        const delta = new Map<string, number>();
        for (const t of seen.values()) {
          const n = unreadDelta(t, input.action);
          if (n) t.folderIds.forEach((f) => delta.set(f, (delta.get(f) ?? 0) + n));
        }
        qc.setQueryData<Folder[]>(
          qk.folders(mb),
          folders.map((f) => ({ ...f, unread: Math.max(0, f.unread + (delta.get(f.id) ?? 0)) })),
        );
      }

      for (const [key, data] of lists) {
        if (data) qc.setQueryData<ThreadsData>(key, patchList(data, ids, input, String(key[2] ?? '')));
      }
      for (const [id, d] of details) {
        if (!d) continue;
        const thread = patchThread(d.thread, input.action);
        const messages = d.messages.map((m) => {
          if (input.action === 'read') return { ...m, isRead: true };
          if (input.action === 'star' || input.action === 'unstar') return { ...m, isStarred: input.action === 'star' };
          return m;
        });
        if (input.action === 'unread' && messages.length) {
          messages[messages.length - 1] = { ...messages[messages.length - 1], isRead: false };
        }
        qc.setQueryData<ThreadDetail>(qk.thread(mb, id), { thread, messages });
      }
      return { lists, details, folders };
    },
    onError: (_e, _input, ctx) => {
      if (!ctx) return;
      for (const [key, data] of ctx.lists) qc.setQueryData(key, data);
      for (const [id, d] of ctx.details) if (d) qc.setQueryData(qk.thread(mb, id), d);
      if (ctx.folders) qc.setQueryData(qk.folders(mb), ctx.folders);
    },
    onSettled: (_r, _e, input) => {
      void qc.invalidateQueries({ queryKey: qk.threadsAll(mb) });
      void qc.invalidateQueries({ queryKey: qk.folders(mb) });
      void qc.invalidateQueries({ queryKey: qk.categories(mb) });
      void qc.invalidateQueries({ queryKey: qk.me });
      if (input.action === 'delete_forever') {
        input.threadIds.forEach((id) => qc.removeQueries({ queryKey: qk.thread(mb, id) }));
      }
    },
  });
}

export function useFolderMutations(mb: string) {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: qk.folders(mb) });
  return {
    create: useMutation({
      mutationFn: (name: string) => api.post<Folder>(`/api/mailboxes/${mb}/folders`, { name }),
      onSuccess: done,
    }),
    rename: useMutation({
      mutationFn: (v: { id: string; name: string }) => api.patch<Folder>(`/api/mailboxes/${mb}/folders/${v.id}`, { name: v.name }),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.del<{ ok: boolean }>(`/api/mailboxes/${mb}/folders/${id}`),
      onSuccess: done,
    }),
  };
}

/** Empty Trash/Spam: there is no bulk endpoint, so page through the folder and delete in chunks. */
export async function emptyFolder(mb: string, folderId: string): Promise<number> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<ThreadSummary> = asPage(
      await api.get<Page<ThreadSummary> | ThreadSummary[]>(`/api/mailboxes/${mb}/threads`, { folder: folderId, cursor, limit: 100 }),
    );
    ids.push(...page.items.map((t) => t.id));
    cursor = page.nextCursor;
  } while (cursor && ids.length < 10_000);
  for (let i = 0; i < ids.length; i += 100) {
    await api.post(`/api/mailboxes/${mb}/threads/actions`, { threadIds: ids.slice(i, i + 100), action: 'delete_forever' });
  }
  return ids.length;
}

export function useContacts(q: string) {
  return useQuery({
    queryKey: qk.contacts(q),
    enabled: q.trim().length > 0,
    staleTime: 60_000,
    queryFn: async ({ signal }) => asList(await api.get<Contact[] | Page<Contact>>('/api/contacts', { q }, signal)),
  });
}
