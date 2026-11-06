import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Search } from 'lucide-react';
import { Kbd } from '../../components/Kbd';
import { cn } from '../../lib/cn';
import { bestScore } from './fuzzy';
import { useCommands, type Command, type Group } from './useCommands';

const GROUP_ORDER: Group[] = ['Search', 'Actions', 'Go to', 'Mailboxes', 'Settings', 'Admin'];

interface Section { group: Group; items: Command[] }

/** Score, filter and group commands. Groups follow their best match; with no query, a fixed order. */
function rank(commands: Command[], query: string): Section[] {
  const q = query.trim();
  const scored = commands
    .map((c) => ({ c, s: c.group === 'Search' ? 0 : bestScore(q, c.label, c.keywords) }))
    .filter((x): x is { c: Command; s: number } => x.s !== null);
  const groups = new Map<Group, { items: { c: Command; s: number }[]; best: number }>();
  for (const x of scored) {
    const g = groups.get(x.c.group) ?? { items: [], best: -Infinity };
    g.items.push(x);
    g.best = Math.max(g.best, x.s);
    groups.set(x.c.group, g);
  }
  // A strong command match outranks "Search mail for …"; otherwise search comes first.
  const strong = scored.some((x) => x.c.group !== 'Search' && x.s >= 600);
  const order = (g: Group, best: number) => (!q ? -GROUP_ORDER.indexOf(g) : g === 'Search' ? (strong ? -1 : 1e6) : best);
  return [...groups]
    .sort(([a, ga], [b, gb]) => order(b, gb.best) - order(a, ga.best))
    .map(([group, g]) => ({ group, items: (q ? [...g.items].sort((a, b) => b.s - a.s) : g.items).map((x) => x.c) }));
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const commands = useCommands(query);
  const sections = useMemo(() => rank(commands, query), [commands, query]);
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const id = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (el && !el.open) el.showModal();
    return () => {
      if (el?.open) el.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    const onCancel = (e: Event) => {
      e.preventDefault();
      onCloseRef.current();
    };
    el?.addEventListener('cancel', onCancel);
    return () => el?.removeEventListener('cancel', onCancel);
  }, []);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    // Run after the dialog has closed and returned focus, so the command can move focus itself.
    setTimeout(c.run, 0);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) setActive((i) => (flat.length ? (i + 1) % flat.length : 0));
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0));
    else if (e.key === 'Enter') run(flat[active]);
    else return;
    e.preventDefault();
  };

  let i = -1;
  return (
    <dialog
      ref={ref}
      className="cm-dialog cm-palette"
      style={{ ['--dialog-w' as string]: '600px' }}
      aria-label="Command menu"
      onMouseDown={(e) => {
        if (e.target === ref.current) onCloseRef.current();
      }}
    >
      <div className="flex h-12 items-center gap-2.5 border-b border-border px-4">
        <Search size={16} strokeWidth={1.75} className="shrink-0 text-faint" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a command or search mail"
          role="combobox"
          aria-expanded="true"
          aria-controls={id}
          aria-activedescendant={flat[active] ? `${id}-${flat[active].id}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-faint focus-visible:outline-none"
        />
        <Kbd>Esc</Kbd>
      </div>
      <div ref={list} id={id} role="listbox" aria-label="Commands" className="max-h-[min(400px,60dvh)] overflow-y-auto p-1.5">
        {!flat.length && <p className="px-3 py-6 text-center text-[13px] text-faint">No matching commands</p>}
        {sections.map((s) => (
          <div key={s.group} role="group" aria-label={s.group} className="pb-1">
            {s.group !== 'Search' && <div className="px-2.5 pt-2 pb-1 text-[12px] font-medium text-faint">{s.group}</div>}
            {s.items.map((c) => {
              i += 1;
              const idx = i;
              return (
                <div
                  key={c.id}
                  id={`${id}-${c.id}`}
                  role="option"
                  aria-selected={idx === active}
                  data-i={idx}
                  onMouseMove={() => idx !== active && setActive(idx)}
                  onClick={() => run(c)}
                  className={cn('flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px]', idx === active ? 'bg-hover text-fg' : 'text-fg')}
                >
                  <span className={cn('shrink-0 [&_svg]:size-4 [&_svg]:stroke-[1.75]', idx === active ? 'text-fg' : 'text-faint')}>{c.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.shortcut && <Kbd>{c.shortcut}</Kbd>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex h-9 items-center gap-4 border-t border-border px-4 text-[12px] text-faint">
        <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd> to navigate</span>
        <span className="flex items-center gap-1.5"><Kbd>↵</Kbd> to select</span>
      </div>
    </dialog>
  );
}
