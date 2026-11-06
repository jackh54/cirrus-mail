// Side-by-side layout of overlapping timed events within one day column.

export interface Block { id: string; /** Minutes from the top of the day. */ start: number; end: number }
export interface Placed { id: string; start: number; end: number; /** Zero-based column within its cluster. */ col: number; /** Columns in its cluster. */ cols: number }

/**
 * Groups events that overlap into clusters, puts each event in the first free column, and gives every event
 * in a cluster the same column count so they share the width evenly.
 */
export function layoutColumns(blocks: Block[]): Placed[] {
  const sorted = [...blocks].sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
  const out: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterEnd = -Infinity;
  const colEnds: number[] = [];

  const flush = () => {
    for (const p of cluster) p.cols = colEnds.length;
    out.push(...cluster);
    cluster = [];
    colEnds.length = 0;
    clusterEnd = -Infinity;
  };

  for (const b of sorted) {
    if (b.start >= clusterEnd) flush();
    let col = colEnds.findIndex((end) => end <= b.start);
    if (col === -1) col = colEnds.length;
    colEnds[col] = b.end;
    cluster.push({ ...b, col, cols: 1 });
    clusterEnd = Math.max(clusterEnd, b.end);
  }
  flush();
  return out;
}

/** Minutes snapped to the nearest `step`, kept inside the day. */
export const snapMinutes = (m: number, step = 15): number => Math.min(24 * 60 - step, Math.max(0, Math.round(m / step) * step));
