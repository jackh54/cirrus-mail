import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ThreadSummary } from '@shared/api';
import { currentDensity } from '../../lib/theme';

const VIRTUALIZE_OVER = 100;

interface Props {
  threads: ThreadSummary[];
  scrollRef: RefObject<HTMLDivElement | null>;
  focusIndex: number;
  renderRow: (t: ThreadSummary, i: number) => ReactNode;
  hasMore: boolean;
  loadMore: () => void;
}

/** Plain rendering for short lists, windowed rendering above 100 rows; infinite scroll either way. */
export function ThreadRows(props: Props) {
  return (
    <>
      {props.threads.length > VIRTUALIZE_OVER ? <VirtualRows {...props} /> : <PlainRows {...props} />}
      <LoadMoreSentinel scrollRef={props.scrollRef} enabled={props.hasMore} onVisible={props.loadMore} />
    </>
  );
}

function PlainRows({ threads, renderRow, focusIndex, scrollRef }: Props) {
  useEffect(() => {
    scrollRef.current?.querySelector(`[data-index="${focusIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [focusIndex, scrollRef]);
  return <div role="list">{threads.map((t, i) => <div key={t.id} role="presentation">{renderRow(t, i)}</div>)}</div>;
}

function VirtualRows({ threads, renderRow, focusIndex, scrollRef }: Props) {
  const v = useVirtualizer({
    count: threads.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (currentDensity() === 'compact' ? 50 : 78),
    overscan: 10,
    getItemKey: (i) => threads[i]?.id ?? i,
  });
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
          ref={v.measureElement}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${item.start}px)` }}
        >
          {renderRow(threads[item.index], item.index)}
        </div>
      ))}
    </div>
  );
}

function LoadMoreSentinel({ scrollRef, enabled, onVisible }: { scrollRef: RefObject<HTMLDivElement | null>; enabled: boolean; onVisible: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onVisible);
  cb.current = onVisible;
  useEffect(() => {
    if (!enabled || !ref.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && cb.current(), {
      root: scrollRef.current,
      rootMargin: '600px 0px',
    });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [enabled, scrollRef]);
  return <div ref={ref} aria-hidden="true" className="h-px" />;
}
