import { useMemo } from 'react';
import { encodeQr, qrPath } from '../lib/qr';

/** QR code as crisp SVG. Always dark-on-white so scanners read it in dark mode too. */
export function QrCode({ value, size = 184, label }: { value: string; size?: number; label: string }) {
  const { d, dim } = useMemo(() => {
    const q = encodeQr(value);
    return { d: qrPath(q), dim: q.size + 8 };
  }, [value]);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${dim} ${dim}`} role="img" aria-label={label} shapeRendering="crispEdges" className="rounded-lg">
      <rect width={dim} height={dim} fill="#fff" />
      <path d={d} fill="#15171C" />
    </svg>
  );
}
