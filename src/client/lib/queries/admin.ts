import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminCreateUserInput, AdminInviteInput, AdminInviteResponse, AdminMailbox, AdminMailboxInput, AdminStats, AdminUpdateUserInput, AdminUser, Alias,
  Domain, DomainCheck, Page,
} from '@shared/api';
import { api, asList } from '../api';
import { qk } from './keys';

type ListOf<T> = T[] | Page<T>;

export function useAdminStats() {
  return useQuery({ queryKey: qk.admin('stats'), queryFn: () => api.get<AdminStats>('/api/admin/stats') });
}
export function useAdminUsers() {
  return useQuery({ queryKey: qk.admin('users'), queryFn: async () => asList(await api.get<ListOf<AdminUser>>('/api/admin/users')) });
}
export function useAdminDomains() {
  return useQuery({ queryKey: qk.admin('domains'), queryFn: async () => asList(await api.get<ListOf<Domain>>('/api/admin/domains')) });
}
export function useAdminMailboxes() {
  return useQuery({
    queryKey: qk.admin('mailboxes'),
    queryFn: async () => asList(await api.get<ListOf<AdminMailbox>>('/api/admin/mailboxes')),
  });
}
export function useAdminAliases() {
  return useQuery({ queryKey: qk.admin('aliases'), queryFn: async () => asList(await api.get<ListOf<Alias>>('/api/admin/aliases')) });
}
export function useDomainCheck(id: string | null) {
  return useQuery({
    queryKey: qk.domainCheck(id ?? ''),
    enabled: !!id,
    staleTime: 0,
    queryFn: () => api.get<DomainCheck>(`/api/admin/domains/${id}/check`),
  });
}

/** Admin writes change counts everywhere, so they refresh the whole admin namespace plus /me. */
function useInvalidateAdmin() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['admin'] });
    void qc.invalidateQueries({ queryKey: qk.me });
  };
}

export function useUserMutations() {
  const done = useInvalidateAdmin();
  return {
    create: useMutation({ mutationFn: (u: AdminCreateUserInput) => api.post<AdminUser>('/api/admin/users', u), onSuccess: done }),
    invite: useMutation({ mutationFn: (u: AdminInviteInput) => api.post<AdminInviteResponse>('/api/admin/users/invite', u), onSuccess: done }),
    resendInvite: useMutation({
      mutationFn: (id: string) => api.post<AdminInviteResponse>(`/api/admin/users/${id}/invite`, {}),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: AdminUpdateUserInput }) => api.patch<AdminUser>(`/api/admin/users/${v.id}`, v.patch),
      onSuccess: done,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.del(`/api/admin/users/${id}`), onSuccess: done }),
  };
}

export function useDomainMutations() {
  const done = useInvalidateAdmin();
  return {
    create: useMutation({ mutationFn: (name: string) => api.post<Domain>('/api/admin/domains', { name }), onSuccess: done }),
    update: useMutation({
      mutationFn: (v: { id: string; catchAllMailboxId: string | null }) =>
        api.patch<Domain>(`/api/admin/domains/${v.id}`, { catchAllMailboxId: v.catchAllMailboxId }),
      onSuccess: done,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.del(`/api/admin/domains/${id}`), onSuccess: done }),
  };
}

export function useMailboxMutations() {
  const done = useInvalidateAdmin();
  return {
    create: useMutation({ mutationFn: (m: AdminMailboxInput) => api.post<AdminMailbox>('/api/admin/mailboxes', m), onSuccess: done }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: Partial<AdminMailboxInput> }) => api.patch<AdminMailbox>(`/api/admin/mailboxes/${v.id}`, v.patch),
      onSuccess: done,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.del(`/api/admin/mailboxes/${id}`), onSuccess: done }),
  };
}

export interface AliasInput { address: string; mailboxId: string; canSend: boolean }

export function useAliasMutations() {
  const done = useInvalidateAdmin();
  return {
    create: useMutation({ mutationFn: (a: AliasInput) => api.post<Alias>('/api/admin/aliases', a), onSuccess: done }),
    remove: useMutation({ mutationFn: (id: string) => api.del(`/api/admin/aliases/${id}`), onSuccess: done }),
  };
}
