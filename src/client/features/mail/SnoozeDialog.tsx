import { useState } from 'react';
import { AlarmClock } from 'lucide-react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Input } from '../../components/Field';
import { fromLocalInput, snoozeLabel, snoozePresets, toLocalInput } from '../../lib/snooze';

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (at: number) => void;
}

/** Snooze presets in the browser's local time, plus a custom date and time. Sends epoch ms. */
export function SnoozeDialog({ open, onClose, onPick }: Props) {
  if (!open) return null;
  return <Inner onClose={onClose} onPick={onPick} />;
}

function Inner({ onClose, onPick }: Omit<Props, 'open'>) {
  const [now] = useState(() => new Date());
  const [custom, setCustom] = useState(() => toLocalInput(now.getTime() + 24 * 3600_000));
  const customAt = fromLocalInput(custom, now.getTime());
  const row = 'flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-3 text-left text-[14px] text-fg hover:bg-hover active:bg-hover';
  return (
    <Dialog open onClose={onClose} title="Snooze until…" width={360}>
      <ul className="-mx-3 -mt-2">
        {snoozePresets(now).map((p) => (
          <li key={p.id}>
            <button type="button" className={row} onClick={() => onPick(p.at)}>
              <span>{p.label}</span>
              <span className="text-[13px] text-muted">{snoozeLabel(p.at, now.getTime())}</span>
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-3 flex items-end gap-2 border-t border-border pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (customAt) onPick(customAt);
        }}
      >
        <label className="min-w-0 flex-1 text-[13px] font-medium">
          Pick date and time
          <Input type="datetime-local" value={custom} min={toLocalInput(now.getTime())} onChange={(e) => setCustom(e.target.value)} className="mt-1" />
        </label>
        <Button type="submit" variant="primary" icon={<AlarmClock size={14} />} disabled={!customAt}>Snooze</Button>
      </form>
    </Dialog>
  );
}
