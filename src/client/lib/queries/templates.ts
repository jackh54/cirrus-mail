import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReplyTemplate, ReplyTemplateInput } from '@shared/api';
import { api, asList } from '../api';
import { qk } from './keys';

/** Reply templates of a mailbox (shared by its members). */
export function useTemplates(mb: string) {
  return useQuery({
    queryKey: qk.templates(mb),
    enabled: !!mb,
    staleTime: 60_000,
    queryFn: async () => asList(await api.get<ReplyTemplate[]>(`/api/mailboxes/${mb}/templates`)),
  });
}

export function useTemplateMutations(mb: string) {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: qk.templates(mb) });
  return {
    create: useMutation({ mutationFn: (t: ReplyTemplateInput) => api.post<ReplyTemplate>(`/api/mailboxes/${mb}/templates`, t), onSuccess: done }),
    update: useMutation({
      mutationFn: (v: { id: string } & ReplyTemplateInput) => {
        const { id, ...rest } = v;
        return api.patch<ReplyTemplate>(`/api/mailboxes/${mb}/templates/${id}`, rest);
      },
      onSuccess: done,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.del(`/api/mailboxes/${mb}/templates/${id}`), onSuccess: done }),
  };
}
