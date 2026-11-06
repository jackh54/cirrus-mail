import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Label, LabelColor, Page, ThreadDetail, ThreadLabelsInput, ThreadSummary } from '@shared/api';
import { api, asList } from '../api';
import { qk } from './keys';
import { isLabelKey, LABEL_KEY, type ThreadsData } from './mail';

export function useLabels(mb: string | undefined) {
  return useQuery({
    queryKey: qk.labels(mb ?? ''),
    enabled: !!mb,
    queryFn: async () => asList(await api.get<Label[] | Page<Label>>(`/api/mailboxes/${mb}/labels`)),
  });
}

export function useLabelMutations(mb: string) {
  const qc = useQueryClient();
  // Renames and colours show on thread rows too, and deleting a label changes every list that carried it.
  const done = () => Promise.all([qc.invalidateQueries({ queryKey: qk.labels(mb) }), qc.invalidateQueries({ queryKey: qk.threadsAll(mb) })]);
  return {
    create: useMutation({
      mutationFn: (v: { name: string; color: LabelColor }) => api.post<Label>(`/api/mailboxes/${mb}/labels`, v),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: (v: { id: string; name?: string; color?: LabelColor }) => {
        const { id, ...body } = v;
        return api.patch<Label>(`/api/mailboxes/${mb}/labels/${id}`, body);
      },
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.del<{ ok: boolean }>(`/api/mailboxes/${mb}/labels/${id}`),
      onSuccess: done,
    }),
  };
}

function patchLabels(t: ThreadSummary, input: ThreadLabelsInput): ThreadSummary {
  const remove = new Set(input.remove ?? []);
  const labels = [...new Set([...t.labels, ...(input.add ?? [])])].filter((l) => !remove.has(l));
  return { ...t, labels };
}

/** Add/remove labels on threads: lists and open threads update at once and roll back on error. */
export function useApplyLabels(mb: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ThreadLabelsInput) => api.post<{ ok: boolean }>(`/api/mailboxes/${mb}/threads/labels`, input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: qk.threadsAll(mb) });
      const ids = new Set(input.threadIds);
      const lists = qc.getQueriesData<ThreadsData>({ queryKey: qk.threadsAll(mb) });
      const details = input.threadIds.map((id) => [id, qc.getQueryData<ThreadDetail>(qk.thread(mb, id))] as const);
      for (const [key, data] of lists) {
        if (!data) continue;
        const listKey = String(key[2] ?? '');
        // Taking the viewed label off a thread removes its row from that label's list.
        const dropped = isLabelKey(listKey) && (input.remove ?? []).includes(listKey.slice(LABEL_KEY.length));
        qc.setQueryData<ThreadsData>(key, {
          ...data,
          pages: data.pages.map((p) => ({
            ...p,
            items: p.items.flatMap((t) => (!ids.has(t.id) ? [t] : dropped ? [] : [patchLabels(t, input)])),
          })),
        });
      }
      for (const [id, d] of details) if (d) qc.setQueryData<ThreadDetail>(qk.thread(mb, id), { ...d, thread: patchLabels(d.thread, input) });
      return { lists, details };
    },
    onError: (_e, _input, ctx) => {
      if (!ctx) return;
      for (const [key, data] of ctx.lists) qc.setQueryData(key, data);
      for (const [id, d] of ctx.details) if (d) qc.setQueryData(qk.thread(mb, id), d);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.threadsAll(mb) });
      void qc.invalidateQueries({ queryKey: qk.labels(mb) });
    },
  });
}
