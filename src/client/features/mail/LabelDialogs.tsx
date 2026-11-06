import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { LABEL_COLORS, LABEL_LIMITS, type Label, type LabelColor, type ThreadSummary } from '@shared/api';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Field, Input } from '../../components/Field';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useApplyLabels, useLabelMutations, useLabels } from '../../lib/queries/labels';
import { LABEL_COLOR_NAMES, LabelDot, labelHex } from './labelMeta';

/** Create, or rename and recolour, a label. */
export function LabelEditorDialog({ mailboxId, label, onClose }: { mailboxId: string; label: Label | null; onClose: () => void }) {
  const { create, update } = useLabelMutations(mailboxId);
  const labels = useLabels(mailboxId).data ?? [];
  const { toast } = useToast();
  const [name, setName] = useState(label?.name ?? '');
  const [color, setColor] = useState<LabelColor>(label?.color ?? LABEL_COLORS[labels.length % LABEL_COLORS.length]);
  const busy = create.isPending || update.isPending;
  const valid = name.trim().length > 0;

  const submit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    if (!valid || busy) return;
    const done = { onSuccess: onClose, onError: (err: unknown) => toast({ tone: 'error', title: 'Label not saved', description: errorMessage(err) }) };
    if (label) update.mutate({ id: label.id, name: name.trim(), color }, done);
    else create.mutate({ name: name.trim(), color }, done);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={label ? 'Edit label' : 'New label'}
      width={400}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={submit}>{label ? 'Save' : 'Create label'}</Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">{(id) => <Input id={id} value={name} maxLength={LABEL_LIMITS.maxName} placeholder="Receipts" onChange={(e) => setName(e.target.value)} />}</Field>
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium">Colour</legend>
          <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-2">
            {LABEL_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={LABEL_COLOR_NAMES[c]}
                title={LABEL_COLOR_NAMES[c]}
                onClick={() => setColor(c)}
                className={cn(
                  'flex size-8 items-center justify-center rounded-full border-2 pointer-coarse:size-11',
                  color === c ? 'border-fg' : 'border-transparent hover:border-border-strong',
                )}
              >
                <span className="size-5 rounded-full" style={{ backgroundColor: labelHex(c) }} />
              </button>
            ))}
          </div>
        </fieldset>
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}

function TriCheckbox({ state, label }: { state: 'all' | 'some' | 'none'; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return <input ref={ref} type="checkbox" tabIndex={-1} aria-label={label} checked={state === 'all'} readOnly className="pointer-events-none size-3.5 shrink-0" />;
}

interface PickerProps {
  mailboxId: string;
  threadIds: string[];
  /** Whatever of the targets is known to the client (the list or the open thread), to show which labels they carry. */
  threads: ThreadSummary[];
  onClose: () => void;
}

/**
 * Checkbox list of the mailbox's labels for the target threads. A tick means every target has the label, a dash
 * means some do. Toggling applies at once; "Create" adds a new label and puts it on the targets.
 */
export function LabelPicker({ mailboxId, threadIds, threads, onClose }: PickerProps) {
  const labels = useLabels(mailboxId);
  const apply = useApplyLabels(mailboxId);
  const { create } = useLabelMutations(mailboxId);
  const { toast } = useToast();
  const [name, setName] = useState('');
  const list = labels.data ?? [];
  const onError = (e: unknown) => toast({ tone: 'error', title: "Couldn't update labels", description: errorMessage(e) });

  const stateOf = (id: string): 'all' | 'some' | 'none' => {
    const have = threads.filter((t) => t.labels.includes(id)).length;
    return have === 0 ? 'none' : have === threadIds.length ? 'all' : 'some';
  };
  const toggle = (l: Label) => {
    const adding = stateOf(l.id) !== 'all';
    apply.mutate({ threadIds, [adding ? 'add' : 'remove']: [l.id] }, { onError });
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    create.mutate(
      { name: n, color: LABEL_COLORS[list.length % LABEL_COLORS.length] },
      {
        onSuccess: (l) => {
          setName('');
          apply.mutate({ threadIds, add: [l.id] }, { onError });
        },
        onError: (err) => toast({ tone: 'error', title: 'Label not created', description: errorMessage(err) }),
      },
    );
  };

  return (
    <Dialog open onClose={onClose} title="Label as" width={360} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="-mx-2">
        {labels.isPending ? (
          <p className="px-2 py-2 text-[13px] text-faint">Loading…</p>
        ) : list.length ? (
          <ul className="max-h-72 overflow-y-auto" role="group" aria-label="Labels">
            {list.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={stateOf(l.id) === 'all' ? true : stateOf(l.id) === 'some' ? 'mixed' : false}
                  onClick={() => toggle(l)}
                  className="flex h-9 w-full items-center gap-3 rounded-md px-2 text-left text-[13px] hover:bg-hover pointer-coarse:h-11 pointer-coarse:text-[15px]"
                >
                  <TriCheckbox state={stateOf(l.id)} label={l.name} />
                  <LabelDot color={l.color} />
                  <span className="min-w-0 flex-1 truncate">{l.name}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-2 py-2 text-[13px] text-faint">No labels yet. Create one below.</p>
        )}
      </div>
      <form onSubmit={add} className="mt-3 flex gap-2 border-t border-border pt-3">
        <Input aria-label="New label name" value={name} maxLength={LABEL_LIMITS.maxName} placeholder="Create label" onChange={(e) => setName(e.target.value)} />
        <Button type="submit" icon={<Plus size={14} />} disabled={!name.trim()} loading={create.isPending}>Create</Button>
      </form>
    </Dialog>
  );
}
