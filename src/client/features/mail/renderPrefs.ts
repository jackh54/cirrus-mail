import { useSyncExternalStore } from 'react';

/**
 * Per-message HTML rendering state shared by the message header (toggle) and HtmlBody (renderer).
 * In memory only: `designed` is published by HtmlBody after sanitising; `override` is the user's
 * choice from the header toggle. Neither survives a reload.
 */
export interface RenderPref {
  designed?: boolean;
  override?: 'dark' | 'original';
}

const prefs = new Map<string, RenderPref>();
const listeners = new Set<() => void>();
const EMPTY: RenderPref = {};

function set(id: string, patch: RenderPref): void {
  const prev = prefs.get(id) ?? EMPTY;
  if (Object.entries(patch).every(([k, v]) => prev[k as keyof RenderPref] === v)) return;
  prefs.set(id, { ...prev, ...patch });
  listeners.forEach((fn) => fn());
}

export function setDesigned(id: string, designed: boolean): void {
  set(id, { designed });
}

export function setOverride(id: string, override: 'dark' | 'original'): void {
  set(id, { override });
}

export function useRenderPref(id: string): RenderPref {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => prefs.get(id) ?? EMPTY,
    () => EMPTY,
  );
}

/** Dark rendering is the default for simple mail; designed mail keeps its original look unless toggled. */
export function wantsDark(p: RenderPref, designed: boolean): boolean {
  return p.override ? p.override === 'dark' : !designed;
}
