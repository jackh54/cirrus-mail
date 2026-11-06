import { disablePush, setThisDeviceId } from '../push';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AuthResponse, ChangePasswordInput, LoginInput, MeResponse, SessionInfo, SetupInput, SetupStatus,
  TotpBeginResponse, TotpEnableResponse, UpdateMeInput,
} from '@shared/api';
import { api, asList } from '../api';
import { applyPrefs } from '../theme';
import { qk } from './keys';

export function useSetupStatus() {
  return useQuery({ queryKey: qk.setup, queryFn: () => api.get<SetupStatus>('/api/setup/status'), staleTime: 0 });
}

export function useMe() {
  return useQuery({ queryKey: qk.me, queryFn: () => api.get<MeResponse>('/api/me'), staleTime: 60_000 });
}

/** Non-suspending accessor for components rendered below the authenticated shell. */
export function useMeData(): MeResponse {
  const { data } = useMe();
  if (!data) throw new Error('useMeData used outside the authenticated shell');
  return data;
}

export function useSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetupInput) => api.post<AuthResponse>('/api/setup', input),
    onSuccess: () => {
      qc.setQueryData<SetupStatus>(qk.setup, { needsSetup: false });
      void qc.invalidateQueries({ queryKey: qk.me });
    },
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginInput) => api.post<AuthResponse>('/api/auth/login', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.me }),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      // Best effort: stop mail alerts on this device before the session ends.
      await disablePush().catch(() => undefined);
      setThisDeviceId(null);
      return api.post<{ ok: boolean }>('/api/auth/logout');
    },
    onSettled: () => qc.clear(),
  });
}

export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMeInput) => api.patch<AuthResponse>('/api/me', input),
    onMutate: (input) => {
      if (input.theme || input.density) applyPrefs({ theme: input.theme, density: input.density });
      const prev = qc.getQueryData<MeResponse>(qk.me);
      if (prev) qc.setQueryData<MeResponse>(qk.me, { ...prev, user: { ...prev.user, ...input } });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) {
        qc.setQueryData(qk.me, ctx.prev);
        applyPrefs({ theme: ctx.prev.user.theme, density: ctx.prev.user.density });
      }
    },
    onSuccess: (res) => {
      const prev = qc.getQueryData<MeResponse>(qk.me);
      if (prev) qc.setQueryData<MeResponse>(qk.me, { ...prev, user: res.user });
    },
  });
}

export function useChangePassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ChangePasswordInput) => api.post<{ ok: boolean }>('/api/me/password', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.me }),
  });
}

export function useTotpBegin() {
  return useMutation({ mutationFn: () => api.post<TotpBeginResponse>('/api/me/totp/begin') });
}

export function useTotpEnable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => api.post<TotpEnableResponse>('/api/me/totp/enable', { code }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.me }),
  });
}

export function useTotpDisable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (password: string) => api.post<{ ok: boolean }>('/api/me/totp/disable', { password }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.me }),
  });
}

export function useSessions() {
  return useQuery({
    queryKey: qk.sessions,
    queryFn: async () => asList(await api.get<SessionInfo[] | { items: SessionInfo[] }>('/api/me/sessions')),
  });
}

export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/api/me/sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.sessions }),
  });
}
