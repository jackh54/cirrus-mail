import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { ContactField, ContactInput } from '@shared/api';
import { Button, IconButton } from '../../components/Button';
import { Field, Input, Select, Textarea } from '../../components/Field';

const EMAIL_TYPES = ['home', 'work', 'other'];
const PHONE_TYPES = ['cell', 'home', 'work', 'other'];
const LABELS: Record<string, string> = { cell: 'Mobile', home: 'Home', work: 'Work', other: 'Other' };

/** The label shown for a field's types: the first one we know, else the first one, else nothing. */
export function typeLabel(types: string[], known: string[]): string {
  const t = types.map((x) => x.toLowerCase()).find((x) => known.includes(x)) ?? '';
  return t ? LABELS[t] : '';
}
export const emailTypeLabel = (t: string[]) => typeLabel(t, EMAIL_TYPES);
export const phoneTypeLabel = (t: string[]) => typeLabel(t, PHONE_TYPES);

interface Props {
  initial: ContactInput;
  saving: boolean;
  submitLabel: string;
  onSubmit: (c: ContactInput) => void;
  onCancel: () => void;
}

export function ContactForm({ initial, saving, submitLabel, onSubmit, onCancel }: Props) {
  const [fn, setFn] = useState(initial.fn);
  const [org, setOrg] = useState(initial.org);
  const [note, setNote] = useState(initial.note);
  const [emails, setEmails] = useState<ContactField[]>(initial.emails);
  const [phones, setPhones] = useState<ContactField[]>(initial.phones);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = (xs: ContactField[]) => xs.map((x) => ({ ...x, value: x.value.trim() })).filter((x) => x.value);
    const name = fn.trim() || clean(emails)[0]?.value || '';
    if (!name) {
      setError('Add a name or an email address');
      return;
    }
    onSubmit({ ...initial, fn: name, org: org.trim(), note, emails: clean(emails), phones: clean(phones) });
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <Field label="Name" error={error}>
        {(id, d) => <Input id={id} aria-describedby={d} aria-invalid={!!error} value={fn} onChange={(e) => { setFn(e.target.value); setError(null); }} maxLength={200} autoFocus />}
      </Field>
      <Field label="Company">{(id) => <Input id={id} value={org} onChange={(e) => setOrg(e.target.value)} maxLength={200} />}</Field>
      <Rows legend="Email" known={EMAIL_TYPES} type="email" rows={emails} onChange={setEmails} />
      <Rows legend="Phone" known={PHONE_TYPES} type="tel" rows={phones} onChange={setPhones} />
      <Field label="Notes">{(id) => <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} maxLength={10_000} />}</Field>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" loading={saving}>{submitLabel}</Button>
      </div>
    </form>
  );
}

function Rows({ legend, known, type, rows, onChange }: { legend: string; known: string[]; type: 'email' | 'tel'; rows: ContactField[]; onChange: (r: ContactField[]) => void }) {
  const set = (i: number, patch: Partial<ContactField>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setType = (i: number, t: string) => set(i, { types: [t, ...rows[i].types.filter((x) => !known.includes(x.toLowerCase()))].filter(Boolean) });
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 text-[13px] leading-5 font-medium text-fg">{legend}</legend>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <Select
            aria-label={`${legend} ${i + 1} type`}
            className="w-28 shrink-0"
            value={r.types.map((x) => x.toLowerCase()).find((x) => known.includes(x)) ?? ''}
            onChange={(e) => setType(i, e.target.value)}
          >
            <option value="">Type</option>
            {known.map((k) => <option key={k} value={k}>{LABELS[k]}</option>)}
          </Select>
          <Input aria-label={`${legend} ${i + 1}`} type={type} value={r.value} onChange={(e) => set(i, { value: e.target.value })} maxLength={type === 'email' ? 254 : 64} />
          <IconButton label={`Remove ${legend.toLowerCase()} ${i + 1}`} noTip onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <X size={16} />
          </IconButton>
        </div>
      ))}
      {rows.length < 20 && (
        <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => onChange([...rows, { value: '', types: [] }])}>
          Add {legend.toLowerCase()}
        </Button>
      )}
    </fieldset>
  );
}
