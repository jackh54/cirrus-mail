import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppPassword, AppPasswordCreateInput, AppPasswordCreateResponse } from '@shared/api';
import { api, asList } from '../api';
import { qk } from './keys';

export function useAppPasswords() {
  return useQuery({
    queryKey: qk.appPasswords,
    queryFn: async () => asList(await api.get<AppPassword[] | { items: AppPassword[] }>('/api/app-passwords')),
  });
}

export function useCreateAppPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AppPasswordCreateInput) => api.post<AppPasswordCreateResponse>('/api/app-passwords', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.appPasswords }),
  });
}

export function useRevokeAppPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/api/app-passwords/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.appPasswords }),
  });
}
