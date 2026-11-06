import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PollResponse } from '@shared/api';
import { LIMITS } from '@shared/api';
import { api } from '../../lib/api';
import { displayName } from '../../lib/format';
import { qk } from '../../lib/queries/keys';

/** Poll /poll every 30 s while the tab is visible; refresh lists and notify on new mail. */
export function usePolling(mb: string) {
  const qc = useQueryClient();
  const since = useRef(Date.now());

  useEffect(() => {
    if (!mb) return;
    since.current = Date.now();
    let timer: ReturnType<typeof setInterval> | null = null;
    let busy = false;

    const tick = async () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const res = await api.get<PollResponse>(`/api/mailboxes/${mb}/poll`, { since: since.current });
        if (res.newCount > 0) {
          since.current = Math.max(since.current, ...res.latest.map((t) => t.lastMessageAt));
          void qc.invalidateQueries({ queryKey: qk.threadsAll(mb) });
          void qc.invalidateQueries({ queryKey: qk.folders(mb) });
          void qc.invalidateQueries({ queryKey: qk.me });
          notify(res);
        }
      } catch {
        /* transient; try again next tick */
      } finally {
        busy = false;
      }
    };

    const start = () => {
      if (timer) return;
      timer = setInterval(() => void tick(), LIMITS.pollIntervalMs);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void tick();
        start();
      } else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [mb, qc]);
}

function notify(res: PollResponse) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (document.hasFocus()) return; // the list already updates in front of the user
  const first = res.latest[0];
  const from = first?.participants[0];
  const title = res.newCount === 1 && from ? displayName(from) : `${res.newCount} new messages`;
  const body = res.newCount === 1 && first ? first.subject || '(no subject)' : res.latest.slice(0, 3).map((t) => t.subject).join(' · ');
  try {
    const n = new Notification(title, { body, icon: '/icons/icon-192.png', tag: 'cirrus-new-mail' });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* some mobile browsers only allow notifications from a service worker */
  }
}
