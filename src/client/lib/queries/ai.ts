import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminAi, AdminAiPatch, AiStatus, CategoryCounts, SetCategoryInput, ThreadCategory, ThreadSummaryResponse } from '@shared/api';
import { api } from '../api';
import { qk } from './keys';
import { useMe } from './me';

/** Whether an admin has turned AI triage on. Everything AI-related in the UI hangs off this. */
export function useAiEnabled(): boolean {
  const { data } = useQuery({ queryKey: qk.ai, queryFn: () => api.get<AiStatus>('/api/ai/status'), staleTime: 5 * 60_000 });
  return !!data?.enabled;
}

/** Inbox tabs show when AI is on and the user has not turned them off in Appearance. */
export function useCategoryTabsOn(): boolean {
  const enabled = useAiEnabled();
  const user = useMe().data?.user;
  return enabled && !!user?.categoryTabs;
}

export function useCategoryCounts(mb: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.categories(mb),
    enabled: enabled && !!mb,
    staleTime: 15_000,
    queryFn: () => api.get<CategoryCounts>(`/api/mailboxes/${mb}/categories`),
  });
}

export function useSetCategory(mb: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: SetCategoryInput & { threadId: string }) => {
      const { threadId, ...body } = v;
      return api.put<{ category: ThreadCategory }>(`/api/mailboxes/${mb}/threads/${threadId}/category`, body);
    },
    onSettled: (_r, _e, v) => {
      void qc.invalidateQueries({ queryKey: qk.threadsAll(mb) });
      void qc.invalidateQueries({ queryKey: qk.categories(mb) });
      void qc.invalidateQueries({ queryKey: qk.thread(mb, v.threadId) });
    },
  });
}

/** The cached summary, if still current. Never triggers the model. */
export function useCachedSummary(mb: string, tid: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.summary(mb, tid),
    enabled: enabled && !!tid,
    staleTime: 0, // new mail makes the server's copy stale, so ask again whenever the reader opens
    queryFn: async () => (await api.get<ThreadSummaryResponse>(`/api/mailboxes/${mb}/threads/${tid}/summary`)).summary,
  });
}

export function useSummarize(mb: string, tid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post<ThreadSummaryResponse>(`/api/mailboxes/${mb}/threads/${tid}/summary`, {})).summary,
    onSuccess: (summary) => qc.setQueryData(qk.summary(mb, tid), summary),
  });
}

export function useAdminAi() {
  return useQuery({ queryKey: qk.adminAi, queryFn: () => api.get<AdminAi>('/api/admin/ai') });
}

export function useUpdateAdminAi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: AdminAiPatch) => api.patch<AdminAi>('/api/admin/ai', patch),
    onSuccess: (data) => {
      qc.setQueryData(qk.adminAi, data);
      void qc.invalidateQueries({ queryKey: qk.ai });
    },
  });
}
