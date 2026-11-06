import { useSyncExternalStore } from 'react';
import { THREAD_CATEGORIES, type ThreadCategory } from '@shared/api';

export const CATEGORY_LABELS: Record<ThreadCategory, string> = {
  primary: 'Primary', updates: 'Updates', promotions: 'Promotions', social: 'Social', forums: 'Forums',
};

// The Inbox tab in view. Shared (not component state) so the command palette can switch it.
let current: ThreadCategory = 'primary';
const listeners = new Set<() => void>();

export function setCategoryTab(c: ThreadCategory): void {
  if (!THREAD_CATEGORIES.includes(c) || c === current) return;
  current = c;
  listeners.forEach((l) => l());
}

export function useCategoryTab(): ThreadCategory {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => 'primary',
  );
}
