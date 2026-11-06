import { useState } from 'react';

interface Day { day: string; sent: number; received: number }

const W = 640;
const H = 220;
const PAD = { l: 32, r: 8, t: 12, b: 26 };

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = [1, 2, 2.5, 5, 10].find((k) => k * p >= v) ?? 10;
  return m * p;
}

/** Grouped bar chart (sent vs received) in plain SVG. */
export function DailyChart({ data }: { data: Day[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const days = data.slice(-14);
  const max = niceMax(Math.max(1, ...days.map((d) => Math.max(d.sent, d.received))));
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const slot = iw / Math.max(1, days.length);
  const bw = Math.min(14, (slot - 6) / 2);
  const y = (v: number) => PAD.t + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  const label = (s: string) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(new Date(`${s}T12:00:00`));

  if (!days.length) return <p className="text-[13px] text-faint">No data yet.</p>;

  return (
    <div>
      <div className="mb-3 flex items-center gap-4 text-[12px] text-muted">
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-[2px] bg-primary" /> Sent</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-[2px] bg-faint/50" /> Received</span>
        {hover !== null && days[hover] && (
          <span className="tnum ml-auto text-fg">
            {label(days[hover].day)}: {days[hover].sent} sent, {days[hover].received} received
          </span>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Messages sent and received per day over the last 14 days">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--c-border)" strokeDasharray={t ? '3 3' : undefined} />
            <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" fontSize="10" fill="var(--c-faint)">{t}</text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = PAD.l + i * slot + slot / 2;
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={PAD.l + i * slot} y={PAD.t} width={slot} height={ih} fill={hover === i ? 'var(--c-hover)' : 'transparent'} />
              <rect x={x - bw - 1} y={y(d.sent)} width={bw} height={Math.max(0, PAD.t + ih - y(d.sent))} rx={2} fill="var(--c-primary)">
                <title>{`${label(d.day)}: ${d.sent} sent`}</title>
              </rect>
              <rect x={x + 1} y={y(d.received)} width={bw} height={Math.max(0, PAD.t + ih - y(d.received))} rx={2} fill="var(--c-faint)" fillOpacity={0.45}>
                <title>{`${label(d.day)}: ${d.received} received`}</title>
              </rect>
              {(i % 2 === 0 || days.length <= 7) && (
                <text x={x} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--c-faint)">{label(d.day)}</text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
