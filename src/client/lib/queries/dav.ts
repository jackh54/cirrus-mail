import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ContactInput, ContactView, DavCollectionInfo, DavCollectionInput, EventInput, EventView, InvitePreview, Page } from '@shared/api';
import { api, asList } from '../api';

export const davKeys = {
  collections: ['dav', 'collections'] as const,
  contacts: ['dav', 'contacts'] as const,
  eventsAll: ['dav', 'events'] as const,
  events: (from: string, to: string) => ['dav', 'events', from, to] as const,
  invite: (url: string) => ['dav', 'invite', url] as const,
};

export function useCollections() {
  return useQuery({
    queryKey: davKeys.collections,
    staleTime: 60_000,
    queryFn: async () => asList(await api.get<DavCollectionInfo[]>('/api/dav/collections')),
  });
}

export function useCollectionMutations() {
  const qc = useQueryClient();
  const settle = () => qc.invalidateQueries({ queryKey: davKeys.collections });
  return {
    create: useMutation({ mutationFn: (b: DavCollectionInput) => api.post<DavCollectionInfo>('/api/dav/collections', b), onSettled: settle }),
    update: useMutation({
      mutationFn: ({ id, ...b }: { id: string; name?: string; color?: string | null }) => api.patch<DavCollectionInfo>(`/api/dav/collections/${id}`, b),
      onMutate: async ({ id, ...b }) => {
        await qc.cancelQueries({ queryKey: davKeys.collections });
        const prev = qc.getQueryData<DavCollectionInfo[]>(davKeys.collections);
        qc.setQueryData<DavCollectionInfo[]>(davKeys.collections, (xs) => xs?.map((c) => (c.id === id ? { ...c, ...(b.name !== undefined && { name: b.name }), ...(b.color !== undefined && { color: b.color }) } : c)));
        return { prev };
      },
      onError: (_e, _v, ctx) => qc.setQueryData(davKeys.collections, ctx?.prev),
      onSettled: settle,
    }),
  };
}

// ---------- contacts ----------

/** The whole address book (a few thousand cards at most); search and grouping happen on the client. */
export function useContacts() {
  return useQuery({
    queryKey: davKeys.contacts,
    staleTime: 60_000,
    queryFn: async () => asList(await api.get<Page<ContactView>>('/api/dav/contacts', { limit: 2000 })),
  });
}

export function useContactMutations() {
  const qc = useQueryClient();
  const key = davKeys.contacts;
  const patch = async (fn: (xs: ContactView[]) => ContactView[]) => {
    await qc.cancelQueries({ queryKey: key });
    const prev = qc.getQueryData<ContactView[]>(key);
    qc.setQueryData<ContactView[]>(key, (xs) => fn(xs ?? []));
    return { prev };
  };
  const rollback = (_e: unknown, _v: unknown, ctx: { prev?: ContactView[] } | undefined) => qc.setQueryData(key, ctx?.prev);
  const settle = () => qc.invalidateQueries({ queryKey: key });
  const sorted = (xs: ContactView[]) => [...xs].sort((a, b) => a.fn.localeCompare(b.fn, undefined, { sensitivity: 'base' }));
  return {
    create: useMutation({
      mutationFn: (c: ContactInput) => api.post<ContactView>('/api/dav/contacts', c),
      onMutate: (c) => patch((xs) => sorted([...xs, { ...c, id: `tmp-${Date.now()}`, addressBookId: c.addressBookId ?? '', etag: '', updatedAt: Date.now() }])),
      onError: rollback,
      onSettled: settle,
    }),
    update: useMutation({
      mutationFn: ({ id, ...c }: { id: string } & ContactInput) => api.put<ContactView>(`/api/dav/contacts/${id}`, c),
      onMutate: ({ id, ...c }) => patch((xs) => sorted(xs.map((x) => (x.id === id ? { ...x, ...c, addressBookId: x.addressBookId } : x)))),
      onError: rollback,
      onSettled: settle,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.del(`/api/dav/contacts/${id}`),
      onMutate: (id) => patch((xs) => xs.filter((x) => x.id !== id)),
      onError: rollback,
      onSettled: settle,
    }),
  };
}

// ---------- events ----------

/** Events overlapping [from, to) (ISO instants). Recurring masters come back once; the client expands them. */
export function useEvents(from: string, to: string) {
  return useQuery({
    queryKey: davKeys.events(from, to),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => asList(await api.get<Page<EventView>>('/api/dav/events', { from, to }, signal)),
  });
}

type EventCache = [readonly unknown[], EventView[] | undefined][];

export function useEventMutations() {
  const qc = useQueryClient();
  // Every cached window is patched: occurrences are filtered to the visible range on the client anyway.
  const patch = async (fn: (xs: EventView[]) => EventView[]) => {
    await qc.cancelQueries({ queryKey: davKeys.eventsAll });
    const prev = qc.getQueriesData<EventView[]>({ queryKey: davKeys.eventsAll }) as EventCache;
    qc.setQueriesData<EventView[]>({ queryKey: davKeys.eventsAll }, (xs) => (xs ? fn(xs) : xs));
    return { prev };
  };
  const rollback = (_e: unknown, _v: unknown, ctx: { prev: EventCache } | undefined) => ctx?.prev.forEach(([k, d]) => qc.setQueryData(k, d));
  const settle = () => qc.invalidateQueries({ queryKey: davKeys.eventsAll });
  const view = (i: EventInput, base: Partial<EventView>): EventView => ({
    id: '', uid: '', etag: '', recurring: !!i.rrule, tzid: null, updatedAt: Date.now(), calendarId: i.calendarId ?? '', ...i, ...base,
  });
  return {
    create: useMutation({
      mutationFn: (i: EventInput) => api.post<EventView>('/api/dav/events', i),
      onMutate: (i) => patch((xs) => [...xs, view(i, { id: `tmp-${Date.now()}` })]),
      onError: rollback,
      onSettled: settle,
    }),
    update: useMutation({
      mutationFn: ({ id, ...i }: { id: string } & EventInput) => api.put<EventView>(`/api/dav/events/${id}`, i),
      onMutate: ({ id, ...i }) => patch((xs) => xs.map((x) => (x.id === id ? view(i, { id, uid: x.uid, etag: x.etag, calendarId: x.calendarId }) : x))),
      onError: rollback,
      onSettled: settle,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.del(`/api/dav/events/${id}`),
      onMutate: (id) => patch((xs) => xs.filter((x) => x.id !== id)),
      onError: rollback,
      onSettled: settle,
    }),
  };
}

// ---------- invitations ----------

export function parseInvite(ics: string) {
  return api.post<InvitePreview>('/api/dav/invite/parse', { ics });
}

export function useAcceptInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ics: string) => api.post<EventView>('/api/dav/invite/accept', { ics }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['dav', 'events'] }),
  });
}
