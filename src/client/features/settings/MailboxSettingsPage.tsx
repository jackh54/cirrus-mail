import { useEffect, useId, useState } from 'react';
import type { MailboxSettings } from '@shared/api';
import { Button } from '../../components/Button';
import { Field, Input, Select, Switch, Textarea } from '../../components/Field';
import { PageTitle, Section } from '../../components/PageShell';
import { Skeleton } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { useMailboxSettings, useSaveMailboxSettings } from '../../lib/queries/settings';
import { useMeData } from '../../lib/queries/me';
import { getLastMailbox, setLastMailbox } from '../../lib/storage';
import { RichEditor } from '../compose/RichEditor';
import { BlockedSection } from './BlockedSection';
import { FiltersSection } from './FiltersSection';
import { MboxSection } from './MboxSection';

function toDateInput(ms: number | null): string {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fromDateInput(s: string, endOfDay: boolean): number | null {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime() : new Date(y, m - 1, d).getTime();
}

export function MailboxSettingsPage() {
  const { mailboxes } = useMeData();
  const [mb, setMb] = useState(() => (mailboxes.find((m) => m.id === getLastMailbox()) ?? mailboxes[0])?.id ?? '');
  const pickerId = useId();

  if (!mailboxes.length) {
    return <PageTitle title="Mailbox" description="You don't have access to a mailbox yet." />;
  }

  return (
    <>
      <PageTitle
        title="Mailbox"
        description="Settings for one mailbox. Shared mailboxes are shared with their other members."
        action={
          mailboxes.length > 1 && (
            <div className="flex items-center gap-2">
              <label htmlFor={pickerId} className="text-[13px] text-muted">Mailbox</label>
              <Select
                id={pickerId}
                value={mb}
                onChange={(e) => {
                  setMb(e.target.value);
                  setLastMailbox(e.target.value);
                }}
                className="w-64"
              >
                {mailboxes.map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}
              </Select>
            </div>
          )
        }
      />
      <SettingsForm key={mb} mb={mb} />
      <FiltersSection key={`f${mb}`} mb={mb} />
      <BlockedSection key={`b${mb}`} mb={mb} />
      <MboxSection key={`x${mb}`} mb={mb} />
    </>
  );
}

function SettingsForm({ mb }: { mb: string }) {
  const q = useMailboxSettings(mb);
  const save = useSaveMailboxSettings(mb);
  const { toast } = useToast();
  const [s, setS] = useState<MailboxSettings | null>(null);
  useEffect(() => {
    if (q.data && !s) setS(q.data);
  }, [q.data, s]);

  if (q.isPending || !s) {
    return q.isError ? <p className="mb-6 text-[13px] text-danger">{errorMessage(q.error)}</p> : <Skeleton className="mb-6 h-64 rounded-[10px]" />;
  }

  const submit = (label: string) =>
    save.mutate(s, {
      onSuccess: () => toast({ tone: 'success', title: `${label} saved` }),
      onError: (e) => toast({ tone: 'error', title: 'Not saved', description: errorMessage(e) }),
    });
  const ar = s.autoreply;
  const setAr = (patch: Partial<typeof ar>) => setS({ ...s, autoreply: { ...ar, ...patch } });
  const badRange = !!ar.start && !!ar.end && ar.end < ar.start;

  return (
    <>
      <Section title="Identity and signature" footer={<Button variant="primary" loading={save.isPending} onClick={() => submit('Signature')}>Save</Button>}>
        <Field label="Display name" hint="Shown as the sender name on mail you send from this mailbox." className="mb-5 sm:max-w-sm">
          {(id, d) => <Input id={id} aria-describedby={d} value={s.displayName} onChange={(e) => setS({ ...s, displayName: e.target.value })} />}
        </Field>
        <p className="mb-1.5 text-[13px] font-medium">Signature</p>
        <div className="overflow-hidden rounded-md border border-border focus-within:border-primary focus-within:ring-3 focus-within:ring-ring/30">
          <RichEditor
            initialHtml={s.signatureHtml}
            onChange={(html) => setS((cur) => (cur ? { ...cur, signatureHtml: html } : cur))}
            placeholder="Your name, title, phone…"
            toolbarPosition="top"
            className="[&_.cm-prose]:min-h-24 [&_[role=toolbar]]:border-b [&_[role=toolbar]]:border-border"
          />
        </div>
        <p className="mt-1.5 text-[12px] text-muted">Added to new messages, replies and forwards.</p>
      </Section>

      <Section
        title="Vacation auto-reply"
        description="Replies once every 4 days per sender. Mailing lists and automated mail never get a reply."
        footer={<Button variant="primary" loading={save.isPending} disabled={badRange} onClick={() => submit('Auto-reply')}>Save</Button>}
      >
        <div className="mb-4 flex items-center gap-3">
          <Switch checked={ar.enabled} onChange={(enabled) => setAr({ enabled })} label="Auto-reply enabled" />
          <span className="text-[13px]">{ar.enabled ? 'On' : 'Off'}</span>
        </div>
        <fieldset disabled={!ar.enabled} className="space-y-4 disabled:opacity-60">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First day" hint="Optional">
              {(id, d) => <Input id={id} aria-describedby={d} type="date" value={toDateInput(ar.start)} onChange={(e) => setAr({ start: fromDateInput(e.target.value, false) })} />}
            </Field>
            <Field label="Last day" hint={badRange ? undefined : 'Optional'} error={badRange ? 'Ends before it starts' : null}>
              {(id, d) => <Input id={id} aria-describedby={d} aria-invalid={badRange} type="date" value={toDateInput(ar.end)} onChange={(e) => setAr({ end: fromDateInput(e.target.value, true) })} />}
            </Field>
          </div>
          <Field label="Subject">
            {(id) => <Input id={id} value={ar.subject} placeholder="Out of office" onChange={(e) => setAr({ subject: e.target.value })} />}
          </Field>
          <Field label="Message">
            {(id) => <Textarea id={id} rows={5} value={ar.body} placeholder="Thanks for your email. I'm away until…" onChange={(e) => setAr({ body: e.target.value })} />}
          </Field>
        </fieldset>
      </Section>
    </>
  );
}
