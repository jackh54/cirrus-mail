import { useCallback, useSyncExternalStore } from 'react';
import { useParams, useSearchParams } from 'react-router';

export function useMailRoute() {
  const { mailboxId = '', folder = 'inbox', threadId } = useParams();
  const [sp] = useSearchParams();
  const q = folder === 'search' ? (sp.get('q') ?? '') : '';
  const qs = q ? `?q=${encodeURIComponent(q)}` : '';
  const base = `/mail/${mailboxId}/${folder}`;
  const threadUrl = useCallback((id: string) => `${base}/${id}${qs}`, [base, qs]);
  return { mailboxId, folder, threadId, q, listUrl: `${base}${qs}`, threadUrl };
}

export function useMediaQuery(query: string): boolean {
  const get = () => typeof matchMedia === 'function' && matchMedia(query).matches;
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    get,
    () => false,
  );
}

/** Layout modes: mobile < 768 px, medium (rail + one pane) < 1200 px, wide (three panes). */
export function useLayoutMode(): 'mobile' | 'medium' | 'wide' {
  const md = useMediaQuery('(min-width: 768px)');
  const xl = useMediaQuery('(min-width: 1200px)');
  return xl ? 'wide' : md ? 'medium' : 'mobile';
}
