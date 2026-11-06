import { useQuery } from '@tanstack/react-query';
import type { MboxImport } from '@shared/api';
import { ApiError, api } from '../api';
import { qk } from './keys';

const ACTIVE = new Set(['uploading', 'processing']);

/** The mailbox's latest import. Polls while the cron is working through it; an upload in this tab reports its own progress. */
export function useMboxImport(mb: string, uploadingHere: boolean) {
  return useQuery({
    queryKey: qk.mboxImport(mb),
    enabled: !!mb,
    queryFn: () => api.get<MboxImport | null>(`/api/mailboxes/${mb}/import`),
    refetchInterval: (q) => (q.state.data?.status === 'processing' || (q.state.data && ACTIVE.has(q.state.data.status) && !uploadingHere) ? 3000 : false),
  });
}

/** Uploads one part with XHR, so the bar moves within a 16 MB part too. */
export function putPart(path: string, body: Blob, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', path);
    xhr.setRequestHeader('X-Cirrus', '1');
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = 'Upload failed';
      try { message = (JSON.parse(xhr.responseText) as { error: { message: string } }).error.message; } catch { /* keep default */ }
      reject(new ApiError(`HTTP_${xhr.status}`, message, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('NETWORK_ERROR', 'Upload failed. Check your connection.', 0));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}
