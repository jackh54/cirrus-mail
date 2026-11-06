import type { Attachment, DraftInput, MessageFull, SendResponse } from '@shared/api';
import { api, uploadFile } from '../../lib/api';

export const draftApi = {
  create: (mb: string, input: DraftInput) => api.post<MessageFull>(`/api/mailboxes/${mb}/drafts`, input),
  update: (mb: string, id: string, input: DraftInput) => api.put<MessageFull>(`/api/mailboxes/${mb}/drafts/${id}`, input),
  discard: (mb: string, id: string) => api.del<{ ok: boolean }>(`/api/mailboxes/${mb}/drafts/${id}`),
  send: (mb: string, id: string, sendAt?: number) =>
    api.post<SendResponse>(`/api/mailboxes/${mb}/drafts/${id}/send`, sendAt ? { sendAt } : {}),
  cancelSchedule: (mb: string, id: string) => api.post<{ ok: boolean }>(`/api/mailboxes/${mb}/messages/${id}/cancel-schedule`),
  upload: (mb: string, id: string, file: File, onProgress: (f: number) => void, signal?: AbortSignal) =>
    uploadFile<Attachment>(`/api/mailboxes/${mb}/drafts/${id}/attachments`, file, onProgress, signal),
  removeAttachment: (mb: string, id: string, aid: string) =>
    api.del<{ ok: boolean }>(`/api/mailboxes/${mb}/drafts/${id}/attachments/${aid}`),
};
