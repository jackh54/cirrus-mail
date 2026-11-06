import { useCallback, useState } from 'react';
import type { Attachment } from '@shared/api';
import { LIMITS } from '@shared/api';
import { errorMessage } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { draftApi } from './draftApi';
import type { Upload } from './AttachmentList';

/** Leave headroom for the message body and MIME encoding overhead (~37% for base64). */
const ATTACHMENT_BUDGET = Math.floor((LIMITS.maxMessageBytes * 0.97) / 1.37);

export function useAttachments(
  mailboxId: string,
  initial: Attachment[],
  ensureDraft: () => Promise<string>,
  onChanged: () => void,
) {
  const [attachments, setAttachments] = useState<Attachment[]>(initial);
  const [uploads, setUploads] = useState<Upload[]>([]);

  const patchUpload = (id: string, p: Partial<Upload>) => setUploads((xs) => xs.map((u) => (u.id === id ? { ...u, ...p } : u)));

  const addFiles = useCallback(
    async (files: File[]) => {
      let used = attachments.reduce((n, a) => n + a.size, 0) + uploads.filter((u) => !u.error).reduce((n, u) => n + u.size, 0);
      let count = attachments.length + uploads.filter((u) => !u.error).length;
      const accepted: { file: File; id: string }[] = [];
      const rejected: Upload[] = [];
      for (const file of files) {
        const id = `u${Math.random().toString(36).slice(2, 9)}`;
        if (count + 1 > LIMITS.maxAttachments) {
          rejected.push({ id, name: file.name, size: file.size, progress: 0, error: `max ${LIMITS.maxAttachments} files` });
        } else if (used + file.size > ATTACHMENT_BUDGET) {
          rejected.push({ id, name: file.name, size: file.size, progress: 0, error: `over the ${formatBytes(ATTACHMENT_BUDGET)} limit` });
        } else {
          used += file.size;
          count++;
          accepted.push({ file, id });
        }
      }
      setUploads((xs) => [...xs, ...rejected, ...accepted.map(({ file, id }) => ({ id, name: file.name, size: file.size, progress: 0 }))]);
      if (!accepted.length) return;

      let draftId: string;
      try {
        draftId = await ensureDraft();
      } catch (e) {
        accepted.forEach(({ id }) => patchUpload(id, { error: errorMessage(e) }));
        return;
      }
      await Promise.all(
        accepted.map(async ({ file, id }) => {
          try {
            const att = await draftApi.upload(mailboxId, draftId, file, (f) => patchUpload(id, { progress: f }));
            setUploads((xs) => xs.filter((u) => u.id !== id));
            setAttachments((xs) => [...xs, att]);
            onChanged();
          } catch (e) {
            patchUpload(id, { error: errorMessage(e) });
          }
        }),
      );
    },
    [attachments, uploads, ensureDraft, mailboxId, onChanged],
  );

  const remove = useCallback(
    async (a: Attachment, draftId: string | null) => {
      setAttachments((xs) => xs.filter((x) => x.id !== a.id));
      if (draftId) {
        try {
          await draftApi.removeAttachment(mailboxId, draftId, a.id);
        } catch {
          setAttachments((xs) => [...xs, a]);
        }
      }
      onChanged();
    },
    [mailboxId, onChanged],
  );

  const dismissUpload = useCallback((id: string) => setUploads((xs) => xs.filter((u) => u.id !== id)), []);
  const busy = uploads.some((u) => !u.error);
  return { attachments, uploads, addFiles, remove, dismissUpload, busy };
}
