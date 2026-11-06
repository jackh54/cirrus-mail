import { lazy, Suspense, useEffect, useRef, type ReactNode, type RefObject } from 'react';
import type { ThreadSummary } from '@shared/api';

const VIRTUALIZE_OVER = 100;
const VirtualRows = lazy(() => import('./VirtualRows').then((m) => ({ default: m.VirtualRows })));

export interface RowsProps {
  threads: ThreadSummary[];
  scrollRef: RefObject<HTMLDivElement | null>;
  focusIndex: number;
  renderRow: (t: ThreadSummary, i: number) => ReactNode;
  hasMore: boolean;
  loadMore: () => void;
  /** Fixed row height in px (the virtualizer's estimate). */
  rowHeight: number;
  /** Phones: skip layout and paint for rows outside the viewport (content-visibility). */
  lazyPaint?: boolean;
}

/** Plain rendering for short lists, windowed rendering above 100 rows; infinite scroll either way. */
export function ThreadRows(props: RowsProps) {
  return (
    <>
      {props.threads.length > VIRTUALIZE_OVER ? (
        <Suspense fallback={<PlainRows {...props} threads={props.threads.slice(0, VIRTUALIZE_OVER)} />}>
          <VirtualRows {...props} />
        </Suspense>
      ) : (
        <PlainRows {...props} />
      )}
      <LoadMoreSentinel scrollRef={props.scrollRef} enabled={props.hasMore} onVisible={props.loadMore} />
    </>
  );
}

function PlainRows({ threads, renderRow, focusIndex, scrollRef, rowHeight, lazyPaint }: RowsProps) {
  useEffect(() => {
    scrollRef.current?.querySelector(`[data-index="${focusIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [focusIndex, scrollRef]);
  const style = lazyPaint ? { contentVisibility: 'auto' as const, containIntrinsicSize: `auto ${rowHeight}px` } : undefined;
  return <div role="list">{threads.map((t, i) => <div key={t.id} role="presentation" style={style}>{renderRow(t, i)}</div>)}</div>;
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
