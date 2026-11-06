import { useMemo } from 'react';
import type { Label, LabelColor } from '@shared/api';
import { cn } from '../../lib/cn';
import { useLabels } from '../../lib/queries/labels';
import { useMailRoute } from './useMailRoute';

/** Window event: open the label picker for the selection, the open conversation or the focused row. */
export const OPEN_LABEL_PICKER_EVENT = 'cirrus:labels';

/** The fixed palette (names are API values). Mid-tone hues that read on both the light and the graphite theme. */
export const LABEL_HEX: Record<LabelColor, string> = {
  cobalt: '#2b63e8',
  sky: '#2f9fd8',
  teal: '#12988f',
  green: '#1a8f5c',
  amber: '#cf8f00',
  orange: '#e0702b',
  red: '#d03a3a',
  pink: '#d6478f',
  violet: '#7c5ce0',
  graphite: '#6b7080',
};

export const LABEL_COLOR_NAMES: Record<LabelColor, string> = {
  cobalt: 'Cobalt', sky: 'Sky', teal: 'Teal', green: 'Green', amber: 'Amber', orange: 'Orange', red: 'Red', pink: 'Pink', violet: 'Violet', graphite: 'Graphite',
};

export function labelHex(color: string): string {
  return LABEL_HEX[color as LabelColor] ?? LABEL_HEX.graphite;
}

export function LabelDot({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden="true" className={cn('inline-block size-2.5 shrink-0 rounded-full', className)} style={{ backgroundColor: labelHex(color) }} />;
}

/** Small tinted pill: the label colour at low opacity behind text mixed toward the foreground, so it works in both themes. */
export function LabelChip({ label, className }: { label: Pick<Label, 'name' | 'color'>; className?: string }) {
  const hex = labelHex(label.color);
  return (
    <span
      className={cn('inline-flex h-4 max-w-28 min-w-0 shrink-0 items-center rounded px-1.5 text-[11px] leading-none font-medium', className)}
      style={{ backgroundColor: `color-mix(in oklab, ${hex} 16%, transparent)`, color: `color-mix(in oklab, ${hex} 72%, var(--c-fg))` }}
      title={label.name}
    >
      <span className="truncate">{label.name}</span>
    </span>
  );
}

/** The labels a thread carries, in the mailbox's label order. Unknown ids (just deleted) are skipped. */
export function useThreadLabels(ids: string[]): Label[] {
  const { mailboxId } = useMailRoute();
  const labels = useLabels(mailboxId).data;
  return useMemo(() => (labels && ids.length ? labels.filter((l) => ids.includes(l.id)) : []), [labels, ids]);
}

/** Chips on a thread row: at most `max`, then a "+N". Mounted only for threads that have labels. */
export function RowLabels({ ids, max = 2, className }: { ids: string[]; max?: number; className?: string }) {
  const labels = useThreadLabels(ids);
  if (!labels.length) return null;
  return (
    <span className={cn('flex shrink-0 items-center gap-1', className)}>
      {labels.slice(0, max).map((l) => <LabelChip key={l.id} label={l} />)}
      {labels.length > max && <span className="tnum text-[11px] text-faint">+{labels.length - max}</span>}
    </span>
  );
}

/** All of a thread's labels, wrapping, for the reader header. */
export function ReaderLabels({ ids }: { ids: string[] }) {
  const labels = useThreadLabels(ids);
  if (!labels.length) return null;
  return (
    <ul className="mb-3 flex flex-wrap gap-1.5" aria-label="Labels">
      {labels.map((l) => <li key={l.id}><LabelChip label={l} className="h-5 max-w-48 text-[12px]" /></li>)}
    </ul>
  );
}
