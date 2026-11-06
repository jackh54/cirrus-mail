import { lazy, Suspense, useEffect, useState } from 'react';
import { OPEN_PALETTE_EVENT } from './events';

const load = () => import('./CommandPalette');
const CommandPalette = lazy(() => load().then((m) => ({ default: m.CommandPalette })));

/** ⌘K / Ctrl+K opens the command palette. The palette itself is a small chunk warmed at idle. */
export function PaletteHost() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k' || e.isComposing) return;
      // Leave other modal dialogs alone; ⌘K again closes the palette.
      const otherDialog = document.querySelector('dialog[open]:not(.cm-palette)');
      if (otherDialog) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    const warm = () => void load();
    const idle = 'requestIdleCallback' in window ? requestIdleCallback(warm) : setTimeout(warm, 2000);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
      if ('cancelIdleCallback' in window) cancelIdleCallback(idle);
      else clearTimeout(idle);
    };
  }, []);

  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <CommandPalette onClose={() => setOpen(false)} />
    </Suspense>
  );
}
