import { THREAD_CATEGORIES, type CategoryCounts, type ThreadCategory } from '@shared/api';
import { cn } from '../../lib/cn';
import { CATEGORY_LABELS } from './categoryTab';

interface Props {
  current: ThreadCategory;
  counts: CategoryCounts | undefined;
  onSelect: (c: ThreadCategory) => void;
}

/** Inbox tabs. Primary is the default; the others show how many conversations have unread mail. */
export function CategoryTabs({ current, counts, onSelect }: Props) {
  return (
    <div role="tablist" aria-label="Inbox tabs" className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-border px-2 [scrollbar-width:none]">
      {THREAD_CATEGORIES.map((c) => {
        const active = c === current;
        const unread = c === 'primary' ? 0 : (counts?.unread[c] ?? 0);
        return (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(c)}
            className={cn(
              'cm-hit relative flex h-9 shrink-0 items-center gap-1.5 px-2.5 text-[13px] whitespace-nowrap transition-colors duration-100',
              active ? 'font-medium text-fg' : 'text-muted hover:text-fg',
            )}
          >
            {CATEGORY_LABELS[c]}
            {unread > 0 && <span className="tnum rounded-full bg-primary-soft px-1.5 text-[11px] leading-4 font-medium text-selected-fg">{unread > 99 ? '99+' : unread}</span>}
            {active && <span aria-hidden="true" className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />}
          </button>
        );
      })}
    </div>
  );
}
