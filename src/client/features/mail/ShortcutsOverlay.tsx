import { useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { Kbd } from '../../components/Kbd';
import { SHORTCUTS, useHotkeys } from '../../lib/hotkeys';
import { MOD_KEY } from '../palette/events';

export const OPEN_SHORTCUTS_EVENT = 'cirrus:shortcuts';

/** "Shift+I" → "⇧I", "Mod+K" → "⌘K", single letters upper-cased to match the tooltips. */
function keyLabel(k: string): string {
  if (k.startsWith('Mod+')) return `${MOD_KEY}${k.slice(4)}`;
  if (k.startsWith('Shift+')) return `⇧${k.slice(6)}`;
  return k.length === 1 ? k.toUpperCase() : k;
}

/** The `?` sheet. Other components can open it by dispatching OPEN_SHORTCUTS_EVENT on window. */
export function ShortcutsOverlay() {
  const [open, setOpen] = useState(false);
  useHotkeys({ '?': () => setOpen(true) });
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(OPEN_SHORTCUTS_EVENT, on);
    return () => window.removeEventListener(OPEN_SHORTCUTS_EVENT, on);
  }, []);

  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts" width={440}>
      <ul className="-mt-1 divide-y divide-border">
        {SHORTCUTS.map((s) => (
          <li key={s.label} className="flex h-9 items-center justify-between gap-4 text-[13px]">
            <span className="text-fg">{s.label}</span>
            <span className="flex shrink-0 items-center gap-1">
              {s.keys.map((k) => <Kbd key={k}>{keyLabel(k)}</Kbd>)}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[12px] text-faint">Shortcuts pause while you type. Press {MOD_KEY}Enter to send from the composer.</p>
    </Dialog>
  );
}
