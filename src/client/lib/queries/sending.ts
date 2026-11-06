import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminSettings, SendingStatus } from '@shared/api';
import { api } from '../api';
import { qk } from './keys';

/** Today's outbound count against the admin-set daily limit. Any signed-in user. */
export function useSendingStatus() {
  return useQuery({
    queryKey: qk.sending,
    queryFn: () => api.get<SendingStatus>('/api/sending'),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useAdminSettings() {
  return useQuery({ queryKey: qk.admin('settings'), queryFn: () => api.get<AdminSettings>('/api/admin/settings') });
}

export function useUpdateAdminSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: AdminSettings) => api.patch<AdminSettings>('/api/admin/settings', patch),
    onSuccess: (data) => {
      qc.setQueryData(qk.admin('settings'), data);
      void qc.invalidateQueries({ queryKey: qk.admin('stats') });
      void qc.invalidateQueries({ queryKey: qk.sending });
    },
  });
}
