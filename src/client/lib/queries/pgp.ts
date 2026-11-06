import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PgpKeyInput, PgpKeyResponse, PgpKeyringEntry, PgpKeyringImportInput, PgpKeyringResponse, PgpOwnKey,
} from '@shared/api';
import { api, asList } from '../api';

// Every key starts with 'pgp' so signing out (the cache is cleared) also locks the in-memory private key.
export const pgpKeys = {
  key: ['pgp', 'key'] as const,
  keyring: ['pgp', 'keyring'] as const,
};

/** The caller's own key (public + passphrase-encrypted private), or null when they have none. */
export function usePgpKey() {
  return useQuery({
    queryKey: pgpKeys.key,
    queryFn: async () => (await api.get<PgpKeyResponse>('/api/pgp/key')).key,
    staleTime: 5 * 60_000,
  });
}

export function useSavePgpKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PgpKeyInput): Promise<PgpOwnKey | null> => (await api.put<PgpKeyResponse>('/api/pgp/key', input)).key,
    onSuccess: (key) => qc.setQueryData(pgpKeys.key, key),
  });
}

export function useDeletePgpKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del<{ ok: boolean }>('/api/pgp/key'),
    onSuccess: () => qc.setQueryData(pgpKeys.key, null),
  });
}

export function usePgpKeyring() {
  return useQuery({
    queryKey: pgpKeys.keyring,
    queryFn: async () => asList(await api.get<{ items: PgpKeyringEntry[] }>('/api/pgp/keyring')),
    staleTime: 60_000,
  });
}

function useKeyringMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: pgpKeys.keyring }) });
}

export const useImportKeyringKey = () =>
  useKeyringMutation((input: PgpKeyringImportInput) => api.post<PgpKeyringResponse>('/api/pgp/keyring', input));
export const useWkdLookup = () =>
  useKeyringMutation((email: string) => api.post<PgpKeyringResponse>('/api/pgp/keyring/wkd', { email }));
export const useAcceptPendingKey = () =>
  useKeyringMutation((id: string) => api.post<{ entry: PgpKeyringEntry }>(`/api/pgp/keyring/${id}/accept`));
export const useDismissPendingKey = () =>
  useKeyringMutation((id: string) => api.del<{ ok: boolean }>(`/api/pgp/keyring/${id}/pending`));
export const useDeleteKeyringKey = () =>
  useKeyringMutation((id: string) => api.del<{ ok: boolean }>(`/api/pgp/keyring/${id}`));
