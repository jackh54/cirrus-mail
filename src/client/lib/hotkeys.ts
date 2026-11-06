import { useEffect, useRef } from 'react';

export type HotkeyMap = Partial<Record<string, (e: KeyboardEvent) => void>>;

/** True when the user is typing somewhere, or a modal dialog is open. */
export function isTypingContext(target: EventTarget | null): boolean {
  if (document.querySelector('dialog[open]')) return true;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('[data-hotkeys="off"]')) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(type);
  }
  return !!target.closest('[contenteditable="true"], [role="menu"]');
}

/**
 * Single-key shortcuts keyed by `KeyboardEvent.key` ("c", "#", "?", "I" for Shift+I, "Enter").
 * Ignored with Ctrl/Meta/Alt, while typing and while a dialog is open.
 */
export function useHotkeys(map: HotkeyMap, enabled = true): void {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (isTypingContext(e.target)) return;
      // Enter must keep activating focused buttons and links.
      if (e.key === 'Enter' && e.target instanceof HTMLElement && e.target !== document.body && e.target.closest('button, a, [role="button"], summary, [tabindex="0"]')) return;
      const fn = ref.current[e.key];
      if (!fn) return;
      e.preventDefault();
      fn(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/** `Mod` renders as ⌘ on Apple platforms and Ctrl elsewhere. */
export const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['Mod+K'], label: 'Command menu' },
  { keys: ['c'], label: 'Compose' },
  { keys: ['/'], label: 'Search' },
  { keys: ['j', 'k'], label: 'Next / previous conversation' },
  { keys: ['o', 'Enter'], label: 'Open conversation' },
  { keys: ['u'], label: 'Back to list' },
  { keys: ['e'], label: 'Archive' },
  { keys: ['#'], label: 'Move to Trash' },
  { keys: ['s'], label: 'Star / unstar' },
  { keys: ['l'], label: 'Label as…' },
  { keys: ['r'], label: 'Reply' },
  { keys: ['a'], label: 'Reply all' },
  { keys: ['f'], label: 'Forward' },
  { keys: ['Shift+I'], label: 'Mark as read' },
  { keys: ['Shift+U'], label: 'Mark as unread' },
  { keys: ['?'], label: 'Show this sheet' },
];
