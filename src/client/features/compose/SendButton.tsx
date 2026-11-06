import { useState } from 'react';
import { CalendarClock, ChevronDown, Send } from 'lucide-react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Field, Input } from '../../components/Field';
import { Menu, type MenuItem } from '../../components/Menu';
import { longDate } from '../../lib/format';

function at(base: Date, days: number, hour: number): number {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + days, hour, 0, 0, 0);
  return d.getTime();
}

function laterOptions(now = new Date()): { label: string; when: number }[] {
  const out: { label: string; when: number }[] = [];
  if (now.getHours() < 17 || (now.getHours() === 17 && now.getMinutes() < 30)) out.push({ label: 'Later today', when: at(now, 0, 18) });
  out.push({ label: 'Tomorrow morning', when: at(now, 1, 8) });
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  out.push({ label: 'Monday morning', when: at(now, toMonday, 8) });
  return out;
}

function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

/** Split Send button with the send-later menu. */
export function SendButton({ onSend, disabled, busy }: { onSend: (sendAt?: number) => void; disabled?: boolean; busy?: boolean }) {
  const [custom, setCustom] = useState(false);
  const [value, setValue] = useState(() => toLocalInput(Date.now() + 3_600_000));
  const when = new Date(value).getTime();
  const valid = Number.isFinite(when) && when > Date.now() + 60_000;

  const items: MenuItem[] = [
    { kind: 'heading', label: 'Send later' },
    ...laterOptions().map((o) => ({
      label: o.label,
      hint: new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(o.when),
      onSelect: () => onSend(o.when),
    })),
    { kind: 'separator' },
    { label: 'Pick date and time…', icon: <CalendarClock />, onSelect: () => setCustom(true) },
  ];

  return (
    <div className="inline-flex">
      <Button
        variant="primary"
        className="rounded-r-none pr-3"
        icon={<Send size={15} />}
        onClick={() => onSend()}
        disabled={disabled}
        loading={busy}
        title="Send (Ctrl+Enter)"
      >
        Send
      </Button>
      <Menu
        label="Send later"
        align="start"
        width={240}
        items={items}
        trigger={(p) => (
          <Button {...p} variant="primary" className="rounded-l-none border-l border-white/25 px-2" disabled={disabled} aria-label="Send later">
            <ChevronDown size={15} />
          </Button>
        )}
      />
      <Dialog
        open={custom}
        onClose={() => setCustom(false)}
        title="Schedule send"
        width={380}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCustom(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!valid}
              onClick={() => {
                setCustom(false);
                onSend(when);
              }}
            >
              Schedule
            </Button>
          </>
        }
      >
        <Field label="Deliver at" hint={valid ? longDate(when) : 'Pick a time at least a minute from now.'}>
          {(id, d) => (
            <Input id={id} aria-describedby={d} type="datetime-local" value={value} min={toLocalInput(Date.now())} onChange={(e) => setValue(e.target.value)} />
          )}
        </Field>
      </Dialog>
    </div>
  );
}
