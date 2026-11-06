import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { Filter, FilterAction, FilterCondition, FilterField, FilterInput, FilterOp, Folder } from '@shared/api';
import { Button, IconButton } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Field, Input, Select } from '../../components/Field';

const FIELDS: { v: FilterField; label: string }[] = [
  { v: 'from', label: 'From' },
  { v: 'to', label: 'To' },
  { v: 'subject', label: 'Subject' },
  { v: 'list_id', label: 'Mailing list' },
  { v: 'has_attachment', label: 'Has attachment' },
];
const OPS: { v: FilterOp; label: string }[] = [
  { v: 'contains', label: 'contains' },
  { v: 'equals', label: 'is' },
  { v: 'ends_with', label: 'ends with' },
  { v: 'regex', label: 'matches regex' },
];
type ActionType = FilterAction['type'];
const ACTIONS: { v: ActionType; label: string }[] = [
  { v: 'move_to', label: 'Move to folder' },
  { v: 'mark_read', label: 'Mark as read' },
  { v: 'star', label: 'Star it' },
  { v: 'delete', label: 'Move to Trash' },
  { v: 'forward_to', label: 'Forward to' },
];

export function describeFilter(f: Filter, folders: Folder[]): string {
  const cond = f.conditions
    .map((c) => (c.field === 'has_attachment' ? 'has attachment' : `${FIELDS.find((x) => x.v === c.field)?.label.toLowerCase()} ${OPS.find((o) => o.v === c.op)?.label ?? c.op} "${c.value}"`))
    .join(f.match === 'all' ? ' and ' : ' or ');
  const acts = f.actions
    .map((a) => (a.type === 'move_to' ? `move to ${folders.find((x) => x.id === a.folderId)?.name ?? 'folder'}` : a.type === 'forward_to' ? `forward to ${a.email}` : ACTIONS.find((x) => x.v === a.type)?.label.toLowerCase()))
    .join(', ');
  return `If ${cond || '…'} → ${acts || '…'}`;
}

function makeAction(type: ActionType, folders: Folder[]): FilterAction {
  switch (type) {
    case 'move_to': return { type, folderId: folders.find((f) => !f.role)?.id ?? folders.find((f) => f.role === 'archive')?.id ?? '' };
    case 'forward_to': return { type, email: '' };
    default: return { type };
  }
}

function invalidRegex(c: FilterCondition): string | null {
  if (c.op !== 'regex') return null;
  if (c.value.length > 200) return 'Keep patterns under 200 characters';
  try {
    new RegExp(c.value);
    return null;
  } catch {
    return 'Not a valid regular expression';
  }
}

interface Props {
  initial: Filter | null;
  folders: Folder[];
  saving: boolean;
  onSave: (f: FilterInput) => void;
  onCancel: () => void;
}

export function FilterEditor({ initial, folders, saving, onSave, onCancel }: Props) {
  const [f, setF] = useState<FilterInput>(
    initial ?? { name: '', match: 'all', conditions: [{ field: 'from', op: 'contains', value: '' }], actions: [makeAction('move_to', folders)], enabled: true, sort: 0 },
  );
  const setCond = (i: number, c: Partial<FilterCondition>) => setF({ ...f, conditions: f.conditions.map((x, j) => (j === i ? { ...x, ...c } : x)) });
  const setAct = (i: number, a: FilterAction) => setF({ ...f, actions: f.actions.map((x, j) => (j === i ? a : x)) });
  const errors = f.conditions.map(invalidRegex);
  const valid =
    f.name.trim() &&
    f.conditions.length > 0 &&
    f.conditions.every((c) => c.field === 'has_attachment' || c.value.trim()) &&
    errors.every((e) => !e) &&
    f.actions.length > 0 &&
    f.actions.every((a) => (a.type === 'move_to' ? !!a.folderId : a.type === 'forward_to' ? /@/.test(a.email) : true));
  const movable = folders.filter((x) => x.role !== 'drafts' && x.role !== 'sent' && x.role !== 'scheduled');

  return (
    <Dialog
      open
      onClose={onCancel}
      title={initial ? 'Edit filter' : 'New filter'}
      width={620}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={saving} onClick={() => onSave({ ...f, name: f.name.trim() })}>Save filter</Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Name">{(id) => <Input id={id} autoFocus value={f.name} placeholder="Newsletters" onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <div>
          <div className="mb-2 flex items-center gap-2 text-[13px] font-medium">
            When
            <Select aria-label="Match" value={f.match} onChange={(e) => setF({ ...f, match: e.target.value === 'any' ? 'any' : 'all' })} className="h-8 w-auto">
              <option value="all">all</option>
              <option value="any">any</option>
            </Select>
            of these match
          </div>
          <ul className="space-y-2">
            {f.conditions.map((c, i) => (
              <li key={i} className="flex flex-wrap items-start gap-2">
                <Select aria-label="Field" value={c.field} className="w-40" onChange={(e) => {
                  const field = e.target.value as FilterField;
                  setCond(i, field === 'has_attachment' ? { field, op: 'is_true', value: '' } : { field, op: c.op === 'is_true' ? 'contains' : c.op });
                }}>
                  {FIELDS.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}
                </Select>
                {c.field !== 'has_attachment' && (
                  <>
                    <Select aria-label="Operator" value={c.op} className="w-36" onChange={(e) => setCond(i, { op: e.target.value as FilterOp })}>
                      {OPS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                    </Select>
                    <div className="min-w-40 flex-1">
                      <Input aria-label="Value" aria-invalid={!!errors[i]} value={c.value} className={c.op === 'regex' ? 'font-mono' : undefined} onChange={(e) => setCond(i, { value: e.target.value })} />
                      {errors[i] && <p className="mt-1 text-xs text-danger">{errors[i]}</p>}
                    </div>
                  </>
                )}
                <IconButton label="Remove condition" disabled={f.conditions.length === 1} onClick={() => setF({ ...f, conditions: f.conditions.filter((_, j) => j !== i) })}>
                  <X size={15} />
                </IconButton>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="ghost" className="mt-2" icon={<Plus size={13} />} onClick={() => setF({ ...f, conditions: [...f.conditions, { field: 'subject', op: 'contains', value: '' }] })}>
            Add condition
          </Button>
        </div>
        <div>
          <p className="mb-2 text-[13px] font-medium">Then</p>
          <ul className="space-y-2">
            {f.actions.map((a, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <Select aria-label="Action" value={a.type} className="w-44" onChange={(e) => setAct(i, makeAction(e.target.value as ActionType, folders))}>
                  {ACTIONS.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}
                </Select>
                {a.type === 'move_to' && (
                  <Select aria-label="Folder" value={a.folderId} className="min-w-40 flex-1" onChange={(e) => setAct(i, { type: 'move_to', folderId: e.target.value })}>
                    {movable.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </Select>
                )}
                {a.type === 'forward_to' && (
                  <Input aria-label="Forward to address" type="email" placeholder="Must be a verified Email Routing destination" value={a.email} className="min-w-40 flex-1" onChange={(e) => setAct(i, { type: 'forward_to', email: e.target.value })} />
                )}
                <IconButton label="Remove action" disabled={f.actions.length === 1} onClick={() => setF({ ...f, actions: f.actions.filter((_, j) => j !== i) })}>
                  <X size={15} />
                </IconButton>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="ghost" className="mt-2" icon={<Plus size={13} />} onClick={() => setF({ ...f, actions: [...f.actions, makeAction('mark_read', folders)] })}>
            Add action
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
