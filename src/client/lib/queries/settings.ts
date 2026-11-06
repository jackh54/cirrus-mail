import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BlockedSender, Filter, FilterInput, MailboxSettings, Page } from '@shared/api';
import { api, asList } from '../api';
import { qk } from './keys';

export function useMailboxSettings(mb: string) {
  return useQuery({
    queryKey: qk.mailboxSettings(mb),
    enabled: !!mb,
    queryFn: () => api.get<MailboxSettings>(`/api/mailboxes/${mb}/settings`),
  });
}

export function useSaveMailboxSettings(mb: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (s: MailboxSettings) => api.put<MailboxSettings>(`/api/mailboxes/${mb}/settings`, s),
    onSuccess: (res, input) => {
      qc.setQueryData(qk.mailboxSettings(mb), res ?? input);
      void qc.invalidateQueries({ queryKey: qk.me });
    },
  });
}

export function useFilters(mb: string) {
  return useQuery({
    queryKey: qk.filters(mb),
    enabled: !!mb,
    queryFn: async () => asList(await api.get<Filter[] | Page<Filter>>(`/api/mailboxes/${mb}/filters`)),
  });
}

export function useFilterMutations(mb: string) {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: qk.filters(mb) });
  return {
    create: useMutation({ mutationFn: (f: FilterInput) => api.post<Filter>(`/api/mailboxes/${mb}/filters`, f), onSuccess: done }),
    update: useMutation({
      mutationFn: (f: Filter) => {
        const { id, ...rest } = f;
        return api.put<Filter>(`/api/mailboxes/${mb}/filters/${id}`, rest);
      },
      onSuccess: done,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.del(`/api/mailboxes/${mb}/filters/${id}`), onSuccess: done }),
  };
}

export function useBlocked(mb: string) {
  return useQuery({
    queryKey: qk.blocked(mb),
    enabled: !!mb,
    queryFn: async () => asList(await api.get<BlockedSender[] | Page<BlockedSender>>(`/api/mailboxes/${mb}/blocked`)),
  });
}

export function useBlockedMutations(mb: string) {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: qk.blocked(mb) });
  return {
    add: useMutation({
      mutationFn: (pattern: string) => api.post<BlockedSender>(`/api/mailboxes/${mb}/blocked`, { pattern }),
      onSuccess: done,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.del(`/api/mailboxes/${mb}/blocked/${id}`), onSuccess: done }),
  };
}
