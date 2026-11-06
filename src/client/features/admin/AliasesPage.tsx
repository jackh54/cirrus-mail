import { useState, type FormEvent } from 'react';
import { AtSign, Plus, Trash2 } from 'lucide-react';
import { Button, IconButton } from '../../components/Button';
import { useConfirm } from '../../components/Confirm';
import { EmptyState } from '../../components/EmptyState';
import { Input, Select } from '../../components/Field';
import { PageTitle, Section } from '../../components/PageShell';
import { Skeleton } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { isValidEmail, relativeAgo } from '../../lib/format';
import { useAdminAliases, useAdminMailboxes, useAliasMutations } from '../../lib/queries/admin';
import { Pill, Table } from './shared';

export function AliasesPage() {
  const aliases = useAdminAliases();
  const mailboxes = useAdminMailboxes();
  const { create, remove } = useAliasMutations();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [address, setAddress] = useState('');
  const [mailboxId, setMailboxId] = useState('');
  const [canSend, setCanSend] = useState(true);
  const target = mailboxId || mailboxes.data?.[0]?.id || '';

  const add = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { address: address.trim().toLowerCase(), mailboxId: target, canSend },
      {
        onSuccess: () => setAddress(''),
        onError: (err) => toast({ tone: 'error', title: 'Alias not added', description: errorMessage(err) }),
      },
    );
  };

  return (
    <>
      <PageTitle title="Aliases" description="Extra addresses that deliver into an existing mailbox." />
      <Section title="Add alias">
        <form onSubmit={add} className="flex flex-wrap items-center gap-2">
          <Input aria-label="Alias address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="sales@example.com" className="min-w-56 flex-1" />
          <span className="text-[13px] text-muted">delivers to</span>
          <Select aria-label="Mailbox" value={target} onChange={(e) => setMailboxId(e.target.value)} className="min-w-48 flex-1">
            {mailboxes.data?.map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}
          </Select>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={canSend} onChange={(e) => setCanSend(e.target.checked)} className="size-4" />
            Can send as
          </label>
          <Button type="submit" variant="primary" icon={<Plus size={15} />} loading={create.isPending} disabled={!isValidEmail(address) || !target}>Add</Button>
        </form>
      </Section>
      {aliases.isPending ? (
        <Skeleton className="h-32 rounded-[10px]" />
      ) : aliases.isError ? (
        <p className="text-[13px] text-danger">{errorMessage(aliases.error)}</p>
      ) : !aliases.data.length ? (
        <div className="rounded-[10px] border border-dashed border-border-strong">
          <EmptyState icon={<AtSign size={24} />} title="No aliases" body="Aliases like hello@ or billing@ can land in someone's mailbox without a separate login." />
        </div>
      ) : (
        <Table head={['Alias', 'Delivers to', 'Sending', 'Created', '']}>
          {aliases.data.map((a) => (
            <tr key={a.id}>
              <td className="font-medium">{a.address}</td>
              <td className="text-muted">{a.mailboxAddress}</td>
              <td>{a.canSend ? <Pill tone="success">Can send</Pill> : <Pill>Receive only</Pill>}</td>
              <td className="text-muted">{relativeAgo(a.createdAt)}</td>
              <td>
                <IconButton
                  label={`Delete ${a.address}`}
                  size="sm"
                  onClick={async () => {
                    if (await confirm({ title: `Delete ${a.address}?`, body: 'Mail to this address will be rejected unless a catch-all picks it up.', confirmLabel: 'Delete alias', danger: true }))
                      remove.mutate(a.id, { onError: (e) => toast({ tone: 'error', title: 'Not deleted', description: errorMessage(e) }) });
                  }}
                >
                  <Trash2 size={14} />
                </IconButton>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
