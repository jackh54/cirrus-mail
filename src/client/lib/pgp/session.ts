import { useSyncExternalStore } from 'react';
import type { PrivateKey } from 'openpgp';
import { queryClient } from '../queryClient';

/**
 * The decrypted private key, for this tab only. It lives in this module's memory: never in localStorage,
 * sessionStorage, IndexedDB or any query cache. It is dropped by "Lock now", by a reload or closing the tab,
 * and when the query cache is cleared (sign-out, or a 401).
 */
export interface UnlockedKey { key: PrivateKey; fingerprint: string }

let current: UnlockedKey | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const getUnlocked = () => current;

export function setUnlocked(u: UnlockedKey): void {
  current = u;
  emit();
}

export function lockNow(): void {
  if (!current) return;
  current = null;
  emit();
}

export function useUnlocked(): UnlockedKey | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getUnlocked,
  );
}

queryClient.getQueryCache().subscribe((e) => {
  if (e.type === 'removed' && e.query.queryKey[0] === 'pgp') lockNow();
});
