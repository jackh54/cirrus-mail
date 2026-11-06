import { useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { Kbd } from '../../components/Kbd';
import { SHORTCUTS, useHotkeys } from '../../lib/hotkeys';

export const OPEN_SHORTCUTS_EVENT = 'cirrus:shortcuts';

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
    <Dialog open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts" width={460}>
      <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-1">
        {SHORTCUTS.map((s) => (
          <li key={s.label} className="flex items-center justify-between gap-4 text-sm">
            <span className="text-fg">{s.label}</span>
            <span className="flex shrink-0 items-center gap-1">
              {s.keys.map((k, i) => (
                <span key={k} className="flex items-center gap-1">
                  {i > 0 && <span className="text-xs text-faint">/</span>}
                  <Kbd>{k}</Kbd>
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-faint">Shortcuts are paused while you type. Press Ctrl/⌘ + Enter to send from the composer.</p>
    </Dialog>
  );
}
