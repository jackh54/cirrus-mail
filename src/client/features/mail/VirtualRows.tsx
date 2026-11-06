import { useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { RowsProps } from './ThreadRows';

/** Windowed rendering for long lists. Its own chunk: most folders never reach the threshold. */
export function VirtualRows({ threads, renderRow, focusIndex, scrollRef, rowHeight }: RowsProps) {
  const v = useVirtualizer({
    count: threads.length,
    getScrollElement: () => scrollRef.current,
    // Rows have fixed heights, so the estimate is exact and nothing shifts while scrolling.
    estimateSize: () => rowHeight,
    overscan: 10,
    getItemKey: (i) => threads[i]?.id ?? i,
  });
  // Density or layout changed the fixed height: drop the cached sizes.
  useEffect(() => v.measure(), [rowHeight, v]);
  useEffect(() => {
    if (focusIndex >= 0) v.scrollToIndex(focusIndex, { align: 'auto' });
  }, [focusIndex, v]);
  return (
    <div role="list" style={{ height: v.getTotalSize(), position: 'relative' }}>
      {v.getVirtualItems().map((item) => (
        <div
          key={item.key}
          role="presentation"
          data-index={item.index}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${item.start}px)` }}
        >
          {renderRow(threads[item.index], item.index)}
        </div>
      ))}
    </div>
  );
}
