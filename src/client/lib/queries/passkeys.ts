import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthResponse, PasskeyAssertionJSON, PasskeyInfo, PasskeyOptionsResponse } from '@shared/api';
import { api, asList, request } from '../api';
import { createPasskey, getPasskey } from '../webauthn';
import { qk } from './keys';

/** Asks the server for a challenge and has the browser (or its autofill) sign it. */
export async function requestPasskeyAssertion(opts: { mfa?: boolean; conditional?: boolean; signal?: AbortSignal } = {}): Promise<PasskeyAssertionJSON> {
  const { options } = await api.post<PasskeyOptionsResponse>('/api/auth/passkey/options', { mfa: opts.mfa === true });
  return getPasskey(options, opts);
}

export function usePasskeyLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (opts: { conditional?: boolean; signal?: AbortSignal } = {}) =>
      api.post<AuthResponse>('/api/auth/passkey/login', { credential: await requestPasskeyAssertion(opts) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.me }),
  });
}

export function usePasskeys() {
  return useQuery({
    queryKey: qk.passkeys,
    queryFn: async () => asList(await api.get<PasskeyInfo[] | { items: PasskeyInfo[] }>('/api/me/passkeys')),
  });
}

export function useAddPasskey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { password: string; name: string }) => {
      const { options } = await api.post<PasskeyOptionsResponse>('/api/me/passkeys/options', { password: input.password });
      const credential = await createPasskey(options);
      return api.post<PasskeyInfo>('/api/me/passkeys', { credential, name: input.name || undefined });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.passkeys }),
  });
}

export function useRenamePasskey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; name: string }) => api.patch<{ ok: boolean }>(`/api/me/passkeys/${input.id}`, { name: input.name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.passkeys }),
  });
}

export function useDeletePasskey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; password: string }) =>
      request<{ ok: boolean }>(`/api/me/passkeys/${input.id}`, { method: 'DELETE', body: { password: input.password } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.passkeys }),
  });
}
